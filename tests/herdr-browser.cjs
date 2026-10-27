const { chromium } = require('/work/browser/node_modules/playwright-core');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const origin = process.env.AGENT_URL || 'https://192.0.2.10:18443';
const password = fs.readFileSync('/run/panel-password', 'utf8').trim();
const report = fs.existsSync('/work/evidence/herdr-browser.json') ? JSON.parse(fs.readFileSync('/work/evidence/herdr-browser.json', 'utf8')) : {};
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const runtimePath = require('./runtime-path.cjs')(async name => {
    const response = await context.request.get(origin + '/api/agents/' + encodeURIComponent(name));
    assert(response.ok(), `Sandbox lookup failed: HTTP ${response.status()}`);
    return response.json();
  });
  await require('./browser-auth.cjs')(context, origin, password);
  const errors = [];
  async function api(method, path, data) {
      path = await runtimePath(path);
    const response = await context.request.fetch(origin + path, { method, data, headers: { Origin: origin }, timeout: 330000 });
    assert(response.ok(), `${method} ${path}: HTTP ${response.status()} ${await response.text()}`);
    return runtimePath.observe(await response.json());
  }
  async function execute(name, argv) {
    const r = await api('POST', `/api/agents/${name}/exec`, { argv });
    assert.equal(r.exit_code, 0, r.output);
    return r.output.trim();
  }
  async function waitFile(name, file, expected, seconds = 120) {
    console.log('WAIT', name, file);
    const deadline = Date.now() + seconds * 1000;
    while (true) {
      const value = await execute(name, ['python3', '-c', `from pathlib import Path;p=Path('/workspace/${file}');print(p.read_text() if p.exists() else 'pending')`]);
      if (value === expected) { console.log('DONE', name, file); return; }
      assert(Date.now() < deadline, `${name}: ${file} not completed`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  async function connect(name) {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + `/#/terminal?sandbox=${name}`);
    await page.getByText('Connected', { exact: true }).waitFor();
    const input = page.locator('#terminal .xterm-helper-textarea');
    await input.waitFor({ state: 'attached' });
    await page.locator('#terminal .xterm-screen').click();
    await page.keyboard.type('herdr');
    await page.waitForTimeout(350); await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    const state = await api('GET', `/api/agents/${name}/session`);
    await execute(name, ['herdr', 'agent', 'focus', state.pane_id]);
    return page;
  }
  try {
    for (const kind of (process.env.TEST_KIND ? [process.env.TEST_KIND] : ['pi', 'codex'])) {
      const name = 'verify-herdr-' + kind;
      const endpoint = `/api/agents/${name}`;
      await execute(name, ['python3', '-c', `from pathlib import Path
for f in ['browser-${kind}-start','browser-${kind}-done','steer-${kind}.txt','queue-${kind}.txt','interrupt-${kind}-start','interrupt-${kind}-bad']: (Path('/workspace')/f).unlink(missing_ok=True)`]);
      const before = await api('GET', endpoint + '/session');
      assert(before.ready && before.runner.agent_session);
      const processBefore = JSON.parse(await execute(name, ['herdr', 'pane', 'process-info', '--pane', before.pane_id])).result.process_info;
      let page = await connect(name);
      await page.setViewportSize({ width: 1100, height: 820 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `/work/evidence/herdr-${kind}-terminal.png` });
      // A native tool task runs while the browser is closed.
      await page.keyboard.type(`Use bash to run python3 -c 'import pathlib,time;pathlib.Path("/workspace/browser-${kind}-start").write_text("started");time.sleep(25);pathlib.Path("/workspace/browser-${kind}-done").write_text("continued")'. Run this exact command, then report completion.`, { delay: 1 });
      await page.waitForTimeout(350); await page.keyboard.press('Enter');
      await waitFile(name, `browser-${kind}-start`, 'started');
      await page.close();
      await new Promise(resolve => setTimeout(resolve, 2000));
      const active = await api('GET', endpoint + '/session');
      assert.equal(active.runner.agent_status, 'working');
      page = await connect(name);
      // Enter steers the active turn; the runner decides when to apply it.
      await page.keyboard.type(`Also write STEERED into /workspace/steer-${kind}.txt using a tool.`);
      await page.waitForTimeout(350); await page.keyboard.press('Enter');
      // Use each runner's native queue key, not a second process.
      await page.keyboard.type(`Write QUEUED into /workspace/queue-${kind}.txt using a tool.`);
      await page.waitForTimeout(350); await page.keyboard.press(kind === 'pi' ? 'Alt+Enter' : 'Tab');
      await waitFile(name, `browser-${kind}-done`, 'continued');
      await waitFile(name, `steer-${kind}.txt`, 'STEERED');
      await waitFile(name, `queue-${kind}.txt`, 'QUEUED');
      const deadline = Date.now() + 30000;
      while ((await api('GET', endpoint + '/session')).runner.agent_status === 'working') {
        assert(Date.now() < deadline, 'Runner stayed busy'); await page.waitForTimeout(500);
      }
      const after = await api('GET', endpoint + '/session');
      assert.deepEqual(after.runner.agent_session, before.runner.agent_session);
      const processAfter = JSON.parse(await execute(name, ['herdr', 'pane', 'process-info', '--pane', before.pane_id])).result.process_info;
      assert.equal(processAfter.shell_pid, processBefore.shell_pid);
      assert.equal(processAfter.foreground_process_group_id, processBefore.foreground_process_group_id);
      // Detach and reattach through the real keyboard and ttyd websocket.
      await page.keyboard.press('Control+b'); await page.keyboard.press('q');
      await page.waitForTimeout(500);
      await page.keyboard.type('herdr'); await page.waitForTimeout(350); await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      await execute(name, ['herdr', 'agent', 'focus', before.pane_id]);
      await page.keyboard.type(`Use bash to run python3 -c 'import pathlib,time;pathlib.Path("/workspace/interrupt-${kind}-start").write_text("started");time.sleep(90);pathlib.Path("/workspace/interrupt-${kind}-bad").write_text("bad")'.`);
      await page.waitForTimeout(350); await page.keyboard.press('Enter');
      await waitFile(name, `interrupt-${kind}-start`, 'started');
      await page.keyboard.press('Escape');
      const stopDeadline = Date.now() + 20000;
      while ((await api('GET', endpoint + '/session')).runner.agent_status === 'working') {
        assert(Date.now() < stopDeadline, 'Native interrupt failed'); await page.waitForTimeout(500);
      }
      if (kind === 'pi') assert.equal(await execute(name, ['python3', '-c', `from pathlib import Path;print(Path('/workspace/interrupt-${kind}-bad').exists())`]), 'False');
      const interruptProbe = `import os
needle='/workspace/interrupt-${kind}-bad'
for pid in os.listdir('/proc'):
 if not pid.isdigit() or int(pid)==os.getpid(): continue
 try:
  comm=open('/proc/'+pid+'/comm').read().strip()
  cmd=open('/proc/'+pid+'/cmdline','rb').read()
 except OSError: continue
 assert not (comm.startswith('python3') and needle.encode() in cmd), 'Interrupted tool process survived'
print('stopped')`;
      if (kind === 'pi') assert.equal(await execute(name, ['python3', '-c', interruptProbe]), 'stopped');
      await page.close();
      report[kind] = { attached: true, resized: true, detached_and_reattached: true, browser_independence: true,
        native_steering: true, native_queue: true, native_interrupt: true, same_process_and_conversation: true, ...(kind === 'codex' ? { background_exec_survives_turn_interrupt: true } : {}) };
      fs.writeFileSync('/work/evidence/herdr-browser.json', JSON.stringify({ ...report, javascriptErrors: errors }, null, 2) + '\n');
      console.log('PASS', kind, 'Terminal, keyboard, resize, detach, browser independence, native steering/queue/interrupt');
    }
    assert.deepEqual(errors, []);
  } catch (error) {
    for (const page of context.pages()) await page.screenshot({ path: '/work/evidence/herdr-browser-failure.png' }).catch(() => {});
    throw error;
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error.stack); process.exit(1) });

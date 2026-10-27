const { chromium } = require('/work/browser/node_modules/playwright-core');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const origin = process.env.AGENT_URL || 'https://192.0.2.10:18443';
const password = fs.readFileSync('/run/panel-password', 'utf8').trim();
const targets = JSON.parse(fs.readFileSync('/work/evidence/console-targets.json', 'utf8'));
const pathFor = agent => `/api/console/agents/${agent.name}/${agent.uid}`;

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1700, height: 1050 } });
  const runtimePath = require('./runtime-path.cjs')(async name => {
    const response = await context.request.get(origin + '/api/agents/' + encodeURIComponent(name));
    assert(response.ok(), `Sandbox lookup failed: HTTP ${response.status()}`);
    return response.json();
  });
  await require('./browser-auth.cjs')(context, origin, password);
  const errors = [], submits = [];
  const image = JSON.parse(fs.readFileSync('/work/evidence/console-candidate.json', 'utf8')).image;
  const report = process.env.CONSOLE_SWITCH_ONLY ? JSON.parse(fs.readFileSync('/work/evidence/console-browser.json', 'utf8')) : { image };
  if (process.env.CONSOLE_SWITCH_ONLY) assert(report.image === image && report.pi && report.codex, 'Native checks must pass on this image before switch-only verification');
  const attachEvents = page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
      try { const message = JSON.parse(payload); if (message.type === 'submit') submits.push({ uid: socket.url().split('/')[7], text: message.text }); } catch {}
    }));
  };
  async function api(method, path, data) {
      path = await runtimePath(path);
    const response = await context.request.fetch(origin + path, { method, data, headers: { Origin: origin }, timeout: 330000 });
    assert(response.ok(), `${method} ${path}: HTTP ${response.status()} ${await response.text()}`);
    return runtimePath.observe(await response.json());
  }
  async function execute(agent, argv) {
    const result = await api('POST', `/api/agents/${agent.name}/exec`, { argv });
    assert.equal(result.exit_code, 0, result.output);
    return result.output.trim();
  }
  async function waitFor(check, message, seconds = 150) {
    const deadline = Date.now() + seconds * 1000;
    while (!await check()) {
      assert(Date.now() < deadline, message);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  async function file(agent, name) {
    return execute(agent, ['python3', '-c', `from pathlib import Path;p=Path('/workspace/${name}');print(p.read_text() if p.exists() else 'pending')`]);
  }
  async function open(page, agent, navigate = true) {
    if (navigate) await page.goto(origin + `/#/console?uid=${agent.uid}`);
    else {
      const navigation = page.frameLocator('iframe');
      await navigation.getByRole('button', { name: 'All workers', exact: true }).click();
      await navigation.locator(`[data-sandbox-uid="${agent.uid}"]`).click();
    }
    await page.frameLocator('iframe').locator(`iframe[title="${agent.name} Superterminal"]`).waitFor({ timeout: 180000 });
    await waitFor(() => Promise.resolve(page.frames().some(frame => frame.url().includes(`/${agent.uid}/ui/`))), 'Iframe did not select UID');
    const frame = page.frames().find(frame => frame.url().includes(`/${agent.uid}/ui/`));
    await frame.locator('.conn-live').waitFor({ state: 'attached', timeout: 30000 });
    return frame;
  }
  const chat = async frame => {
    await frame.getByRole('button', { name: 'Chat', exact: true }).click();
    const box = frame.getByRole('textbox', { name: 'Message', exact: true });
    await box.waitFor();
    return box;
  };
  try {
    assert.equal(targets[0].pane, targets[1].pane, 'Test must cover colliding pane IDs');
    const landing = await context.newPage(); attachEvents(landing);
    await landing.goto(origin + '/#/console');
    const navigation = landing.frameLocator('iframe');
    await navigation.getByRole('heading', { name: 'Workers', exact: true }).waitFor();
    await navigation.locator('[data-sandbox-uid]').first().waitFor();
    const pool = await api('GET', '/api/console');
    assert.equal(await landing.locator('[data-worker-id], [data-sandbox-uid]').count(), 0, 'Pool navigation is duplicated outside Herdr');
    await waitFor(() => navigation.locator('[data-worker-id]').count().then(count => count === pool.workers.length), 'Workers missing from Herdr sidebar');
    for (const worker of pool.workers) {
      await navigation.getByRole('button', { name: 'All workers', exact: true }).click();
      const row = navigation.locator(`[data-worker-id="${worker.id}"]`);
      assert((await row.textContent()).includes(`CPU ${worker.allocated.cpu}/${worker.capacity.cpu} · RAM ${worker.allocated.memory}/${worker.capacity.memory}`));
      await row.click();
      const shown = pool.agents.filter(agent => agent.sandbox === 'SUSPENDED' || agent.worker === worker.id);
      await waitFor(() => navigation.locator('[data-sandbox-uid]').count().then(count => count === shown.length), 'Worker filter did not update agent list');
      for (const agent of shown) await navigation.locator(`[data-sandbox-uid="${agent.uid}"]`).waitFor();
    }
    await landing.evaluate(uid => window.postMessage({ type: 'console-select', uid }, window.location.origin), targets[0].uid);
    await navigation.getByRole('button', { name: 'All workers', exact: true }).click();
    await waitFor(() => navigation.locator('[data-sandbox-uid]').count().then(count => count === pool.agents.length), 'All workers did not restore agent list');
    assert.equal(new URLSearchParams(landing.url().split('?')[1]).get('uid'), null, 'Host accepted navigation from the wrong window');
    const shell = landing.frames().find(frame => frame.url().endsWith('/api/console/ui/'));
    await shell.evaluate(() => new Promise(resolve => {
      const delivered = event => {
        if (event.data?.type !== 'console-state' || event.source !== window) return;
        window.removeEventListener('message', delivered);
        requestAnimationFrame(() => resolve(null));
      };
      window.addEventListener('message', delivered);
      window.postMessage({ type: 'console-state', pool: null, uid: 'forged' }, window.location.origin);
    }));
    assert.equal(await navigation.locator('[data-worker-id]').count(), pool.workers.length, 'Iframe accepted state from the wrong window');
    await landing.setViewportSize({ width: 600, height: 900 });
    await navigation.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await navigation.locator('[data-sandbox-uid]').first().waitFor({ state: 'visible' });
    await navigation.locator(`[data-sandbox-uid="${targets[0].uid}"]`).click();
    await navigation.frameLocator('iframe').locator('.conn-live').waitFor({ state: 'attached', timeout: 180000 });
    assert.equal(new URLSearchParams(landing.url().split('?')[1]).get('uid'), targets[0].uid, 'Embedded selection did not update the panel URL');
    await navigation.frameLocator('iframe').getByRole('button', { name: 'Open navigation', exact: true }).click();
    await navigation.getByRole('heading', { name: 'Workers', exact: true }).waitFor({ state: 'visible' });
    await waitFor(() => navigation.locator('.sidebar').evaluate(element => Math.abs(element.getBoundingClientRect().x) < 1), 'Mobile drawer did not finish opening');
    await landing.screenshot({ path: '/work/evidence/console-navigation-mobile.png' });
    await landing.close();
    report.integrated_navigation = report.worker_filter = report.message_source_checks = report.mobile_navigation = true;
    console.log('PASS native Workers/Agents navigation, resources, worker filter and message source checks');
    if (!process.env.CONSOLE_SWITCH_ONLY) for (const agent of targets) {
      await waitFor(async () => (await api('GET', `/api/agents/${agent.name}/session`)).runner.agent_status !== 'working', 'Previous verification is still running');
      await execute(agent, ['python3', '-c', `from pathlib import Path\nfor name in ['console-${agent.kind}-start','console-${agent.kind}-done','console-keyboard-${agent.kind}.txt']: (Path('/workspace')/name).unlink(missing_ok=True)`]);
      const before = await api('GET', `/api/agents/${agent.name}/session`);
      const process = JSON.parse(await execute(agent, ['herdr', 'pane', 'process-info', '--pane', agent.pane])).result.process_info;
      let page = await context.newPage(); attachEvents(page);
      let frame = await open(page, agent);
      await waitFor(() => Promise.resolve(new URL(frame.url()).searchParams.get('pane') === agent.pane), 'Primary agent pane was not selected');
      let box = await chat(frame);
      await frame.locator('input[type="file"]').setInputFiles({ name: 'console-pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64') });
      await waitFor(() => frame.locator('.composer-attachments img').evaluate(image => image.complete && image.naturalWidth > 0), 'Attachment preview blocked');
      await frame.locator('.composer-attachment.is-ready').waitFor();
      await frame.getByRole('button', { name: 'Remove console-pixel.png', exact: true }).click();
      const prompt = `Use bash to run python3 -c 'import pathlib,time;pathlib.Path("/workspace/console-${agent.kind}-start").write_text("started");time.sleep(25);pathlib.Path("/workspace/console-${agent.kind}-done").write_text("continued")'. Run that exact command, then reply CONSOLE_${agent.kind.toUpperCase()}_DONE.`;
      await box.fill(prompt);
      await frame.getByRole('button', { name: 'Send message', exact: true }).click();
      await waitFor(async () => await file(agent, `console-${agent.kind}-start`) === 'started', 'Task did not start');
      await page.close();
      assert.equal((await api('GET', `/api/agents/${agent.name}/session`)).runner.agent_status, 'working');
      await waitFor(async () => await file(agent, `console-${agent.kind}-done`) === 'continued', 'Task stopped with browser');
      await waitFor(async () => (await api('GET', `/api/agents/${agent.name}/session`)).runner.agent_status !== 'working', 'Runner did not settle');
      page = await context.newPage(); attachEvents(page);
      frame = await open(page, agent);
      box = await chat(frame);
      assert.equal(await box.inputValue(), '', 'Acknowledged input was replayed as draft');
      const conversation = await api('GET', pathFor(agent) + `/bridge/api/pane/conversation?pane_id=${agent.pane}`);
      assert(JSON.stringify(conversation).includes(`console-${agent.kind}-start`), 'Native history missing');
      const after = await api('GET', `/api/agents/${agent.name}/session`);
      assert(after.runner.agent_session, 'Native conversation has no identity');
      if (before.runner.agent_session) assert.deepEqual(after.runner.agent_session, before.runner.agent_session);
      const afterProcess = JSON.parse(await execute(agent, ['herdr', 'pane', 'process-info', '--pane', agent.pane])).result.process_info;
      assert.equal(afterProcess.shell_pid, process.shell_pid);
      assert.equal(afterProcess.foreground_process_group_id, process.foreground_process_group_id);
      await frame.getByRole('button', { name: 'Terminal', exact: true }).click();
      await page.setViewportSize({ width: 1260, height: 800 });
      await frame.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type(`Use bash to write KEYBOARD_${agent.kind.toUpperCase()} into /workspace/console-keyboard-${agent.kind}.txt, then reply done.`, { delay: 1 });
      await page.waitForTimeout(350);
      await page.keyboard.press('Enter');
      await waitFor(async () => (await file(agent, `console-keyboard-${agent.kind}.txt`)).includes(`KEYBOARD_${agent.kind.toUpperCase()}`), 'Terminal input was not delivered');
      await page.screenshot({ path: `/work/evidence/console-${agent.kind}.png` });
      const connections = await context.serviceWorkers();
      assert.equal(connections.length, 0, 'Embedded UI registered a service worker');
      report[agent.kind] = true;
      fs.writeFileSync('/work/evidence/console-browser.json', JSON.stringify(report, null, 2) + '\n');
      await page.close();
      console.log('PASS', agent.kind, 'history, chat, terminal keyboard, resize, reconnect and closed-browser task');
    }

    const page = await context.newPage(); attachEvents(page);
    const [pi, codex] = targets;
    let frame = await open(page, pi);
    let box = await chat(frame);
    await frame.locator('.chat-turn').first().waitFor({ state: 'visible' });
    await page.screenshot({ path: '/work/evidence/console-navigation.png' });
    await box.fill('UNSENT_PI_DRAFT');
    frame = await open(page, codex, false);
    box = await chat(frame); assert.equal(await box.inputValue(), ''); await box.fill('UNSENT_CODEX_DRAFT');
    for (let index = 0; index < 3; index++) {
      frame = await open(page, pi, false); box = await chat(frame); assert.equal(await box.inputValue(), 'UNSENT_PI_DRAFT');
      frame = await open(page, codex, false); box = await chat(frame); assert.equal(await box.inputValue(), 'UNSENT_CODEX_DRAFT');
    }
    frame = await open(page, pi, false);
    await frame.getByRole('button', { name: 'Terminal', exact: true }).click();
    await frame.evaluate(() => {
      const settings = JSON.parse(localStorage.getItem('herdr-web-ui:settings') || '{}');
      settings.terminalInputMode = 'line';
      localStorage.setItem('herdr-web-ui:settings', JSON.stringify(settings));
    });
    await frame.goto(frame.url());
    await frame.locator('.conn-live').waitFor({ state: 'attached' });
    await frame.getByRole('textbox', { name: 'Terminal input line', exact: true }).fill('UNSENT_PI_TERMINAL');
    frame = await open(page, codex, false); assert.equal(await frame.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'UNSENT_CODEX_DRAFT');
    frame = await open(page, pi, false);
    assert.equal(await frame.getByRole('button', { name: 'Terminal', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await frame.getByRole('textbox', { name: 'Terminal input line', exact: true }).inputValue(), 'UNSENT_PI_TERMINAL');
    const extraLabel = 'console-extra-' + Date.now().toString(36);
    const extra = JSON.parse(await execute(pi, ['herdr', 'tab', 'create', '--label', extraLabel, '--cwd', '/workspace'])).result.root_pane.pane_id;
    await frame.getByRole('tab').filter({ hasText: extraLabel }).click();
    await waitFor(() => Promise.resolve(new URL(frame.url()).searchParams.get('pane') === extra), 'Extra pane was not selected');
    frame = await open(page, codex, false);
    await waitFor(() => Promise.resolve(new URL(frame.url()).searchParams.get('pane') === codex.pane), 'Other UID inherited the extra pane');
    frame = await open(page, pi, false);
    await waitFor(() => Promise.resolve(new URL(frame.url()).searchParams.get('pane') === extra), 'Per-UID pane selection was lost');
    const piHistory = await api('GET', pathFor(pi) + `/bridge/api/pane/conversation?pane_id=${pi.pane}`);
    const codexHistory = await api('GET', pathFor(codex) + `/bridge/api/pane/conversation?pane_id=${codex.pane}`);
    assert(!JSON.stringify(piHistory).includes('console-codex-start'));
    assert(!JSON.stringify(codexHistory).includes('console-pi-start'));
    if (!process.env.CONSOLE_SWITCH_ONLY) {
      assert.equal(submits.filter(message => message.text.includes('console-pi-start')).length, 1);
      assert.equal(submits.filter(message => message.text.includes('console-codex-start')).length, 1);
    }
    assert(!submits.some(message => message.text.includes('UNSENT_')), 'Switching sent an unsent draft');
    report.uid_isolation = report.keyboard_resize_reconnect = report.browser_independence = true;
    assert.deepEqual(errors, []);
    fs.writeFileSync('/work/evidence/console-browser.json', JSON.stringify(report, null, 2) + '\n');
    console.log('PASS colliding pane IDs, rapid UID switches, independent chat/terminal drafts and lenses, no resubmission');
    await page.close();
  } catch (error) {
    for (const page of context.pages()) await page.screenshot({ path: '/work/evidence/console-browser-failure.png' }).catch(() => {});
    throw error;
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error.stack); process.exit(1); });

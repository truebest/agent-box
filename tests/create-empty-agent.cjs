const { chromium } = require('/work/browser/node_modules/playwright-core');
const fs = require('node:fs'), assert = require('node:assert/strict');
const origin = process.env.AGENT_URL || 'https://192.0.2.10:18443';
const password = fs.readFileSync('/run/panel-password', 'utf8').trim(), secrets = [password];
const target = JSON.parse(fs.readFileSync('/work/private/create-targets.json')).findLast(actor => actor.name.startsWith('sandbox-'));
assert(target, 'Run create-browser.cjs first');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const runtimePath = require('./runtime-path.cjs')(async name => {
    const response = await context.request.get(origin + '/api/agents/' + encodeURIComponent(name));
    assert(response.ok(), `Sandbox lookup failed: HTTP ${response.status()}`);
    return response.json();
  });
  try {
    await require('./browser-auth.cjs')(context, origin, password);
    secrets.push(...(await context.cookies()).map(cookie => cookie.value));
    const api = async path => {
      path = await runtimePath(path);
      const response = await context.request.get(origin + path, { timeout: 180000 });
      assert(response.ok()); return runtimePath.observe(await response.json());
    };
    assert.equal((await api(`/api/agents/${target.name}`)).metadata.uid, target.uid);
    const resumed = await context.request.post(origin + `/api/agents/${target.name}/resume`, { headers: { Origin: origin }, timeout: 180000 });
    assert(resumed.ok());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/console?uid=' + target.uid);
    const navigation = page.frameLocator('iframe[title="Superterminal navigation"]');
    const frame = navigation.frameLocator('iframe.console-session-frame');
    await frame.locator('.conn-live').waitFor({ state: 'attached', timeout: 180000 });
    await frame.getByRole('button', { name: 'New workspace', exact: true }).click();
    const dialog = frame.getByRole('dialog');
    await dialog.getByRole('combobox', { name: 'Agent', exact: true }).click();
    await dialog.getByRole('option').filter({ hasText: /^Codex$/i }).click();
    await dialog.getByRole('textbox', { name: 'Directory', exact: true }).fill('/workspace');
    await dialog.getByRole('textbox', { name: /^Name/ }).fill('added-later');
    await dialog.getByRole('button', { name: 'Start', exact: true }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 90000 });
    const base = `/api/console/agents/${target.name}/${target.uid}/bridge/api`;
    const deadline = Date.now() + 90000;
    let agent;
    while (true) {
      agent = (await api(base + '/session')).snapshot.agents.find(agent => agent.agent === 'codex' && agent.interactive_ready);
      if (agent) break;
      assert(Date.now() < deadline, 'Added agent did not become ready'); await page.waitForTimeout(500);
    }
    await frame.getByRole('button', { name: 'Chat', exact: true }).click();
    await frame.getByRole('textbox', { name: 'Message', exact: true }).fill('Reply exactly ADDED_LATER. Do not use tools.');
    await frame.getByRole('button', { name: 'Send message', exact: true }).click();
    while (true) {
      const conversation = await api(base + '/pane/conversation?pane_id=' + agent.pane_id);
      if (JSON.stringify(conversation.turns.filter(turn => turn.role === 'assistant')).includes('ADDED_LATER')) break;
      assert(Date.now() < deadline, 'Added agent did not answer'); await page.waitForTimeout(500);
    }
    const replied = (await api(base + '/session')).snapshot.agents.find(item => item.pane_id === agent.pane_id);
    assert(replied.agent_session);
    await page.close();
    const after = (await api(base + '/session')).snapshot.agents.find(item => item.pane_id === agent.pane_id);
    assert.deepEqual(after.agent_session, replied.agent_session);
    const primary = await api(`/api/agents/${target.name}/session`);
    assert.equal(primary.kind, 'none'); assert.equal(primary.ready, false); assert.equal(primary.agents.length, 1);
    assert.deepEqual(errors, []);
    fs.writeFileSync('/work/evidence/create-empty-agent.json', JSON.stringify({ native_ui_added_agent: true, native_chat_works: true, browser_close_keeps_session: true, no_primary_adoption: true, javascript_errors: errors }, null, 2) + '\n');
    console.log('PASS empty sandbox: add Codex through native Herdr UI, chat, close browser, retain session');
  } finally {
    await context.request.post(origin + '/api/auth/logout', { headers: { Origin: origin } }).catch(() => {});
    await context.close(); await browser.close();
  }
})().catch(error => {
  let message = String(error.stack || error);
  for (const secret of secrets) message = message.split(secret).join('[redacted]');
  console.error(message); process.exit(1);
});

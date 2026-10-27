const { chromium } = require('/work/browser/node_modules/playwright-core');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const origin = 'https://192.0.2.10:8443';
const existing = JSON.parse(fs.readFileSync('/work/evidence/console-existing.json', 'utf8'));
const password = fs.readFileSync('/run/panel-password', 'utf8').trim();

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1700, height: 1050 } });
  const runtimePath = require('./runtime-path.cjs')(async name => {
    const response = await context.request.get(origin + '/api/agents/' + encodeURIComponent(name));
    assert(response.ok(), `Sandbox lookup failed: HTTP ${response.status()}`);
    return response.json();
  });
  await require('./browser-auth.cjs')(context, origin, password);
  const page = await context.newPage(), errors = [], inputs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    try {
      const message = JSON.parse(payload);
      if (['submit', 'input'].includes(message.type)) inputs.push({ type: message.type, fields: Object.keys(message), hex: Buffer.from(message.data || message.input || message.text || '').toString('hex') });
    } catch {}
  }));
  async function api(path) {
      path = await runtimePath(path);
    const response = await context.request.get(origin + path);
    assert(response.ok(), `HTTP ${response.status()} for ${path}`);
    return runtimePath.observe(await response.json());
  }
  try {
    const pool = await api('/api/console');
    assert(pool.enabled && pool.workers.length === 2);
    assert.deepEqual(pool.hosts, [{ id: 'agent-box-host', name: 'agent-box-host' }]);
    assert([...pool.workers, ...pool.agents].every(item => item.host === 'agent-box-host'));
    const agent = pool.agents.find(agent => agent.uid === existing.uid);
    assert(agent.name === 'codex-01' && agent.sandbox === 'RUNNING');
    const before = await api('/api/agents/codex-01/session');
    assert.deepEqual(before.runner.agent_session, existing.conversation_after);
    await page.goto(origin + '/#/console');
    await page.getByRole('link', { name: 'Superterminal', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Superterminal', exact: true }).waitFor();
    await page.frameLocator('iframe[title="Superterminal navigation"]').getByRole('heading', { name: 'Workers', exact: true }).waitFor();
    assert.equal(await page.frameLocator('iframe').getByText('Superterminal', { exact: true }).count(), 0, 'Superterminal title is repeated inside the console');
    await page.frameLocator('iframe[title="Superterminal navigation"]').locator(`[data-host-id="${agent.host}"] [data-sandbox-uid="${agent.uid}"]`).click();
    await page.frameLocator('iframe').frameLocator('iframe[title="codex-01 Superterminal"]').locator('.conn-live').waitFor({ state: 'attached', timeout: 180000 });
    assert.equal(new URLSearchParams(page.url().split('?')[1]).get('uid'), agent.uid);
    const frame = page.frames().find(frame => frame.url().includes(`/${agent.uid}/ui/`));
    assert.equal(await page.locator('[data-worker-id], [data-sandbox-uid]').count(), 0, 'Pool navigation is duplicated outside Herdr');
    const navigation = page.frameLocator('iframe');
    await navigation.getByRole('heading', { name: 'Workers', exact: true }).waitFor();
    await navigation.getByRole('heading', { name: 'Workers', exact: true }).waitFor();
    const host = navigation.locator('[data-host-id="agent-box-host"]');
    await host.locator('.machine-kind', { hasText: 'Host' }).waitFor();
    await host.getByRole('button', { name: 'Collapse agent-box-host', exact: true }).click();
    await host.getByRole('heading', { name: 'Workers', exact: true }).waitFor({ state: 'hidden' });
    await host.getByRole('button', { name: 'Expand agent-box-host', exact: true }).click();
    await host.getByRole('heading', { name: 'Workers', exact: true }).waitFor();
    assert.equal(await host.locator('[data-sandbox-uid]').count(), pool.agents.length);
    await frame.getByRole('button', { name: 'Chat', exact: true }).click();
    await frame.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    await frame.locator('.chat-turn').first().waitFor({ state: 'visible', timeout: 30000 });
    await frame.getByRole('button', { name: 'Command palette', exact: true }).click();
    const palette = frame.getByRole('dialog', { name: 'Command palette', exact: true });
    await palette.getByRole('searchbox', { name: 'Search panes and actions', exact: true }).fill('>Add PC');
    assert.equal(await palette.getByText('Add PC', { exact: true }).count(), 0);
    await palette.getByRole('button', { name: 'Close command palette', exact: true }).click();
    const deadline = Date.now() + 10000;
    while (new URL(frame.url()).searchParams.get('pane') !== before.pane_id) {
      assert(Date.now() < deadline, 'Primary pane was not selected');
      await page.waitForTimeout(100);
    }
    await frame.getByRole('button', { name: 'Terminal', exact: true }).click();
    await frame.locator('.xterm-helper-textarea').waitFor({ state: 'attached' });
    for (const [link, heading] of [['Sandboxes', 'Sandbox Management'], ['Files', 'Sandbox Files'], ['Terminal', 'Sandbox Terminal'], ['Tasks', 'Agent Tasks']]) {
      await page.getByRole('link', { name: link, exact: true }).click();
      await page.getByRole('heading', { name: heading, exact: true }).waitFor();
      if (link === 'Sandboxes') {
        await page.getByRole('button', { name: 'Create Sandbox', exact: true }).click();
        const dialog = page.locator('dialog[open]');
        await dialog.getByRole('heading', { name: 'Create Sandbox', exact: true }).waitFor();
        assert.equal(await dialog.getByRole('combobox', { name: 'Agent', exact: true }).locator('option').count(), 2);
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      } else await page.getByRole('combobox', { name: 'Sandbox', exact: true }).waitFor();
    }
    const after = await api('/api/agents/codex-01/session');
    assert.deepEqual(after.runner.agent_session, before.runner.agent_session);
    assert.equal((await context.serviceWorkers()).length, 0);
    // xterm answers device queries when the native terminal attaches.
    const terminalReplies = new Set(['1b5b3f313031363b322479', '1b5b3f313b3263']);
    assert(inputs.every(message => message.type === 'input' && terminalReplies.has(message.hex)), 'Opening Superterminal sent task input');
    assert.deepEqual(errors, []);
    fs.writeFileSync('/work/evidence/console-final.json', JSON.stringify({ image: existing.image, label: 'Superterminal', terminology: true, host_hierarchy: true, console_live: true, integrated_navigation: true, history_visible: true, existing_tabs: true, conversation_preserved: true, no_task_input_sent: true, browser_errors: errors }, null, 2) + '\n');
    console.log('PASS Superterminal Host hierarchy, codex-01 chat/terminal, existing tabs, no task input and no browser errors');
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error.stack); process.exit(1); });

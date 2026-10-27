const { chromium } = require('/work/browser/node_modules/playwright-core');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const origin = process.env.AGENT_URL || 'https://192.0.2.10:18443';
const password = fs.readFileSync('/run/panel-password', 'utf8').trim();
const targets = JSON.parse(fs.readFileSync('/work/evidence/console-targets.json', 'utf8'));

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1700, height: 1050 } });
  const runtimePath = require('./runtime-path.cjs')(async name => {
    const response = await context.request.get(origin + '/api/agents/' + encodeURIComponent(name));
    assert(response.ok(), `Sandbox lookup failed: HTTP ${response.status()}`);
    return response.json();
  });
  await require('./browser-auth.cjs')(context, origin, password);
  async function api(method, path, data) {
      path = await runtimePath(path);
    const response = await context.request.fetch(origin + path, { method, data, headers: { Origin: origin }, timeout: 330000 });
    assert(response.ok(), `${method} ${path}: HTTP ${response.status()} ${await response.text()}`);
    return runtimePath.observe(await response.json());
  }
  const agent = targets.find(agent => agent.kind === 'pi');
  const oldPath = `/api/console/agents/${agent.name}/${agent.uid}`;
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  async function connectedFrame() {
    await page.frameLocator('iframe').frameLocator(`iframe[title="${agent.name} Superterminal"]`).locator('.conn-live').waitFor({ state: 'attached', timeout: 180000 });
    return page.frames().find(frame => frame.url().includes(`/${agent.uid}/ui/`));
  }
  try {
    const before = await api('GET', `/api/agents/${agent.name}/session`);
    await page.goto(origin + `/#/console?uid=${agent.uid}`);
    let frame = await connectedFrame();
    await frame.getByRole('button', { name: 'Chat', exact: true }).click();
    await frame.getByRole('textbox', { name: 'Message', exact: true }).fill('LIFECYCLE_UNSENT');
    await api('POST', `/api/agents/${agent.name}/suspend`);
    await page.frameLocator('iframe').locator(`[data-sandbox-uid="${agent.uid}"] [data-sandbox-state="SUSPENDED"]`).waitFor();
    await page.frameLocator('iframe').getByRole('button', { name: 'Resume', exact: true }).click();
    frame = await connectedFrame();
    assert.equal(await frame.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'LIFECYCLE_UNSENT');
    const after = await api('GET', `/api/agents/${agent.name}/session`);
    assert.deepEqual(after.runner.agent_session, before.runner.agent_session);
    assert((await api('GET', oldPath + `/bridge/api/pane/conversation?pane_id=${agent.pane}`)).turns.length > 0);
    await frame.evaluate(() => localStorage.setItem('herdr-web-ui:composer-draft:w1:p1', 'DELETED_UID_DRAFT'));
    await api('DELETE', `/api/agents/${agent.name}`);
    const replacement = await api('POST', '/api/agents', { name: agent.name, kind: agent.kind });
    assert.notEqual(replacement.metadata.uid, agent.uid);
    for (const suffix of ['/ui/', '/bridge/api/session', '/bridge/ws', '/connect', '/resume']) {
      const response = await context.request.fetch(origin + oldPath + suffix, { method: suffix === '/connect' || suffix === '/resume' ? 'POST' : 'GET', headers: { Origin: origin } });
      assert.equal(response.status(), 404, 'Old UID can still select a replacement');
    }
    const oldUID = agent.uid;
    agent.uid = replacement.metadata.uid;
    agent.pane = (await api('GET', `/api/agents/${agent.name}/session?uid=${agent.uid}`)).pane_id;
    fs.writeFileSync('/work/evidence/console-targets.json', JSON.stringify(targets, null, 2) + '\n');
    await page.frameLocator('iframe').getByText('Waiting for sandbox inventory…', { exact: true }).waitFor({ timeout: 20000 });
    await page.frameLocator('iframe').getByRole('button', { name: 'All workers', exact: true }).click();
    await page.frameLocator('iframe').locator(`[data-sandbox-uid="${agent.uid}"]`).click();
    frame = await connectedFrame();
    await frame.getByRole('button', { name: 'Chat', exact: true }).click();
    assert.equal(await frame.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), '');
    assert.deepEqual(errors, []);
    fs.writeFileSync('/work/evidence/console-lifecycle.json', JSON.stringify({ resume_button: true, recreated_name: true, old_uid: oldUID, new_uid: agent.uid }, null, 2) + '\n');
    console.log('PASS Suspended/Resume UI, native conversation preserved, name reuse rejects old UID and drafts');
  } catch (error) {
    await page.screenshot({ path: '/work/evidence/console-lifecycle-failure.png' }).catch(() => {});
    throw error;
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error.stack); process.exit(1); });

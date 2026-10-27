const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/tmp/agent-box-host-browser/node_modules/playwright-core');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const password = process.env.AGENT_PASSWORD_FILE ? require('node:fs').readFileSync(process.env.AGENT_PASSWORD_FILE, 'utf8').trim() : execFileSync('ssh', ['operator@192.0.2.10', 'cat /home/operator/.config/substrate-panel/password'], { encoding: 'utf8' }).trim();
const origin = process.env.AGENT_URL || 'https://192.0.2.10:8443';
const name = `verify-ui-${Date.now().toString(36)}`;
const endpoint = `/api/agents/${name}`;
const root = process.env.TEST_ROOT || '/home/operator/psrc/agent-box-host';
(async () => {
  const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_MODULE ? {} : { executablePath: '/usr/bin/google-chrome' }), headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const runtimePath = require('./runtime-path.cjs')(async name => {
    const response = await context.request.get(origin + '/api/agents/' + encodeURIComponent(name));
    assert(response.ok(), `Sandbox lookup failed: HTTP ${response.status()}`);
    return response.json();
  });
  await require('./browser-auth.cjs')(context, origin, password);
  const page = await context.newPage();
  const errors = [], checks = [];
  const pass = check => { checks.push(check); console.log("PASS " + check) };
  page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(30000);
  async function api(method, path, data) {
      path = await runtimePath(path);
    const response = await context.request.fetch(origin + path, { method, data, headers: { Origin: origin }, timeout: 330000 });
    assert(response.ok(), `${method} ${path}: HTTP ${response.status()}`);
    return runtimePath.observe(await response.json());
  }
  async function execute(argv) {
    const result = await api('POST', endpoint + '/exec', { argv, cwd: '/workspace' });
    assert.equal(result.exit_code, 0, result.output);
    return result.output.trim();
  }
  async function renderedResponse(method, url, trigger) {
    const result = page.waitForResponse(r => r.request().method() === method && new URL(r.url()).pathname === url, { timeout: 330000 });
    await trigger();
    const response = await result;
    assert(response.ok(), `${method} ${url}: HTTP ${response.status()}`);
    return response;
  }
  let created = false;
  let lastPage = page;
  try {
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Sandbox Management', exact: true }).waitFor();
    await page.getByLabel('Theme', { exact: true }).selectOption('dark');
    await page.reload();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.getByLabel('Theme', { exact: true }).selectOption('light');
    pass('upstream React layout, theme persistence');
    await page.getByRole('button', { name: 'Create Sandbox', exact: true }).click();
    const create = page.locator('dialog[open]').filter({ has: page.getByRole('heading', { name: 'Create Sandbox', exact: true }) });
    const nameField = create.getByLabel('Name', { exact: true });
    await nameField.fill('Invalid');
    assert.equal(await nameField.evaluate(input => input.checkValidity()), false);
    await nameField.fill(name);
    assert.equal(await nameField.evaluate(input => input.checkValidity()), true);
    assert.equal(await create.getByLabel('Agent', { exact: true }).locator('option').count(), 3);
    await create.getByLabel('Agent', { exact: true }).selectOption('pi');
    await renderedResponse('POST', '/api/agents', () => create.getByRole('button', { name: 'Create Sandbox', exact: true }).click());
    created = true;
    const row = () => page.locator('tbody tr').filter({ hasText: name });
    await row().getByText('running', { exact: true }).waitFor();
    const actor = await api('GET', endpoint);
    const uid = actor.metadata.uid;
    const history = root + '/evidence/cleanup-targets.json';
    const previous = await fs.readFile(history, 'utf8').then(JSON.parse).catch(() => []);
    await fs.writeFile(history, JSON.stringify([...previous, {name, uid}], null, 2) + '\n');
    assert(await row().getByText(actor.status.workerAssignment.worker.name, { exact: true }).count());
    pass('create Pi agent, optional runner, actual state and worker');

    await row().getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('heading', { name: 'Sandbox Files', exact: true }).waitFor();
    await page.getByRole('button', { name: '.agent-state', exact: true }).waitFor();
    const content = 'upstream-ui-file-check\n';
    await renderedResponse('PUT', endpoint + '/files', () => page.getByLabel('Upload file', { exact: true }).setInputFiles({ name: 'ui-file.txt', mimeType: 'text/plain', buffer: Buffer.from(content) }));
    const fileRow = page.locator('tbody tr').filter({ hasText: 'ui-file.txt' });
    await fileRow.waitFor();
    await fileRow.getByRole('button', { name: 'Download', exact: true }).click();
    const downloading = page.waitForEvent('download');
    await page.locator('dialog[open]').getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), 'ui-file.txt');
    assert.equal(await fs.readFile(await download.path(), 'utf8'), content);
    await fileRow.getByRole('button', { name: 'Delete', exact: true }).click();
    await renderedResponse('DELETE', endpoint + '/files', () => page.locator('dialog[open]').getByRole('button', { name: 'Delete', exact: true }).click());
    await fileRow.waitFor({ state: 'detached' });
    page.once('dialog', dialog => dialog.accept('ui-directory'));
    await renderedResponse('POST', endpoint + '/files', () => page.getByRole('button', { name: 'New directory', exact: true }).click());
    const directoryRow = page.locator('tbody tr').filter({ hasText: 'ui-directory' });
    await directoryRow.getByRole('button', { name: 'Delete', exact: true }).click();
    await renderedResponse('DELETE', endpoint + '/files', () => page.locator('dialog[open]').getByRole('button', { name: 'Delete', exact: true }).click());
    await directoryRow.waitFor({ state: 'detached' });
    await page.getByLabel('Path', { exact: true }).fill('/etc');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await page.getByText('Invalid request, inaccessible path, or command timeout', { exact: true }).waitFor();
    await execute(['python3', '-c', "from pathlib import Path;Path('/workspace/escape').symlink_to('/etc',target_is_directory=True)"]);
    const denied = await context.request.get(origin + await runtimePath(endpoint + '/files?path=/workspace/escape/passwd'));
    assert.equal(denied.status(), 400);
    pass('file upload/download/delete, mkdir/rmdir, workspace and symlink boundaries');

    await page.goto(origin + `/#/terminal?sandbox=${name}`);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    const frame = page.locator('#terminal');
    await frame.locator('.xterm-helper-textarea').waitFor({ state: 'attached' });
    await frame.locator('.xterm-screen').click();
    await page.keyboard.type("herdr");
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    await execute(['herdr', 'tab', 'create', '--focus', '--label', 'browser-shell', '--cwd', '/workspace']);
    await page.waitForTimeout(500);
    await page.keyboard.type("python3 -c 'import time,pathlib;time.sleep(3);pathlib.Path(\"/workspace/browser-detach.txt\").write_text(\"continued\")'", { delay: 1 });
    await page.keyboard.press('Enter');
    await page.screenshot({ path: root + '/evidence/panel-terminal.png', fullPage: true });
    await page.close();
    const completionDeadline = Date.now() + 15000;
    while (await execute(['python3', '-c', "from pathlib import Path;p=Path('/workspace/browser-detach.txt');print(p.read_text() if p.exists() else 'pending')"]) !== 'continued') {
      assert(Date.now() < completionDeadline, 'Terminal task stopped on browser disconnect');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    pass('real ttyd WebSocket, task continues after page closes');

    const resumedPage = await context.newPage();
    lastPage = resumedPage;
    resumedPage.on('pageerror', e => errors.push(e.message));
    resumedPage.setDefaultTimeout(30000);
    await resumedPage.goto(origin);
    const agentRow = () => resumedPage.locator('tbody tr').filter({ hasText: name });
    let operation = resumedPage.waitForResponse(r => r.url().endsWith(endpoint + '/suspend'), { timeout: 330000 });
    await agentRow().getByRole('button', { name: `Manage ${name}`, exact: true }).click();
    await resumedPage.getByRole('menuitem', { name: 'Suspend', exact: true }).click();
    let response = await operation; assert(response.ok(), 'Suspend failed');
    const suspended = await api('GET', endpoint);
    assert(suspended.status.snapshots.some(s => s.fidelity === 'SNAPSHOT_FIDELITY_MEMORY' && s.durableSnapshot?.status === 'SNAPSHOT_STORAGE_STATUS_COMPLETED'));
    await agentRow().getByText('suspended', { exact: true }).waitFor();
    operation = resumedPage.waitForResponse(r => r.url().endsWith(endpoint + '/resume'), { timeout: 330000 });
    await agentRow().getByRole('button', { name: `Manage ${name}`, exact: true }).click();
    await resumedPage.getByRole('menuitem', { name: 'Resume', exact: true }).click();
    response = await operation; assert(response.ok(), 'Resume failed');
    await agentRow().getByText('running', { exact: true }).waitFor();
    assert.equal(await execute(['cat', '/workspace/browser-detach.txt']), 'continued');
    await resumedPage.goto(origin + `/#/terminal?sandbox=${name}`);
    await resumedPage.getByText('Connected', { exact: true }).waitFor();
    await resumedPage.locator('#terminal .xterm-helper-textarea').waitFor({state: 'attached'});
    pass('UI suspend with completed MEMORY snapshot, UI resume, terminal reconnect and files retained');
    await resumedPage.goto(origin + `/#/tasks?sandbox=${name}`);
    await resumedPage.getByLabel('Prompt', { exact: true }).fill('Use a tool to compute 3*7. Report WEB_UI_MODEL_OK and the result.');
    operation = resumedPage.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === endpoint + '/prompt', { timeout: 30000 });
    await resumedPage.getByRole('button', { name: 'Send task', exact: true }).click();
    response = await operation; assert.equal(response.status(), 202, await response.text());
    await resumedPage.getByText('Sent to the agent terminal. Follow the conversation in Terminal → herdr.', { exact: true }).waitFor();
    pass('Tasks form, asynchronous gpt-6.1-sol Pi goal');
    await resumedPage.goto(origin);
    await agentRow().waitFor();
    await resumedPage.screenshot({ path: root + '/evidence/panel.png', fullPage: true });
    await agentRow().getByRole('button', { name: `Manage ${name}`, exact: true }).click();
    await resumedPage.getByRole('menuitem', { name: 'Delete sandbox…', exact: true }).click();
    const confirmation = resumedPage.locator('dialog[open]');
    await confirmation.getByText(/Delete all workspace data and snapshots/).waitFor();
    operation = resumedPage.waitForResponse(r => r.request().method() === 'DELETE' && new URL(r.url()).pathname === endpoint, { timeout: 330000 });
    await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
    response = await operation; assert(response.ok(), 'Delete failed'); created = false;
    await agentRow().waitFor({ state: 'detached' });
    assert.equal((await context.request.get(origin + endpoint)).status(), 404);
    pass('confirmed deletion, agent absent from backend');
    await resumedPage.setViewportSize({ width: 390, height: 844 });
    await resumedPage.getByRole('navigation', { name: 'Navigation' }).getByRole('link', { name: 'Files', exact: true }).click();
    await resumedPage.getByRole('heading', { name: 'Sandbox Files', exact: true }).waitFor();
    pass('mobile navigation');
    assert.deepEqual(errors, [], 'Browser JavaScript errors');
    await fs.writeFile(root + '/evidence/web-ui.json', JSON.stringify({ upstream: '6f7b273ea80732b063d1d1a914b7138780fa83a0', actor: { name, uid }, checks, javascriptErrors: errors }, null, 2) + '\n');

  } catch (error) {
    console.error('Browser check failed:', error.message);
    if (!lastPage.isClosed()) {
      await lastPage.screenshot({ path: root + '/evidence/panel-error.png', fullPage: true }).catch(() => {});
      console.error('Visible alerts:', await lastPage.getByRole('alert').allTextContents());
    }
    throw error;
  } finally {
    if (created) await api('DELETE', endpoint).catch(e => console.error('Test cleanup failed:', e.message));
    await context.close(); await browser.close();
  }
})().catch(e => { console.error(e.message); process.exit(1) });

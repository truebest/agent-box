const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/work/browser/node_modules/playwright-core');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const dist = path.resolve(process.env.AGENT_WEB_DIST || 'panel/web/dist');

(async () => {
  let uid = 'selected', requests = [], sockets = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const json = (value, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/api/auth/session') return json({ authenticated: true, expires_at: new Date(Date.now() + 3600000).toISOString() });
    if (url.pathname === '/api/agents') return json({ actors: [{ metadata: { name: 'same-name', uid }, status: { state: 'ACTOR_STATE_RUNNING' } }] });
    if (url.pathname.startsWith('/api/agents/')) {
      requests.push({ method: request.method, path: url.pathname, uid: url.searchParams.get('uid') });
      if (url.searchParams.get('uid') !== uid) return json({ error: 'Sandbox UID no longer exists' }, 404);
      if (url.pathname.endsWith('/session')) return json({ kind: 'codex', ready: true, runner: { agent_status: 'idle' } });
      if (url.pathname.endsWith('/prompt')) return json({ accepted: true, message: 'Sent' }, 202);
      return json(request.method === 'GET' ? { entries: [{ name: 'saved.txt', directory: false }] } : { ok: true });
    }
    const file = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!file.startsWith(dist + path.sep) || !fs.existsSync(file)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'text/html');
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/api/agents/**/terminal/ws**', socket => sockets.push(new URL(socket.url()).searchParams.get('uid')));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const selection = page.getByRole('combobox', { name: 'Sandbox', exact: true });
    await page.goto(origin + '/#/files?sandbox=deleted-name');
    await page.getByText('saved.txt', { exact: true }).waitFor();
    assert.equal(new URLSearchParams(page.url().split('?')[1]).get('sandbox'), 'same-name');
    assert.equal(await selection.inputValue(), 'selected');
    uid = 'replacement';
    await page.locator('input[type=file]').setInputFiles({ name: 'upload.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
    await page.getByText('Sandbox UID no longer exists', { exact: true }).first().waitFor();
    assert.equal(requests.findLast(request => request.method === 'PUT').uid, 'selected');
    await page.getByRole('button', { name: 'Reload Sandboxes' }).click();
    await selection.locator('option[value=replacement]').waitFor({ state: 'attached' });
    assert.equal(await selection.inputValue(), 'selected');
    await selection.selectOption('replacement');
    await page.getByText('saved.txt', { exact: true }).waitFor();
    await Promise.all([
      page.waitForResponse(response => response.request().method() === 'PUT' && response.ok()),
      page.locator('input[type=file]').setInputFiles({ name: 'upload.txt', mimeType: 'text/plain', buffer: Buffer.from('test') }),
    ]);
    assert.equal(requests.findLast(request => request.method === 'PUT').uid, 'replacement');

    await page.goto(origin + '/#/terminal?sandbox=deleted-name');
    await page.waitForFunction(() => document.querySelector('[aria-label="Sandbox"]')?.value === 'replacement');
    await page.getByText('Connected', { exact: true }).waitFor();
    uid = 'third';
    await page.getByRole('button', { name: 'Reload Sandboxes' }).click();
    await selection.locator('option[value=third]').waitFor({ state: 'attached' });
    assert.equal(await selection.inputValue(), 'replacement');
    assert(!sockets.includes('third'));
    await selection.selectOption('third');
    await page.getByText('Connected', { exact: true }).waitFor();
    assert.equal(sockets.at(-1), 'third');

    await page.goto(origin + '/#/tasks?sandbox=same-name&uid=third');
    await page.getByRole('button', { name: 'Send task' }).waitFor();
    await page.getByRole('textbox', { name: 'Prompt' }).fill('Do not redirect a stale task');
    uid = 'fourth';
    await page.getByRole('button', { name: 'Send task' }).click();
    await page.getByText(/Sandbox UID no longer exists/).waitFor();
    assert.equal(requests.findLast(request => request.path.endsWith('/prompt')).uid, 'third');
    await page.reload();
    await selection.locator('option[value=fourth]').waitFor({ state: 'attached' });
    assert(await page.getByRole('button', { name: 'Send task' }).isDisabled());
    await selection.selectOption('fourth');
    await page.getByRole('textbox', { name: 'Prompt' }).fill('Selected replacement');
    await page.getByRole('button', { name: 'Send task' }).click();
    await page.getByText('Sent', { exact: true }).waitFor();
    assert.equal(requests.findLast(request => request.path.endsWith('/prompt')).uid, 'fourth');
    assert.deepEqual(errors, []);
    assert(requests.length < 100, 'Inventory reload loop');
    console.log('PASS: stale file, terminal and task selections retain their UID; replacement requires explicit selection');
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

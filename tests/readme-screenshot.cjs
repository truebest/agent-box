const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.resolve(process.env.AGENT_WEB_DIST || path.join(root, 'panel/web/dist'));
const examples = [
  ['api-refactor', 'codex', 'RUNNING', 'working', 'backend'],
  ['docs-preview', 'pi', 'RUNNING', 'idle', 'docs'],
  ['data-notebook', 'pi', 'SUSPENDED', 'idle', 'research'],
  ['release-checks', 'devin', 'RUNNING', 'working', 'backend'],
  ['scratchpad', 'none', 'SUSPENDED', 'idle', 'personal'],
];

(async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    function json(value) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(value));
    }
    if (url.pathname === '/api/auth/session') return json({ authenticated: true, expires_at: new Date(Date.now() + 3600000).toISOString() });
    if (url.pathname === '/api/console') return json({ enabled: true });
    if (url.pathname === '/api/agents') return json({ actors: examples.map(([name, kind, state, , project], index) => ({
      metadata: { name, uid: `demo-${index}`, createTime: '2026-10-27T09:00:00Z', labels: { project } },
      actorTemplate: { name: kind },
      status: { state: `ACTOR_STATE_${state}`, workerAssignment: state === 'RUNNING' ? { worker: { name: 'worker-demo-1' } } : undefined,
        snapshots: [{ durableSnapshot: { status: 'SNAPSHOT_STORAGE_STATUS_COMPLETED' } }] },
    })) });
    const match = /^\/api\/agents\/([^/]+)\/session$/.exec(url.pathname);
    if (match) {
      const item = examples.find(example => example[0] === match[1]);
      assert(item);
      return json({ kind: item[1], ready: true, runner: { agent_status: item[3] } });
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, timezoneId: 'UTC' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/#/sandboxes`);
    await page.getByText('api-refactor', { exact: true }).waitFor();
    await page.getByText('release-checks', { exact: true }).waitFor();
    await page.getByText('Agent: working', { exact: true }).first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(errors, []);
    assert.equal(await page.locator('tbody tr').count(), examples.length);
    fs.mkdirSync(path.join(root, 'docs/images'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'docs/images/sandboxes.png') });
    console.log('README screenshot captured from the application with demo data.');
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

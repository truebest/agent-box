const { chromium } = require('/work/browser/node_modules/playwright-core');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const origin = process.env.AGENT_URL || 'https://192.0.2.10:8443';
const uid = process.env.SANDBOX_UID;

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const login = await browser.newContext({ ignoreHTTPSErrors: true });
    await require('./browser-auth.cjs')(login, origin, fs.readFileSync('/run/panel-password', 'utf8').trim());
    const first = await login.newPage();
    await first.goto(origin + '/#/sandboxes');
    await first.getByRole('heading', { name: 'Sandbox Management', exact: true }).waitFor();
    const cookie = (await login.cookies(origin)).find(c => c.name === '__Host-agent-box-session');
    assert(cookie, 'Browser login did not create a shared panel session');
    assert(cookie.secure && cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/');
    assert(cookie.expires * 1000 > Date.now() + 6 * 86400000);
    await login.close();

    // A new context has no cached HTTP Basic credentials, only the opaque cookie.
    const context = await browser.newContext({ ignoreHTTPSErrors: true, storageState: { cookies: [cookie], origins: [] } });
    const page = await context.newPage(), errors = [], unauthorized = [], inputs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (/\/(prompt|restart|resume|cancel|permission)$/.test(path) && request.method() === 'POST') inputs.push(path);
    });
    page.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (response.status() === 401) unauthorized.push(path);
    });
    const pool = await context.request.get(origin + '/api/console');
    assert.equal(pool.status(), 200, 'Cookie-only API authentication failed');
    const sandbox = uid ? (await pool.json()).agents.find(a => a.uid === uid) : null;
    if (uid) assert(sandbox && sandbox.sandbox === 'RUNNING', 'Selected sandbox must already be running');
    let before;
    const roster = async () => {
      const response = await context.request.get(`${origin}/api/console/agents/${sandbox.name}/${uid}/bridge/api/session`);
      assert.equal(response.status(), 200);
      return (await response.json()).snapshot.agents.map(a => [a.pane_id, a.agent_session]);
    };
    if (sandbox) before = await roster();
    const open = async () => {
      await page.goto(origin + '/#/console' + (uid ? '?uid=' + encodeURIComponent(uid) : ''));
      const navigation = page.frameLocator('iframe[title="Superterminal navigation"]');
      await navigation.getByRole('button', { name: 'Settings', exact: true }).waitFor();
      if (sandbox) await navigation.frameLocator('iframe.console-session-frame').locator('.pane-column').waitFor({ timeout: 45000 });
    };
    await open();
    await page.reload();
    await open();
    if (sandbox) {
      const ws = `${origin.replace(/^https:/, 'wss:')}/api/console/agents/${sandbox.name}/${uid}/bridge/ws`;
      assert(await page.evaluate(url => new Promise(resolve => {
        const socket = new WebSocket(url);
        const timer = setTimeout(() => { socket.close(); resolve(false); }, 15000);
        socket.onopen = () => { clearTimeout(timer); socket.close(); resolve(true); };
        socket.onerror = () => { clearTimeout(timer); resolve(false); };
      }), ws), 'Cookie-only WebSocket failed');
      assert.deepEqual(await roster(), before, 'Navigation replaced a native pane or session');
    }
    assert.equal((await context.request.post(origin + '/api/console', { data: {} })).status(), 403, 'Cookie mutation without Origin passed');
    assert.equal((await context.request.post(origin + '/api/console', { data: {}, headers: { Origin: 'https://evil.test' } })).status(), 403);
    const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
    assert.equal((await anonymous.request.get(origin + '/api/console')).status(), 401);
    await anonymous.close();
    assert.deepEqual(errors, []);
    assert.deepEqual(unauthorized, []);
    assert.deepEqual(inputs, []);
    console.log(JSON.stringify({ cookie_only_browser: true, seven_day_cookie: true, console_navigation_and_reload: true,
      websocket: !!sandbox, origin_checks: true, anonymous_denied: true,
      native_identities_preserved: !!sandbox, browser_http_credentials_configured: false, prompts_or_control_operations: inputs.length, errors, unauthorized }));
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exit(1); });

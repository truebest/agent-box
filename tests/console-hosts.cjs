const { chromium } = require('/work/browser/node_modules/playwright-core');
const fs = require('node:fs'), assert = require('node:assert/strict');
const origin = process.env.AGENT_URL || 'https://192.0.2.10:18443';
const image = JSON.parse(fs.readFileSync('/work/evidence/console-candidate.json', 'utf8')).image;
const password = fs.readFileSync('/run/panel-password', 'utf8').trim();
const secrets = [password];
const hosts = ['agent-box-host', 'fixture-host'];
const pool = {
 enabled: true, hosts: hosts.map(id => ({ id, name: id })),
 workers: hosts.flatMap(host => [1, 2].map(number => ({ host, id: 'worker-' + number, name: host + '-worker-' + number, state: 'ACTIVE', agents: 1, capacity: { cpu: '8', memory: '8Gi' }, allocated: { cpu: '4', memory: '2Gi' } }))),
 agents: hosts.flatMap(host => [1, 2, 3].map(number => ({ host, uid: host + '-sandbox-' + number, name: 'sandbox-' + number, kind: 'codex', sandbox: number === 3 ? 'SUSPENDED' : 'RUNNING', runner: 'running', worker: number === 3 ? '' : 'worker-' + number }))),
};
const states = ['working', 'blocked', 'done', 'idle', 'waiting', 'unknown'];
const liveStatuses = new Map();
function snapshot(uid) {
 const panes = states.map((status, index) => ({ pane_id: 'w1:p' + (index + 1), workspace_id: 'w1', tab_id: 'w1:t1', terminal_id: 'terminal-' + index, revision: 1, focused: index === 0, agent_status: status === 'waiting' ? 'idle' : status, ...(status === 'waiting' ? { background_wait: true } : {}), agent: index % 2 ? 'pi' : 'codex', name: uid + '-agent-' + (index + 1), title: uid + '-agent-' + (index + 1) }));
 const shell = { pane_id: 'w1:shell', workspace_id: 'w1', tab_id: 'w1:t1', terminal_id: 'shell', revision: 1, focused: false, agent_status: 'working', title: 'Ordinary shell' };
 for (const pane of panes) if (liveStatuses.has(uid + ':' + pane.pane_id)) pane.agent_status = liveStatuses.get(uid + ':' + pane.pane_id);
 return { protocol: 22, version: 'fixture', focused_workspace_id: 'w1', focused_tab_id: 'w1:t1', focused_pane_id: 'w1:p1',
  workspaces: [{ workspace_id: 'w1', active_tab_id: 'w1:t1', label: 'Fixture project', number: 1, tab_count: 1, pane_count: 7, focused: true, agent_status: 'working' }],
  tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'Agents', number: 1, pane_count: 7, focused: true, agent_status: 'working' }],
  layouts: [], panes: [...panes, shell], agents: panes };
}
(async () => {
 const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
 const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1700, height: 1050 } });
 await context.addInitScript(() => addEventListener('message', event => {
  if (window.blockPaneSelection && event.data?.type === 'console-select-pane') event.stopImmediatePropagation();
 }));
 await require('./browser-auth.cjs')(context, origin, password);
 secrets.push(...(await context.cookies()).map(cookie => cookie.value));
 if (process.env.WEB_DIST) {
  const path = require('node:path'), dist = path.resolve(process.env.WEB_DIST);
  await context.route(origin + '/', route => route.fulfill({ path: path.join(dist, 'index.html') }));
  await context.route('**/assets/**', route => {
   const file = path.resolve(dist, new URL(route.request().url()).pathname.slice(1));
   assert(file.startsWith(dist + path.sep));
   return route.fulfill({ path: file });
  });
 }
 const htmlResponse = await context.request.get(origin + '/api/console/ui/');
 assert(htmlResponse.ok()); let html = await htmlResponse.text();
 if (process.env.CONSOLE_DIST) {
  const path = require('node:path'), dist = path.resolve(process.env.CONSOLE_DIST);
  html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  await context.route('**/api/console/ui/', route => route.fulfill({ contentType: 'text/html', body: html }));
  await context.route('**/console-assets/**', route => {
   const file = path.resolve(dist, new URL(route.request().url()).pathname.slice('/console-assets/'.length));
   assert(file.startsWith(dist + path.sep));
   return route.fulfill({ path: file });
  });
 }
 let unavailable = true, rosterUnavailable = false, connectFailures = 0, holdConnect = null, holdResume = null, holdPrimary = null;
 const calls = [], inputs = [], errors = [], documents = [];
 await context.route('**/api/console', route => unavailable ? route.fulfill({ status: 503, json: { error: 'Fixture inventory unavailable' } }) : route.fulfill({ json: pool }));
 await context.route('**/api/console/agents/**', async route => {
  const request = route.request(), url = new URL(request.url()), uid = url.pathname.split('/')[5], sandbox = pool.agents.find(item => item.uid === uid);
  calls.push({ method: request.method(), path: url.pathname });
  if (!sandbox) return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Sandbox UID no longer exists' } } });
  if (url.pathname.endsWith('/ui/')) return route.fulfill({ contentType: 'text/html', body: html });
  if (url.pathname.endsWith('/connect')) {
   if (holdConnect) await holdConnect;
   if (connectFailures > 0) { connectFailures--; return route.fulfill({ status: 503, json: { error: 'Bridge is starting' } }); }
   return route.fulfill({ json: { ready: true } });
  }
  if (url.pathname.endsWith('/resume')) {
   if (holdResume) await holdResume;
   sandbox.sandbox = 'RUNNING';
   return route.fulfill({ json: { ready: true } });
  }
  if (url.pathname.endsWith('/bridge/api/session')) return rosterUnavailable ? route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Fixture unavailable' } } }) : route.fulfill({ json: { snapshot: snapshot(uid) } });
  if (url.pathname.endsWith('/session')) {
   if (holdPrimary) await holdPrimary;
   return route.fulfill({ json: { pane_id: 'w1:p1', ready: true, runner: { agent_status: 'idle' } } });
  }
  if (url.pathname.endsWith('/health')) return route.fulfill({ json: { ok: true, herdr: { connected: true, version: '0.9.5', protocol: 22, session: 'fixture' }, auth: { required: false, authenticated: true } } });
  return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not part of this fixture' } } });
 });
 let keepLiveSocket = false, liveSocket;
 await context.routeWebSocket('**/bridge/ws**', socket => {
  socket.onMessage(message => { try { const value = JSON.parse(message); if (['input', 'submit'].includes(value.type)) inputs.push(value.type); if (keepLiveSocket && value.type === 'role') socket.send(JSON.stringify({ type: 'role-ack', mode: value.mode })); } catch {} });
  if (keepLiveSocket && socket.url().includes('/' + a + '/')) { liveSocket = socket; return; }
  socket.close({ code: 1000, reason: 'Snapshot-only fixture' });
 });
 const page = await context.newPage();
 page.on('pageerror', error => errors.push(error.message));
 page.on('request', request => { if (request.isNavigationRequest() && new URL(request.url()).pathname.endsWith('/ui/')) documents.push(new URL(request.url()).pathname); });
 const navigation = page.frameLocator('iframe[title="Superterminal navigation"]');
 const host = id => navigation.locator('[data-host-id="' + id + '"]');
 const uidFor = (host, number) => host + '-sandbox-' + number;
 const branch = uid => navigation.locator('[data-console-sandbox="' + uid + '"]');
 const row = uid => navigation.locator('[data-sandbox-uid="' + uid + '"]');
 const agent = (uid, pane) => branch(uid).locator('[data-agent-pane="' + pane + '"]');
 const shell = () => page.frames().find(frame => new URL(frame.url()).pathname === '/api/console/ui/');
 const native = uid => page.frames().find(frame => new URL(frame.url()).pathname.includes('/' + uid + '/ui/'));
 const waitFor = async (check, message) => { const deadline = Date.now() + 15000; while (!await check()) { assert(Date.now() < deadline, message); await page.waitForTimeout(50); } };
 const command = message => shell().evaluate(message => window.parent.postMessage(message, location.origin), message);
 const state = () => shell().evaluate(() => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('State timeout')), 5000);
  const receive = event => { if (event.origin === location.origin && event.source === parent && event.data?.type === 'console-state') { clearTimeout(timeout); removeEventListener('message', receive); resolve(event.data); } };
  addEventListener('message', receive); parent.postMessage({ type: 'console-ready' }, location.origin);
 }));
 const a = uidFor('agent-box-host', 1), b = uidFor('agent-box-host', 2), suspended = uidFor('agent-box-host', 3);
 try {
  await page.goto(origin + '/#/console');
  await navigation.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  unavailable = false;
  await navigation.getByRole('button', { name: 'Retry', exact: true }).click();
  for (const id of hosts) {
   await host(id).locator('.machine-name').waitFor();
   assert.equal(await host(id).locator('[data-sandbox-uid]').count(), 3);
   assert.equal(await host(id).locator('[data-console-worker="worker-1"] [data-sandbox-uid="' + uidFor(id, 1) + '"]').count(), 1);
   assert.equal(await host(id).getByRole('region', { name: 'Unassigned sandboxes', exact: true }).locator('[data-sandbox-uid="' + uidFor(id, 3) + '"]').count(), 1);
   assert((await host(id).locator('[data-worker-id="worker-1"]').textContent()).includes('ACTIVE · 1 sandbox'));
   assert((await host(id).textContent()).includes('CPU 4/8 · RAM 2Gi/8Gi'));
   assert.equal(await host(id).getByRole('heading', { name: /^(Sandboxes|Agents)$/ }).count(), 0);
   assert.equal(await host(id).getByRole('group', { name: 'Sandboxes', exact: true }).count(), 2);
  }
  await host('agent-box-host').locator('[data-worker-id="worker-1"]').click();
  await row(b).waitFor({ state: 'hidden' }); await row(a).waitFor(); await row(suspended).waitFor();
  await row(uidFor('fixture-host', 2)).waitFor();
  await command({ type: 'console-worker', host: 'fixture-host', worker: 'missing-worker' });
  assert.equal((await state()).worker, 'worker-1');
  await command({ type: 'console-select', host: 'fixture-host', uid: a });
  assert.equal((await state()).uid, '');
  await host('agent-box-host').getByRole('button', { name: 'All workers', exact: true }).click();
  await branch(a).getByRole('button', { name: 'Expand sandbox-1', exact: true }).click();
  await agent(a, 'w1:p1').waitFor();
  assert.equal(await branch(a).locator('[data-agent-pane]').count(), 6, 'Agent list contains a shell or misses a real agent');
  assert.equal(await branch(a).getByRole('list', { name: 'Agents', exact: true }).locator('[data-agent-pane]').count(), 6);
  assert.equal(await navigation.locator('.console-session-frame').count(), 0, 'Expanding metadata attached a terminal');
  for (const theme of ['light', 'dark']) {
   await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
   await navigation.locator('html[data-theme="' + theme + '"]').waitFor();
   for (const [index, status] of states.entries()) {
    const badge = agent(a, 'w1:p' + (index + 1)).locator('.sidebar-status');
    assert.equal(await badge.getAttribute('data-status'), status);
    assert(await badge.evaluate((node, status) => {
     const token = status === 'done' ? '--status-done' : status === 'blocked' ? '--status-blocked' : status === 'waiting' ? '--status-working' : '--text-dim';
     const sample = document.createElement('span'); sample.style.color = `var(${token})`; node.append(sample);
     const expected = getComputedStyle(sample).color; sample.remove();
     const glyph = node.querySelector('svg'), dot = node.querySelector('.sidebar-status-dot'), mark = node.querySelector('.sidebar-status-mark');
     return getComputedStyle(node).color === expected && Boolean(node.getAttribute('aria-label')) &&
      (status === 'working' ? glyph && getComputedStyle(glyph).animationName !== 'none' :
       status === 'waiting' ? glyph && getComputedStyle(glyph).animationName === 'none' :
       status === 'done' ? dot && !glyph : status === 'blocked' ? mark?.textContent === '?' : !glyph && !dot && !mark);
    }, status), 'Native Herdr status appearance or working animation was lost');
   }
   await page.screenshot({ path: '/work/evidence/console-tree-' + theme + '.png' });
  }
  console.log('PASS Worker → Sandbox → actual Agents hierarchy and native Herdr status indicators');
  let releaseConnect, releasePrimary;
  holdConnect = new Promise(resolve => { releaseConnect = resolve; });
  holdPrimary = new Promise(resolve => { releasePrimary = resolve; });
  connectFailures = 2;
  await agent(a, 'w1:p2').click();
  await waitFor(async () => (await state()).pending, 'Connect was not marked pending');
  assert.equal(calls.filter(call => call.path.includes('/' + a + '/') && call.path.endsWith('/session') && !call.path.includes('/bridge/')).length, 0, 'Primary selection was probed before the bridge connected');
  assert.equal(await native(a).locator('.chat-transcript, textarea').count(), 0, 'Native app mounted before the bridge was ready');
  releaseConnect(); holdConnect = null;
  await waitFor(async () => calls.filter(call => call.path.includes('/' + a + '/') && call.path.endsWith('/connect')).length === 3, 'Transient Connect failure was not retried');
  await waitFor(async () => calls.some(call => call.path.includes('/' + a + '/') && call.path.endsWith('/session') && !call.path.includes('/bridge/')), 'Primary selection was not initialized after Connect');
  assert.equal(await native(a).locator('.chat-transcript, textarea').count(), 0, 'Native app mounted before the primary selection completed');
  releasePrimary(); holdPrimary = null;
  await waitFor(() => agent(a, 'w1:p2').getAttribute('aria-pressed').then(value => value === 'true'), 'Native agent selection was not acknowledged');
  assert.equal(await navigation.getByText('Open this sandbox to connect its agents.', { exact: true }).count(), 0);
  assert.equal((await state()).connectionError, '');
  await native(a).evaluate(() => { window.blockPaneSelection = true; });
  await agent(a, 'w1:p3').click();
  await native(a).evaluate(uid => parent.postMessage({ type: 'console-pane-state', uid, pane: null, panes: [], agents: null }, location.origin), a);
  await state();
  assert.equal(await navigation.getByText('This agent is no longer available. Select another agent.', { exact: true }).count(), 0, 'A disconnected roster declared an agent deleted');
  await native(a).evaluate(() => { window.blockPaneSelection = false; });
  const roster = snapshot(a).agents.map(pane => ({ pane: pane.pane_id, name: pane.name, kind: pane.agent, status: pane.agent_status }));
  await native(a).evaluate(message => parent.postMessage(message, location.origin), { type: 'console-pane-state', uid: a, pane: 'w1:p2', panes: roster.map(agent => agent.pane), agents: roster });
  await waitFor(() => agent(a, 'w1:p3').getAttribute('aria-pressed').then(value => value === 'true'), 'A disconnected roster lost the requested agent');
  await agent(a, 'w1:p2').click();
  await waitFor(() => agent(a, 'w1:p2').getAttribute('aria-pressed').then(value => value === 'true'), 'Selection did not recover');
  console.log('PASS delayed bridge and primary initialization, transient Connect retries and disconnected roster recovery');
  for (const theme of ['light', 'dark']) {
   await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
   await navigation.locator('html[data-theme="' + theme + '"]').waitFor();
   await page.mouse.move(1690, 1040);
   await waitFor(() => agent(a, 'w1:p2').evaluate(node => {
    const sample = document.createElement('span'); sample.style.backgroundColor = 'var(--side-selected)'; node.append(sample);
    const expected = getComputedStyle(sample).backgroundColor; sample.remove();
    return getComputedStyle(node).backgroundColor === expected;
   }), 'Selected agent did not settle to the native theme color');
   assert(await branch(a).evaluate(node => {
    const header = node.querySelector('.console-sandbox-header'), selected = node.querySelector('.console-agent[aria-pressed="true"]');
    const first = node.querySelector('.console-agent'), other = node.querySelector('.console-agent[aria-pressed="false"]');
    const headerStyle = getComputedStyle(header), selectedStyle = getComputedStyle(selected);
    return header.classList.contains('is-current') && headerStyle.boxShadow !== 'none' &&
     headerStyle.backgroundColor === 'rgba(0, 0, 0, 0)' && selectedStyle.backgroundColor !== headerStyle.backgroundColor &&
     selectedStyle.backgroundColor !== getComputedStyle(other).backgroundColor &&
     first.getBoundingClientRect().top > header.getBoundingClientRect().bottom &&
     first.getBoundingClientRect().left > header.getBoundingClientRect().left;
   }), 'Sandbox context and selected agent merge in the ' + theme + ' theme');
   assert.equal(await navigation.locator('.console-agent[aria-pressed="true"]').count(), 1);
   await page.screenshot({ path: '/work/evidence/console-selection-' + theme + '.png' });
  }
  await branch(a).getByRole('button', { name: 'Collapse sandbox-1', exact: true }).click();
  assert(await branch(a).locator('.console-sandbox-header').evaluate(node => node.classList.contains('is-current') && getComputedStyle(node).boxShadow !== 'none'));
  await branch(a).getByRole('button', { name: 'Expand sandbox-1', exact: true }).click();
  await agent(a, 'w1:p2').waitFor();
  console.log('PASS distinct sandbox context and selected agent, spacing, indentation and collapsed context in both themes');
  await shell().evaluate(() => { window.savedSidebar = document.querySelector('.console-host-list'); window.savedSession = document.querySelector('.console-session-frame'); });
  const loads = documents.length, connections = calls.filter(call => call.path.endsWith('/connect')).length;
  await agent(a, 'w1:p1').click();
  await waitFor(() => agent(a, 'w1:p1').getAttribute('aria-pressed').then(value => value === 'true'), 'Second native agent selection missing');
  assert.equal(documents.length, loads, 'Agent switching reloaded a document');
  assert.equal(calls.filter(call => call.path.endsWith('/connect')).length, connections, 'Agent switching reconnected the sandbox');
  assert(await shell().evaluate(() => window.savedSidebar === document.querySelector('.console-host-list') && window.savedSession === document.querySelector('.console-session-frame')), 'Agent switch replaced navigation or session iframe');
  await native(a).evaluate(() => localStorage.setItem('fixture-agent-draft', 'sandbox-a-draft'));
  await branch(b).getByRole('button', { name: 'Expand sandbox-2', exact: true }).click();
  await agent(b, 'w1:p2').click();
  await waitFor(() => agent(b, 'w1:p2').getAttribute('aria-pressed').then(value => value === 'true'), 'Repeated pane ID selected another sandbox');
  assert.equal(await native(b).evaluate(() => localStorage.getItem('fixture-agent-draft')), null);
  await native(b).evaluate(() => localStorage.setItem('fixture-agent-draft', 'sandbox-b-draft'));
  await agent(a, 'w1:p1').click();
  await waitFor(() => agent(a, 'w1:p1').getAttribute('aria-pressed').then(value => value === 'true'), 'Sandbox A selection missing');
  assert.equal(await native(a).evaluate(() => localStorage.getItem('fixture-agent-draft')), 'sandbox-a-draft');
  await agent(a, 'w1:p2').click();
  await agent(b, 'w1:p1').click();
  await agent(a, 'w1:p2').click();
  await waitFor(() => agent(a, 'w1:p2').getAttribute('aria-pressed').then(value => value === 'true'), 'Rapid switching lost the last requested agent');
  await agent(a, 'w1:p1').click();
  await waitFor(() => agent(a, 'w1:p1').getAttribute('aria-pressed').then(value => value === 'true'), 'Final native selection missing');
  await shell().evaluate(uid => document.querySelector('.console-session-frame').contentWindow.postMessage({ type: 'console-select-pane', uid: 'wrong-uid', pane: 'w1:p2' }, location.origin), a);
  await state(); assert.equal(await agent(a, 'w1:p1').getAttribute('aria-pressed'), 'true');
  const publish = async (status, uid = a) => {
   const agents = snapshot(a).panes.filter(pane => pane.agent).map(pane => ({ pane: pane.pane_id, name: pane.name, kind: pane.agent, status: pane.pane_id === 'w1:p1' ? status : pane.agent_status }));
   await native(a).evaluate(message => parent.postMessage(message, location.origin), { type: 'console-pane-state', uid, pane: 'w1:p1', panes: agents.map(agent => agent.pane), agents });
  };
  await publish('done', 'wrong-uid');
  await state(); assert.equal(await agent(a, 'w1:p1').locator('.sidebar-status').getAttribute('data-status'), 'working');
  keepLiveSocket = true;
  await native(a).evaluate(() => location.reload());
  await waitFor(async () => Boolean(liveSocket), 'Native fixture WebSocket did not connect');
  await native(a).locator('.conn-live').waitFor();
  const statusLoads = documents.length;
  const push = (pane, status) => {
   liveStatuses.set(a + ':' + pane, status);
   liveSocket.send(JSON.stringify({ type: 'pane-status', pane_id: pane, agent_status: status }));
  };
  for (const status of ['done', 'working', 'blocked', 'idle', 'working', 'done']) {
   push('w1:p1', status);
   await agent(a, 'w1:p1').locator(`.sidebar-status[data-status="${status}"]`).waitFor({ timeout: 1000 });
  }
  push('w1:p2', 'working');
  await agent(a, 'w1:p2').locator('.sidebar-status[data-status="working"]').waitFor({ timeout: 1000 });
  rosterUnavailable = true;
  const polls = () => calls.filter(call => call.path.includes('/' + b + '/') && call.path.endsWith('/bridge/api/session')).length;
  const pollCount = polls();
  push('w1:p1', 'working');
  await waitFor(async () => polls() > pollCount, 'Background sandbox polling stopped');
  assert.equal(await agent(a, 'w1:p1').locator('.sidebar-status').getAttribute('data-status'), 'working', 'Polling overwrote the live native status');
  rosterUnavailable = false;
  keepLiveSocket = false; liveSocket.close({ code: 1000, reason: 'Disconnect fixture' });
  liveStatuses.set(a + ':w1:p2', 'blocked');
  await agent(a, 'w1:p2').locator('.sidebar-status[data-status="blocked"]').waitFor({ timeout: 2000 });
  assert.equal(documents.length, statusLoads, 'Status changes reloaded the native document');
  console.log('PASS live status transitions without polling delay, wrong-UID rejection and stale-poll protection');
  console.log('PASS native pane selection, same iframe, repeated pane IDs, UID-isolated state and wrong-UID rejection');
  await row(suspended).click();
  await navigation.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  assert.equal(await navigation.locator('.chat-transcript, textarea').count(), 0);
  assert.equal(await branch(suspended).locator('[data-agent-pane]').count(), 0, 'Suspended sandbox exposed live agents');
  assert.equal(await navigation.locator('.console-agent[aria-pressed="true"]').count(), 0, "Suspended sandbox left another agent selected");
  assert(await branch(suspended).locator('.console-sandbox-header').evaluate(node => node.classList.contains('is-current') && getComputedStyle(node).boxShadow !== 'none'), 'Suspended sandbox lost its current context');
  assert.equal(await navigation.locator('.console-session-frame').count(), 0);
  assert.equal(calls.filter(call => call.path.endsWith('/resume')).length, 0, 'Selecting a suspended sandbox resumed it');
  let releaseResume;
  holdResume = new Promise(resolve => { releaseResume = resolve; });
  await shell().evaluate(message => { parent.postMessage(message, location.origin); parent.postMessage(message, location.origin); }, { type: 'console-resume', host: 'agent-box-host', uid: suspended });
  await waitFor(async () => calls.filter(call => call.path.endsWith('/resume')).length === 1, 'Explicit Resume was not sent');
  await row(a).click();
  await waitFor(async () => (await state()).connectedUID === a, 'Another sandbox could not connect during Resume');
  await row(suspended).click();
  await waitFor(async () => (await state()).pending, 'Returning to an in-flight Resume lost its pending state');
  releaseResume(); holdResume = null;
  await waitFor(async () => { const current = await state(); return current.connectedUID === suspended && !current.pending && current.pool.agents.find(agent => agent.uid === suspended).sandbox === 'RUNNING'; }, 'Resume did not converge to the connected running session');
  assert.equal(calls.filter(call => call.path.endsWith('/resume')).length, 1, 'A duplicate Resume was sent');
  console.log('PASS duplicate Resume suppression and sandbox switching during an in-flight Resume');
  pool.agents.find(agent => agent.uid === suspended).sandbox = 'SUSPENDED';
  await command({ type: 'console-retry' });
  await navigation.getByRole('button', { name: 'Resume', exact: true }).waitFor();
  await host('fixture-host').getByRole('button', { name: 'Collapse fixture-host', exact: true }).click();
  await page.reload();
  await host('fixture-host').getByRole('button', { name: 'Expand fixture-host', exact: true }).waitFor();
  await row(suspended).waitFor();
  await page.setViewportSize({ width: 600, height: 900 });
  await navigation.getByRole('button', { name: 'Open navigation', exact: true }).click();
  assert(await navigation.locator('.console-host-list').evaluate(node => node.scrollWidth <= node.clientWidth), 'Hierarchy overflows mobile sidebar');
  await page.screenshot({ path: '/work/evidence/console-tree-mobile.png' });
  assert.deepEqual(inputs, [], 'Navigation sent task input');
  assert.deepEqual(errors, []);
  fs.writeFileSync('/work/evidence/console-hosts.json', JSON.stringify({ image, origin, fixture_hosts: 2, host_hierarchy: true, worker_sandbox_agents: true, compact_tree_labels: true, accessible_tree_groups: true, actual_agent_roster: true, shell_excluded: true, native_pane_selection: true, distinct_sandbox_context_and_session_selection: true, selection_spacing_and_indentation: true, selection_light_dark: true, collapsed_and_suspended_context: true, same_sandbox_no_reload: true, repeated_pane_ids: true, rapid_switching: true, uid_isolation: true, host_filter_isolation: true, suspended_ownership: true, explicit_resume: true, no_implicit_resume: true, no_task_input: true, native_status_badges: true, native_working_animation: true, live_status_updates: true, stale_poll_does_not_override_live_status: true, status_light_dark: true, status_labels: true, collapse_persistence: true, mobile_drawer: true, startup_retry: true, primary_initialized_after_bridge: true, transient_connect_retry: true, disconnected_roster_preserves_target: true, duplicate_resume_suppressed: true, resume_survives_switching: true, browser_errors: errors }, null, 2) + '\n');
  console.log('PASS suspended placeholder, host ownership/collapse, mobile hierarchy and no task input');
 } catch (error) {
  error.message += '\nBrowser errors: ' + JSON.stringify(errors);
  throw error;
 } finally {
  await context.request.post(origin + '/api/auth/logout', { headers: { Origin: origin } }).catch(() => {});
  await context.close(); await browser.close();
 }
})().catch(error => {
 let message = String(error.stack || error);
 for (const secret of secrets) message = message.split(secret).join('[REDACTED]');
 console.error(message); process.exit(1);
});

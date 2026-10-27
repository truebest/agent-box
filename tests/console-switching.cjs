const { chromium } = require('/work/browser/node_modules/playwright-core');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const origin = process.env.AGENT_URL || 'https://192.0.2.10:18443';
const image = JSON.parse(fs.readFileSync('/work/evidence/console-candidate.json', 'utf8')).image;
const password = fs.readFileSync('/run/panel-password', 'utf8').trim();

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1700, height: 1050 }, colorScheme: "dark" });
  const runtimePath = require('./runtime-path.cjs')(async name => {
    const response = await context.request.get(origin + '/api/agents/' + encodeURIComponent(name));
    assert(response.ok(), `Sandbox lookup failed: HTTP ${response.status()}`);
    return response.json();
  });
  await require('./browser-auth.cjs')(context, origin, password);
  await context.addInitScript(() => {
    if (window !== window.top) return;
    window.consolePaint = { samples: 0, visibleBeforeReady: 0 };
    const sample = () => {
      const frame = document.querySelector(window === window.top ? 'iframe[title="Superterminal navigation"]' : 'iframe.console-session-frame');
      if (frame) {
        window.consolePaint.samples++;
        if (!frame.dataset.ready && Number(getComputedStyle(frame).opacity) > 0 && getComputedStyle(frame).visibility !== 'hidden') window.consolePaint.visibleBeforeReady++;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  const page = await context.newPage(), documents = [], errors = [], inputs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame().parentFrame() && new URL(request.url()).pathname.endsWith('/ui/')) documents.push(new URL(request.url()).pathname);
  });
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    try { const message = JSON.parse(payload); if (['submit', 'input'].includes(message.type)) inputs.push({ type: message.type, hex: Buffer.from(message.data || message.input || message.text || '').toString('hex') }); } catch {}
  }));
  const api = async (method, path, data) => {
      path = await runtimePath(path);
    const response = await context.request.fetch(origin + path, { method, data, headers: { Origin: origin } });
    assert(response.ok(), `HTTP ${response.status()} for ${path}`); return runtimePath.observe(await response.json());
  };
  const waitFor = async (check, message) => {
    const deadline = Date.now() + 30000;
    while (!await check()) { assert(Date.now() < deadline, message); await page.waitForTimeout(50); }
  };
  const frameFor = agent => page.frames().find(frame => frame.url().includes(`/${agent.uid}/ui/`));
  const open = async agent => {
    const frame = page.frameLocator('iframe').frameLocator(`iframe[title="${agent.name} Superterminal"]`);
    await frame.locator('.conn-live').waitFor({ state: 'attached', timeout: 180000 });
    await frame.getByRole('button', { name: 'Chat', exact: true }).click();
    await frame.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
    return frame;
  };
  const select = async agent => {
    const frame = page.frameLocator('iframe');
    await frame.locator(`[data-host-id="${agent.host}"]`).getByRole('button', { name: 'All workers', exact: true }).click();
    await frame.locator(`[data-sandbox-uid="${agent.uid}"]`).click();
  };
  const identity = async agent => {
    const session = await api('GET', `/api/agents/${agent.name}/session`);
    const result = await api('POST', `/api/agents/${agent.name}/exec`, { argv: ['herdr', 'pane', 'process-info', '--pane', session.pane_id] });
    assert.equal(result.exit_code, 0);
    const process = JSON.parse(result.output).result.process_info;
    return { conversation: session.runner.agent_session, pane: session.pane_id, shell: process.shell_pid, foreground: process.foreground_process_group_id };
  };
  let releaseSelection, releaseConnect;
  const selectionGate = new Promise(resolve => { releaseSelection = resolve; });
  const connectGate = new Promise(resolve => { releaseConnect = resolve; });
  try {
    const pool = await api('GET', '/api/console');
    const agents = ['50418b1c-7d03-4add-9168-a239b8dca735', '7a990c59-6506-41c4-a824-a266c02560ed'].map(uid => pool.agents.find(agent => agent.uid === uid && agent.sandbox === 'RUNNING'));
    assert(agents.every(Boolean), 'The recorded read-only test sandboxes must already be running');
    const [one, two] = agents, before = await Promise.all(agents.map(identity));
    await page.goto(origin + `/#/console?uid=${one.uid}`);
    let frame = await open(one);
    assert.equal(documents.length, 2, `Initial selection loaded ${documents.length} iframe documents`);
    const shell = page.frames().find(frame => frame.url().endsWith('/api/console/ui/'));
    await shell.evaluate(() => {
      window.consolePaint = { samples: 0, visibleBeforeReady: 0 };
      const sample = () => {
        const frame = document.querySelector('iframe.console-session-frame');
        if (frame) {
          window.consolePaint.samples++;
          if (!frame.dataset.ready && getComputedStyle(frame).visibility !== 'hidden') window.consolePaint.visibleBeforeReady++;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      window.navigationNode = document.querySelector('.console-host-list');
      window.navigationUID = crypto.randomUUID();
      window.navigationRemovals = 0;
      new MutationObserver(records => { for (const record of records) for (const node of record.removedNodes) if (node === window.navigationNode || node.contains?.(window.navigationNode)) window.navigationRemovals++; }).observe(document.body, { childList: true, subtree: true });
    });
    await waitFor(async () => await frameFor(one).evaluate(() => document.documentElement.dataset.theme === 'light') && await shell.evaluate(() => document.documentElement.dataset.theme === 'light'), 'System did not follow the light panel while the OS was dark');
    const navigationUID = await shell.evaluate(() => window.navigationUID);
    await page.frameLocator('iframe').getByRole('separator', { name: 'Resize sidebar' }).press('ArrowRight');
    const sidebarWidth = await shell.locator('.sidebar').evaluate(element => element.getBoundingClientRect().width);
    const stableNavigation = async () => {
      assert.equal(await shell.evaluate(() => window.navigationUID), navigationUID, 'Navigation document was reloaded');
      assert(await shell.evaluate(() => window.navigationNode === document.querySelector('.console-host-list') && window.navigationRemovals === 0), 'Sidebar was replaced');
      assert.equal(await shell.locator('.sidebar').evaluate(element => element.getBoundingClientRect().width), sidebarWidth, 'Sidebar width was reset');
      assert.equal(documents.filter(path => path === '/api/console/ui/').length, 1, 'Navigation document reloaded during selection');
    };
    await frame.getByRole('textbox', { name: 'Message', exact: true }).fill('Unsent switching test draft A');
    let selectionHeld = false, connectHeld = false;
    const target = `/api/console/agents/${two.name}/${two.uid}`;
    await context.route(origin + target + '/session', async route => { const response = await route.fetch(); selectionHeld = true; await selectionGate; await route.fulfill({ response }); });
    await context.route(origin + target + '/connect', async route => { const response = await route.fetch(); connectHeld = true; await connectGate; await route.fulfill({ response }); });
    const firstSwitch = documents.length;
    await select(two);
    await waitFor(() => connectHeld, 'Connect request was not intercepted');
    assert.equal(selectionHeld, false, 'Primary-selection probe started before connection readiness');
    await page.frameLocator('iframe').locator(`iframe[title="${two.name} Superterminal"][data-ready]`).waitFor();
    await waitFor(() => page.locator('iframe').evaluate(element => getComputedStyle(element).opacity === '1'), 'Prepared document remained hidden');
    assert.equal(documents.length - firstSwitch, 1, 'Switch loaded an intermediate shell document');
    assert.equal(await frameFor(two).locator('.conn-live').count(), 0, 'Native app mounted before bridge readiness');
    assert.equal(await frameFor(two).getByRole('textbox', { name: 'Message', exact: true }).count(), 0, 'Native app mounted before selection initialization');
    await stableNavigation();
    releaseConnect();
    await waitFor(() => selectionHeld, 'Primary-selection probe did not start after connection readiness');
    assert.equal(await frameFor(two).locator('.conn-live').count(), 0, 'Native app ignored the selection gate');
    releaseSelection();
    await waitFor(() => frameFor(two).evaluate(() => localStorage.getItem('herdr-web-ui:selection') !== null), 'Primary pane selection was not initialized');
    frame = await open(two);
    await frame.getByRole('textbox', { name: 'Message', exact: true }).fill('Unsent switching test draft B');
    for (const [agent, draft] of [[one, 'Unsent switching test draft A'], [two, 'Unsent switching test draft B']]) {
      const count = documents.length;
      await select(agent); frame = await open(agent);
      await stableNavigation();
      assert.equal(documents.length - count, 1, 'A return switch loaded more than one document');
      assert.equal(await frame.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), draft, 'Draft crossed sandbox UID boundaries');
    }
    const native = frameFor(two);
    await page.frameLocator('iframe').getByRole('button', { name: 'Settings', exact: true }).click();
    await frame.getByRole('group', { name: 'Theme', exact: true }).getByRole('button', { name: 'System', exact: true }).click();
    await frame.getByRole('combobox', { name: 'Colors', exact: true }).selectOption('forest');
    await frame.getByRole('button', { name: 'Close settings', exact: true }).click();
    await waitFor(async () => {
      const appearance = await native.evaluate(() => ({ background: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color, scheme: getComputedStyle(document.documentElement).colorScheme }));
      const surface = await page.locator('.superterminal-surface').evaluate(element => ({ background: getComputedStyle(element).backgroundColor, color: getComputedStyle(element).color, scheme: getComputedStyle(element).colorScheme }));
      return JSON.stringify(appearance) === JSON.stringify(surface);
    }, 'Loading surface did not follow native theme/palette');
    await frame.getByRole('button', { name: 'Terminal', exact: true }).click();
    await frame.locator('.xterm-viewport').waitFor({ state: 'attached' });
    await native.evaluate(() => { window.themeTerminal = document.querySelector('.xterm-viewport'); });
    const themeDocuments = documents.length, terminalThemes = [];
    for (const [panelTheme, expected] of [['dark', 'dark'], ['cupcake', 'light'], ['synthwave', 'dark'], ['light', 'light']]) {
      await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(panelTheme);
      await waitFor(async () => await native.evaluate(expected => document.documentElement.dataset.theme === expected, expected) && await shell.evaluate(expected => document.documentElement.dataset.theme === expected, expected), 'System did not follow panel theme ' + panelTheme);
      await waitFor(() => native.evaluate(() => getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor === getComputedStyle(document.querySelector('.terminal-host')).backgroundColor), 'xterm background did not follow the native light/dark tokens');
      terminalThemes.push(await native.evaluate(() => ({ theme: document.documentElement.dataset.theme, background: getComputedStyle(document.querySelector('.xterm-viewport')).backgroundColor })));
      assert(await native.evaluate(() => window.themeTerminal === document.querySelector('.xterm-viewport')), 'A theme change recreated the terminal');
    }
    assert.equal(documents.length, themeDocuments, 'A theme change navigated an iframe');
    await page.frameLocator('iframe').getByRole('button', { name: 'Settings', exact: true }).click();
    const theme = frame.getByRole('group', { name: 'Theme', exact: true });
    assert.equal(await theme.getByRole('button', { name: 'System', exact: true }).getAttribute('aria-pressed'), 'true', 'Following the panel replaced the stored System preference');
    await theme.getByRole('button', { name: 'Dark', exact: true }).click();
    await waitFor(() => native.evaluate(() => document.documentElement.dataset.theme === 'dark'), 'Manual dark override failed');
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('cupcake');
    await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption('light');
    assert.equal(await native.evaluate(() => document.documentElement.dataset.theme), 'dark', 'Panel theme replaced a manual native choice');
    await theme.getByRole('button', { name: 'System', exact: true }).click();
    await waitFor(() => native.evaluate(() => document.documentElement.dataset.theme === 'light'), 'Returning to System did not adopt the light panel');
    await frame.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Terminal', exact: true }).click();
    await frame.getByRole('button', { name: 'Increase terminal font size', exact: true }).click();
    await frame.getByRole('button', { name: 'Close settings', exact: true }).click();
    const sharedSettings = await native.evaluate(() => JSON.parse(localStorage.getItem('herdr-web-ui:settings')));
    assert(sharedSettings.terminalFontSize > 13 && sharedSettings.theme === 'system' && sharedSettings.palette === 'forest');
    await waitFor(async () => JSON.stringify(await shell.evaluate(() => JSON.parse(localStorage.getItem('herdr-web-ui:settings')))) === JSON.stringify(sharedSettings), 'Settings did not propagate to the permanent shell');
    await select(one); frame = await open(one);
    assert.deepEqual(await frameFor(one).evaluate(() => JSON.parse(localStorage.getItem('herdr-web-ui:settings'))), sharedSettings, 'Settings were scoped to the sandbox');
    assert.equal(await frame.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Unsent switching test draft A');
    await select(two); frame = await open(two);
    const rapidSwitch = documents.length;
    const navigating = page.waitForRequest(request => request.isNavigationRequest() && new URL(request.url()).pathname.endsWith(`/${one.uid}/ui/`));
    await page.evaluate(uid => { location.hash = `/console?uid=${uid}`; }, one.uid);
    await navigating;
    await page.evaluate(uid => { location.hash = `/console?uid=${uid}`; }, two.uid);
    await open(two);
    assert(documents.slice(rapidSwitch).every(path => path !== '/api/console/ui/'), 'Rapid switches navigated through the generic shell');
    assert.equal(await page.frameLocator('iframe').frameLocator('iframe').getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'Unsent switching test draft B');
    await stableNavigation();
    await frame.getByRole('button', { name: 'Hide navigation', exact: true }).click();
    await shell.locator('.sidebar').waitFor({ state: 'hidden' });
    await frame.getByRole('button', { name: 'Show navigation', exact: true }).click();
    await shell.locator('.sidebar').waitFor({ state: 'visible' });
    await page.setViewportSize({ width: 1000, height: 900 });
    await frame.getByRole('button', { name: 'Hide navigation', exact: true }).click();
    await shell.locator('.sidebar').waitFor({ state: 'hidden' });
    await frame.getByRole('button', { name: 'Show navigation', exact: true }).click();
    await shell.locator('.sidebar').waitFor({ state: 'visible' });
    await page.setViewportSize({ width: 600, height: 900 });
    const mobile = page.frameLocator('iframe').frameLocator('iframe');
    await mobile.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await shell.locator('.sidebar.is-open').waitFor({ state: 'visible' });
    await page.frameLocator('iframe').locator(`[data-sandbox-uid="${one.uid}"]`).click();
    await open(one);
    assert.equal(await shell.locator('.sidebar.is-open').count(), 0, 'Mobile drawer stayed open after sandbox selection');
    await page.setViewportSize({ width: 1700, height: 1050 });
    await stableNavigation();
    const paint = await page.evaluate(() => window.consolePaint);
    const sessionPaint = await shell.evaluate(() => window.consolePaint);
    assert(sessionPaint.samples > 0 && sessionPaint.visibleBeforeReady === 0, 'An unprepared session was visible');
    assert(paint.samples > 0 && paint.visibleBeforeReady === 0, 'An unprepared iframe was visible');
    assert.deepEqual(await Promise.all(agents.map(identity)), before, 'Switching changed a runner or conversation');
    const terminalReplies = new Set(['1b5b3f313031363b322479', '1b5b3f313b3263']);
    assert(inputs.every(message => message.type === 'input' && terminalReplies.has(message.hex)), 'Switching sent task input');
    assert.deepEqual(errors, []);
    fs.writeFileSync('/work/evidence/console-switching.json', JSON.stringify({ image, persistent_navigation: true, sidebar_identity_preserved: true, sidebar_width_preserved: true, mobile_session_navigation: true, settings_forwarding: true, single_document_per_selection: true, early_shell_paint: true, bridge_and_selection_gating: true, drafts_isolated: true, rapid_switch: true, appearance_sync: true, global_settings: true, system_follows_panel: true, native_manual_theme: true, terminal_theme: true, theme_change_no_reload: true, terminalThemes, no_task_input: true, identities_preserved: true, paint, sessionPaint, documents: documents.length, browser_errors: errors }, null, 2) + '\n');
    console.log('PASS global settings, System/panel/xterm themes, persistent sidebar, one right-hand document per sandbox, early themed shell, connection gating, rapid switches, isolated drafts and preserved runners');
  } catch (error) {
    fs.writeFileSync('/work/evidence/console-switching-failure.json', JSON.stringify({ image, documents, paint: await page.evaluate(() => window.consolePaint).catch(() => null), error: error.message }, null, 2) + '\n');
    throw error;
  } finally { releaseSelection(); releaseConnect(); await context.close(); await browser.close(); }
})().catch(error => { console.error(error.stack); process.exit(1); });

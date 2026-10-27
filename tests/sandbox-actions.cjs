const browserName = process.env.BROWSER || 'chromium';
const browserType = require(process.env.PLAYWRIGHT_MODULE || '/work/browser/node_modules/playwright-core')[browserName];
const assert = require('node:assert/strict');
const origin = process.env.AGENT_URL || 'http://127.0.0.1:18765';

(async () => {
  const browser = await browserType.launch({ headless: true, ...(browserName === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage(), errors = [], operations = [];
  let failResume = false, failList = false, authenticated = true, listCalls = 0;
  let releaseResume, releaseRefresh, releaseFiles, releaseUpload, releasePrompt, releaseLogin;
  const actors = ['running', 'empty', 'suspended', 'crashed', 'unsaved', 'starting'].map((kind, index) => ({
    metadata: { name: `fixture-${kind}`, uid: `uid-${kind}`, createTime: new Date(2026, 9, 17, 12, index).toISOString() },
    actorTemplate: { name: 'sandbox-v1-fixture' },
    status: { state: `ACTOR_STATE_${kind === 'empty' ? 'RUNNING' : kind === 'unsaved' ? 'CRASHED' : kind.toUpperCase()}`,
      snapshots: ['suspended', 'crashed'].includes(kind) ? [{ durableSnapshot: { status: 'SNAPSHOT_STORAGE_STATUS_COMPLETED' } }] : [] },
  }));
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (path === '/api/auth/session') return json({ authenticated, expires_at: new Date(Date.now() + 3600000).toISOString() });
    if (path === '/api/auth/logout') return json({}, 503);
    if (path === '/api/auth/login') {
      await new Promise(resolve => { releaseLogin = resolve });
      return json({}, 401);
    }
    if (path === '/api/console') return json({ enabled: false });
    if (path === '/api/console/ui/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Console fixture</title>' });
    if (path === '/api/agents') {
      listCalls++;
      if (releaseRefresh) await new Promise(resolve => { releaseRefresh = resolve });
      if (failList) return json({ error: 'Synthetic inventory failure' }, 503);
      return json({ actors });
    }
    if (path.endsWith('/session')) return json({ kind: path.includes('empty') ? 'none' : 'codex', ready: !path.includes('empty'), runner: { agent_status: 'idle' }, agents: [] });
    if (path.endsWith('/files')) {
      if (request.method() === 'PUT') {
        await new Promise(resolve => { releaseUpload = resolve });
        return json({ error: 'Synthetic upload failure. ' + 'Details '.repeat(40) }, 503);
      }
      if (releaseFiles) await new Promise(resolve => { releaseFiles = resolve });
      return json({ path: '/workspace', entries: [] });
    }
    if (path.endsWith('/prompt')) {
      await new Promise(resolve => { releasePrompt = resolve });
      return json({ error: 'Synthetic delivery failure' }, 503);
    }
    const [, name, operation] = path.match(/^\/api\/agents\/([^/]+)(?:\/(resume|suspend|revert))?$/) || [];
    if (name && request.method() !== 'GET') {
      assert.equal(url.searchParams.get('uid'), actors.find(item => item.metadata.name === name).metadata.uid, 'Management operation omitted the sandbox UID');
      operations.push({ name, operation: operation || 'delete' });
      if (operation === 'resume' && failResume) return json({ error: 'Synthetic resume failure. Check status before retrying.' }, 503);
      if (operation === 'resume' && releaseResume) await new Promise(resolve => { releaseResume = resolve });
      const actor = actors.find(item => item.metadata.name === name);
      if (operation) actor.status.state = operation === 'suspend' ? 'ACTOR_STATE_SUSPENDED' : 'ACTOR_STATE_RUNNING';
      else actors.splice(actors.indexOf(actor), 1);
      return json({});
    }
    throw new Error(`Unexpected API request: ${request.method()} ${path}`);
  });
  const row = kind => page.getByRole('row').filter({ hasText: `fixture-${kind}` });
  const trigger = kind => row(kind).getByRole('button', { name: `Manage fixture-${kind}`, exact: true });
  const menu = () => page.getByRole('menu');
  const show = async kind => {
    await trigger(kind).click(); await menu().waitFor();
    assert(await menu().evaluate(element => element.scrollWidth === element.clientWidth), 'Menu items overflow horizontally');
  };
  const home = async () => {
    await page.goto(origin + '/#/sandboxes');
    await row('running').waitFor();
    await page.getByRole('checkbox', { name: 'Auto Refresh', exact: true }).uncheck();
  };
  const waitFor = async check => { const deadline = Date.now() + 10000; while (!await check()) { assert(Date.now() < deadline, 'Fixture did not reach the expected state'); await page.waitForTimeout(20); } };
  const settle = () => page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.race([Promise.all(document.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))), new Promise(resolve => setTimeout(resolve, 500))]);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  try {
    await home();
    assert.equal(await row('running').getByRole('button').count(), 4);
    assert.equal(await row('running').getByRole('button').first().getAttribute('aria-label'), 'Suspend sandbox');
    assert.equal(await row('suspended').getByRole('button').first().getAttribute('aria-label'), 'Resume sandbox');
    assert.equal(await row('running').getByRole('button', { name: 'Open Superterminal', exact: true }).count(), 0);
    assert(await row('running').getByRole('button').evaluateAll(buttons => buttons.every(button => !button.textContent.trim())), 'Row contains a text button');
    await page.evaluate(() => document.fonts.ready);
    const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
    const before = await refresh.boundingBox(), createBefore = await page.getByRole('button', { name: 'Create Sandbox', exact: true }).boundingBox();
    releaseRefresh = true;
    await refresh.click();
    await refresh.locator('.loading').waitFor();
    assert.deepEqual(await refresh.boundingBox(), before, 'Refresh changed size while loading');
    assert.deepEqual(await page.getByRole('button', { name: 'Create Sandbox', exact: true }).boundingBox(), createBefore, 'Refresh moved adjacent controls');
    while (typeof releaseRefresh !== 'function') await page.waitForTimeout(10);
    releaseRefresh(); releaseRefresh = undefined;
    await refresh.locator('.loading').waitFor({ state: 'hidden' });
    await page.getByRole('checkbox', { name: 'Auto Refresh', exact: true }).check();
    await page.getByText('Interval', { exact: true }).locator('..').locator('select').selectOption('2000');
    releaseRefresh = true;
    await waitFor(() => typeof releaseRefresh === 'function');
    assert.equal(await refresh.getAttribute('aria-busy'), 'false', 'Background refresh flashes the manual loading indicator');
    assert.equal(await refresh.locator('.loading').count(), 0);
    releaseRefresh(); releaseRefresh = undefined;
    failList = true;
    await page.getByText('Synthetic inventory failure', { exact: true }).waitFor();
    await page.evaluate(() => { window.savedNotice = document.querySelector('.notifications [role="alert"]'); });
    const previousCalls = listCalls;
    await waitFor(() => listCalls > previousCalls);
    assert(await page.evaluate(() => window.savedNotice === document.querySelector('.notifications [role="alert"]')), 'Repeated background failure remounted the notification');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByText('Unable to sign out. Please try again.', { exact: true }).waitFor();
    assert.equal(await page.locator('.notifications').count(), 1, 'Shell and page created separate notification stacks');
    const notices = await page.locator('.notifications [role="alert"]').evaluateAll(nodes => nodes.map(node => { const { top, bottom } = node.getBoundingClientRect(); return { top, bottom }; }).sort((a, b) => a.top - b.top));
    assert.equal(notices.length, 2); assert(notices[0].bottom < notices[1].top, 'Shell and page notifications overlap');
    failList = false; await page.getByRole('checkbox', { name: 'Auto Refresh', exact: true }).uncheck();
    while (await page.getByRole('button', { name: 'Dismiss notification', exact: true }).count()) await page.getByRole('button', { name: 'Dismiss notification', exact: true }).first().click();
    await show('running');
    await menu().getByRole('menuitem', { name: 'Open Superterminal', exact: true }).click();
    await page.waitForURL('**/#/console?uid=uid-running');
    assert.equal(operations.length, 0, 'Opening a running sandbox must not resume or send a task');
    for (const target of ['Terminal', 'Files']) {
      await home();
      assert.equal(await row('running').getByRole('button', { name: target, exact: true }).getAttribute('title'), target);
      await row('running').getByRole('button', { name: target, exact: true }).click();
      await page.waitForURL(`**/#/${target.toLowerCase()}?sandbox=fixture-running`);
      if (target === 'Terminal') {
        await page.locator('.xterm-screen').waitFor();
        await page.evaluate(() => document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
      }
      const reload = page.getByRole('button', { name: 'Reload Sandboxes', exact: true });
      await reload.waitFor(); await settle();
      const reloadBefore = await reload.boundingBox();
      releaseRefresh = true; await reload.click(); await reload.locator('.loading').waitFor();
      assert.deepEqual(await reload.boundingBox(), reloadBefore, `${target} reload button changed size`);
      await waitFor(() => typeof releaseRefresh === 'function'); releaseRefresh(); releaseRefresh = undefined;
      await reload.locator('.loading').waitFor({ state: 'hidden' });
      if (target === 'Files') {
        const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
        await refresh.waitFor();
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => document.fonts.ready);
        const before = await refresh.boundingBox(), adjacent = await page.getByRole('button', { name: 'New directory', exact: true }).boundingBox();
        releaseFiles = true; await refresh.click(); await refresh.locator('.loading').waitFor();
        assert.deepEqual(await refresh.boundingBox(), before, 'Files Refresh changed size while loading');
        assert.deepEqual(await page.getByRole('button', { name: 'New directory', exact: true }).boundingBox(), adjacent, 'Files Refresh moved adjacent controls');
        while (typeof releaseFiles !== 'function') await page.waitForTimeout(10);
        releaseFiles(); releaseFiles = undefined;
        await refresh.locator('.loading').waitFor({ state: 'hidden' });
        const upload = page.getByRole('button', { name: 'Upload File', exact: true });
        const uploadBefore = await upload.boundingBox(), pathBefore = await page.getByLabel('Path', { exact: true }).boundingBox();
        await page.getByLabel('Upload file', { exact: true }).setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture') });
        await upload.locator('.loading').waitFor();
        assert.deepEqual(await upload.boundingBox(), uploadBefore, 'Upload button changed size');
        await waitFor(() => typeof releaseUpload === 'function'); releaseUpload();
        await page.getByRole('alert').waitFor();
        assert.deepEqual(await page.getByLabel('Path', { exact: true }).boundingBox(), pathBefore, 'File error moved the toolbar');
      }
    }
    console.log('PASS background refresh, stable reload/upload controls and file error notification');
    await home();
    await show('running');
    assert.deepEqual(await menu().getByRole('menuitem').allTextContents(), ['Open Superterminal', 'Send task', 'Suspend', 'Delete sandbox…']);
    await page.keyboard.press('End');
    assert.equal(await page.locator(':focus').textContent(), 'Delete sandbox…');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator(':focus').textContent(), 'Open Superterminal');
    await page.keyboard.press('Escape');
    assert(await trigger('running').evaluate(element => element === document.activeElement));
    await show('running');
    await trigger('running').click();
    await menu().waitFor({ state: 'hidden' });
    await trigger('running').focus();
    await page.keyboard.press('ArrowDown');
    await menu().waitFor();
    await page.keyboard.press('Tab');
    await menu().waitFor({ state: 'hidden' });
    await show('running');
    await page.getByRole('heading', { name: 'Sandbox Management' }).click();
    await menu().waitFor({ state: 'hidden' });
    await show('empty');
    assert.equal(await menu().getByRole('menuitem', { name: 'Send task', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    for (const kind of ['crashed', 'unsaved', 'starting']) {
      assert.equal(await row(kind).getByRole('button', { name: 'Open Superterminal', exact: true }).count(), 0);
      await show(kind);
      assert.deepEqual(await menu().getByRole('menuitem').allTextContents(), kind === 'crashed' ? ['Restore snapshot', 'Delete sandbox…'] : ['Delete sandbox…']);
      if (kind === 'crashed') {
        page.once('dialog', dialog => dialog.dismiss());
        await menu().getByRole('menuitem', { name: 'Restore snapshot' }).click();
        assert.equal(operations.length, 0, 'Cancelled restore must not call the API');
      } else await page.keyboard.press('Escape');
    }
    failResume = true;
    const tableBefore = await page.locator('table').boundingBox();
    await show('suspended');
    await menu().getByRole('menuitem', { name: 'Resume & open', exact: true }).click();
    await page.getByText('Synthetic resume failure. Check status before retrying.', { exact: true }).waitFor();
    assert.deepEqual(await page.locator('table').boundingBox(), tableBefore, 'Resume error moved the table');
    await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
    assert.deepEqual(await page.locator('table').boundingBox(), tableBefore, 'Dismissing an error moved the table');
    assert.equal(new URL(page.url()).hash.split('?')[0], '#/sandboxes');
    assert.equal(operations.length, 1, 'Failed resume was repeated');
    failResume = false; releaseResume = true;
    await show('suspended');
    await menu().getByRole('menuitem', { name: 'Resume & open', exact: true }).click();
    await row('suspended').locator('[aria-busy="true"]').waitFor();
    assert(await trigger('running').isDisabled(), 'A second management operation must wait');
    assert.equal(new URL(page.url()).hash.split('?')[0], '#/sandboxes');
    while (typeof releaseResume !== 'function') await page.waitForTimeout(10);
    releaseResume(); releaseResume = undefined;
    await page.waitForURL('**/#/console?uid=uid-suspended');
    assert.equal(operations.length, 2);
    await home();
    await show('running');
    await menu().getByRole('menuitem', { name: 'Send task', exact: true }).click();
    await page.waitForURL('**/#/tasks?sandbox=fixture-running');
    const taskForm = page.locator('form'), send = page.getByRole('button', { name: 'Send task', exact: true });
    await page.locator('textarea').fill('Fixture only; never sent to a real agent'); await settle();
    const sendBefore = await send.boundingBox(), taskBefore = await taskForm.boundingBox();
    await send.click(); await send.locator('.loading').waitFor();
    assert.deepEqual(await send.boundingBox(), sendBefore, 'Send task changed size');
    await waitFor(() => typeof releasePrompt === 'function'); releasePrompt();
    await page.getByRole('alert').waitFor();
    assert.deepEqual(await taskForm.boundingBox(), taskBefore, 'Delivery error moved the task form');
    await home();
    for (const action of ['Suspend', 'Resume']) {
      const tableBefore = await page.locator('table').boundingBox();
      await row('running').getByRole('button', { name: `${action} sandbox`, exact: true }).click();
      await row('running').getByText(action === 'Suspend' ? 'suspended' : 'running', { exact: true }).waitFor();
      await row('running').getByRole('button', { name: `${action === 'Suspend' ? 'Resume' : 'Suspend'} sandbox`, exact: true }).waitFor();
      await page.getByRole('status').filter({ hasText: 'completed.' }).waitFor();
      assert.deepEqual(await page.locator('table').boundingBox(), tableBefore, `${action} notification moved the table`);
    }
    await show('empty');
    await menu().getByRole('menuitem', { name: 'Delete sandbox…', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Delete Sandbox' });
    await confirmation.waitFor();
    assert.equal(await page.locator(':focus').textContent(), 'Cancel');
    await page.keyboard.press('Escape');
    await confirmation.waitFor({ state: 'hidden' });
    assert.equal(operations.length, 4);
    await show('empty');
    await menu().getByRole('menuitem', { name: 'Delete sandbox…', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
    await row('empty').waitFor({ state: 'detached' });
    assert.equal(operations.at(-1).operation, 'delete');
    for (const theme of ['dark', 'light']) {
      await page.getByLabel('Theme', { exact: true }).selectOption(theme);
      await row('running').getByRole('button', { name: 'Suspend sandbox', exact: true }).click();
      await row('running').getByRole('button', { name: 'Resume sandbox', exact: true }).waitFor();
      await row('running').getByRole('button', { name: 'Resume sandbox', exact: true }).click();
      await row('running').getByRole('button', { name: 'Suspend sandbox', exact: true }).waitFor();
      await show('running');
      const bounds = await menu().boundingBox();
      assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1600 && bounds.y + bounds.height <= 1000);
      if (process.env.ARTIFACT_DIR) await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/sandbox-actions-${theme}.png`, animations: 'disabled', fullPage: true });
      await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await show('running');
    const bounds = await menu().boundingBox();
    if (process.env.ARTIFACT_DIR) await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/sandbox-actions-mobile.png`, animations: 'disabled', fullPage: true });
    assert(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 844, `Menu is clipped on mobile: ${JSON.stringify(bounds)}`);
    await page.setViewportSize({ width: 390, height: 700 });
    await menu().waitFor({ state: 'hidden' });
    const noticeBounds = await page.locator('.notifications [role="status"]').boundingBox();
    assert(noticeBounds.x >= 0 && noticeBounds.x + noticeBounds.width <= 390, 'Notification is clipped on mobile');
    await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
    console.log('PASS notification layout, operation results, themes and mobile placement');
    await page.setViewportSize({ width: 1600, height: 1000 });
    await home();
    await page.getByRole('button', { name: 'Create Sandbox', exact: true }).click();
    const creation = page.getByRole('dialog', { name: 'Create Sandbox' });
    await creation.getByLabel('Agent', { exact: true }).selectOption('none'); await settle();
    await page.evaluate(() => {
      const original = window.fetch;
      window.fetch = (input, options) => String(input).includes('/api/agents?stream=1') ? Promise.resolve(new Response(new ReadableStream({ start(controller) {
        const send = event => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
        send({ stage: 'sandbox', status: 'running' });
        window.finishCreation = () => { send({ type: 'complete', actor: { metadata: { name: 'fixture-created', uid: 'uid-created' } } }); controller.close(); };
      } }), { headers: { 'Content-Type': 'application/x-ndjson' } })) : original(input, options);
    });
    const createButton = creation.getByRole('button', { name: 'Create Sandbox', exact: true });
    const creationButtonBefore = await createButton.boundingBox(), dialogBefore = await creation.locator('.modal-box').boundingBox();
    await createButton.click(); await creation.locator('[data-stage="sandbox"][data-status="running"]').waitFor();
    assert.deepEqual(await createButton.boundingBox(), creationButtonBefore, 'Creation progress moved the submit button');
    assert.deepEqual(await creation.locator('.modal-box').boundingBox(), dialogBefore, 'Creation progress resized the dialog');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await createButton.locator('.loading').evaluate(node => getComputedStyle(node).animationName), 'none');
    await page.evaluate(() => window.finishCreation()); await creation.waitFor({ state: 'hidden' });
    console.log('PASS stable creation progress and reduced motion');
    authenticated = false; await page.reload();
    await page.getByLabel('Username', { exact: true }).fill('fixture-user');
    await page.getByLabel('Password', { exact: true }).fill('fixture-password'); await settle();
    const signIn = page.getByRole('button', { name: 'Sign in', exact: true });
    const loginBefore = await page.getByRole('form', { name: 'Sign in', exact: true }).boundingBox(), signBefore = await signIn.boundingBox();
    await signIn.click(); await signIn.locator('.loading').waitFor();
    assert.deepEqual(await signIn.boundingBox(), signBefore, 'Sign in changed size');
    await waitFor(() => typeof releaseLogin === 'function'); releaseLogin();
    await page.getByText('Invalid username or password.', { exact: true }).waitFor();
    assert.deepEqual(await page.getByRole('form', { name: 'Sign in', exact: true }).boundingBox(), loginBefore, 'Login error moved the form');
    assert.deepEqual(errors, []);
    console.log('PASS contextual actions, UID navigation, keyboard, confirmations, fixed notifications, quiet polling, stable loading buttons/forms, creation progress, reduced motion, themes and mobile placement');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

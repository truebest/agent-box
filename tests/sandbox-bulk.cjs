const browserName = process.env.BROWSER || 'chromium';
const browserType = require(process.env.PLAYWRIGHT_MODULE || '/work/browser/node_modules/playwright-core')[browserName];
const assert = require('node:assert/strict');
const origin = process.env.AGENT_URL || 'http://127.0.0.1:18765';

(async () => {
  const browser = await browserType.launch({ headless: true, ...(browserName === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1100 } });
  const page = await context.newPage(), errors = [], operations = [];
  const actors = ['alpha', 'beta', 'gamma', 'delta'].map((name, index) => ({
    metadata: { name, uid: 'uid-' + name, labels: { project: index < 2 ? 'left' : 'right' }, createTime: new Date(2026, 9, 17, 12, index).toISOString() },
    actorTemplate: { name: 'sandbox-v1-fixture' },
    status: { state: ['ACTOR_STATE_RUNNING', 'ACTOR_STATE_SUSPENDED', 'ACTOR_STATE_SUSPENDED', 'ACTOR_STATE_RUNNING'][index], snapshots: [] },
  }));
  let failResume = '', failDelete = '', holdOperation = '';
  const releases = new Map();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (value, status = 200) => request.headers().accept === 'application/x-ndjson'
      ? route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: '\n\n' + JSON.stringify({ status, body: JSON.stringify(value) }) + '\n' })
      : route.fulfill({ status, json: value });
    if (path === '/api/auth/session') return json({ authenticated: true, expires_at: new Date(Date.now() + 3600000).toISOString() });
    if (path === '/api/console') return json({ enabled: false });
    if (path === '/api/console/ui/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Console fixture</title>' });
    if (path === '/api/agents') return json({ actors });
    if (path.endsWith('/session')) return json({ kind: 'none', ready: false, agents: [] });
    const [, name, operation = 'delete'] = path.match(/^\/api\/agents\/([^/]+)(?:\/(resume|suspend))?$/) || [];
    const actor = actors.find(actor => actor.metadata.name === name);
    assert(actor, 'Unexpected API request: ' + path);
    assert(request.method() === (operation === 'delete' ? 'DELETE' : 'POST'));
    assert.equal(request.headers().accept, 'application/x-ndjson');
    operations.push({ name, operation, uid: url.searchParams.get('uid') });
    if (url.searchParams.get('uid') !== actor.metadata.uid) return json({ error: 'Sandbox UID no longer exists' }, 404);
    if (operation === holdOperation) {
      await new Promise(resolve => releases.set(name, resolve));
      releases.delete(name);
    }
    if (name === failResume && operation === 'resume' || name === failDelete && operation === 'delete') return json({ error: 'Synthetic operation failure. Check status before retrying.' }, 503);
    if (operation === 'delete') actors.splice(actors.indexOf(actor), 1);
    else actor.status.state = operation === 'resume' ? 'ACTOR_STATE_RUNNING' : 'ACTOR_STATE_SUSPENDED';
    return json({});
  });
  const row = name => page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select ' + name, exact: true }) });
  const select = name => page.getByRole('checkbox', { name: 'Select ' + name, exact: true });
  const all = page.getByRole('checkbox', { name: 'Select all visible sandboxes', exact: true });
  const toolbar = page.getByRole('group', { name: 'Selected sandboxes', exact: true });
  const resume = toolbar.getByRole('button', { name: 'Resume', exact: true });
  const suspend = toolbar.getByRole('button', { name: 'Suspend', exact: true });
  const remove = toolbar.getByRole('button', { name: 'Delete…', exact: true });
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const waitFor = async check => { const deadline = Date.now() + 15000; while (!await check()) { assert(Date.now() < deadline, 'Bulk fixture did not converge'); await page.waitForTimeout(20); } };
  const selected = count => toolbar.getByText(count + ' selected', { exact: true }).waitFor();
  const status = (name, value) => row(name).getByText(value, { exact: true }).waitFor();
  try {
    await page.goto(origin + '/#/sandboxes');
    await select('alpha').waitFor();
    await page.getByRole('checkbox', { name: 'Auto Refresh', exact: true }).uncheck();
    assert(await resume.isDisabled() && await suspend.isDisabled() && await remove.isDisabled());
    await select('alpha').check(); await selected(1);
    assert(await all.evaluate(input => input.indeterminate));
    assert(await resume.isDisabled() && await suspend.isEnabled());
    await select('beta').check(); await selected(2);
    assert(await resume.isEnabled() && await suspend.isEnabled());
    await page.getByLabel('Sort', { exact: true }).selectOption('name-desc');
    await refresh.click(); await refresh.locator('.loading').waitFor({ state: 'hidden' });
    assert(await select('alpha').isChecked() && await select('beta').isChecked(), 'Refresh/sort lost UID selection');
    await all.check(); await selected(4);
    assert(await all.isChecked() && !await all.evaluate(input => input.indeterminate));
    await all.uncheck(); await selected(0);
    await page.getByLabel('Label', { exact: true }).selectOption('project');
    await page.getByPlaceholder('2 values — type to search').fill('left');
    await all.check(); await selected(2);
    assert.equal(await page.locator('tbody tr').count(), 2);
    await page.getByPlaceholder('2 values — type to search').fill('right'); await selected(0);
    assert.equal(await page.locator('tbody input:checked').count(), 0, 'Filter retained hidden selection');
    await page.getByLabel('Label', { exact: true }).selectOption('');
    await select('alpha').check();
    actors.find(actor => actor.metadata.name === 'alpha').metadata.uid = 'replacement-alpha';
    await refresh.click(); await refresh.locator('.loading').waitFor({ state: 'hidden' }); await selected(0);
    assert(!await select('alpha').isChecked(), 'A replacement inherited the old UID selection');
    console.log('PASS row/select-all/indeterminate controls, refresh/sort persistence, filter isolation and UID replacement');

    await page.getByLabel('Sort', { exact: true }).selectOption('name-asc');
    await select('beta').check(); await select('gamma').check();
    holdOperation = 'resume'; failResume = 'gamma';
    await resume.scrollIntoViewIfNeeded();
    const bounds = await toolbar.boundingBox(), tableBounds = await page.locator('table').boundingBox();
    await resume.click();
    await waitFor(() => releases.size === 2);
    assert.equal(operations.length, 2, 'Resume did not start two requests concurrently');
    assert.deepEqual(operations.map(item => item.uid).sort(), ['uid-beta', 'uid-gamma']);
    assert.equal(await row('beta').getByRole('group', { name: 'Actions for beta', exact: true }).getAttribute('aria-busy'), 'true');
    assert.equal(await row('gamma').getByRole('group', { name: 'Actions for gamma', exact: true }).getAttribute('aria-busy'), 'true');
    assert(await all.isDisabled() && await suspend.isDisabled() && await select('delta').isDisabled());
    assert(await page.getByRole('button', { name: 'Create Sandbox', exact: true }).isDisabled());
    assert.deepEqual(await toolbar.boundingBox(), bounds, 'Pending operation moved/resized the toolbar');
    assert.deepEqual(await page.locator('table').boundingBox(), tableBounds, 'Pending operation moved/resized the table');
    await resume.evaluate(button => button.click());
    assert.equal(operations.length, 2, 'Duplicate bulk input started another operation');
    releases.get('gamma')();
    await toolbar.getByText('1 / 2 processed', { exact: true }).waitFor();
    assert.equal(await row('gamma').getByRole('group', { name: 'Actions for gamma', exact: true }).getAttribute('aria-busy'), 'false');
    assert.equal(await row('beta').getByRole('group', { name: 'Actions for beta', exact: true }).getAttribute('aria-busy'), 'true');
    holdOperation = ''; releases.get('beta')();
    await page.getByText('1 of 2 sandboxes resumed.', { exact: true }).waitFor();
    await resume.locator('.loading').waitFor({ state: 'hidden' }); await selected(1);
    assert(!await select('beta').isChecked() && await select('gamma').isChecked());
    assert.equal(operations.length, 2, 'Failed operation was retried automatically');
    await page.getByText('gamma: Synthetic operation failure. Check status before retrying.', { exact: true }).waitFor();
    assert.deepEqual(await toolbar.boundingBox(), bounds, 'Result notification moved/resized the toolbar');
    failResume = ''; await resume.click(); await selected(0); await status('gamma', 'running');
    console.log('PASS parallel Resume, per-row indicators, out-of-order progress, disabled/duplicate controls, partial failure and explicit retry');

    await select('beta').check(); await select('gamma').check();
    await page.evaluate(() => {
      const original = window.fetch.bind(window); let held = false;
      window.fetch = async (input, init) => {
        const response = await original(input, init);
        if (!held && String(input) === '/api/agents') {
          held = true; const value = await response.json();
          return new Promise(resolve => { window.releaseStaleInventory = () => resolve(Response.json(value)); });
        }
        return response;
      };
    });
    await refresh.click();
    await waitFor(() => page.evaluate(() => typeof window.releaseStaleInventory === 'function'));
    holdOperation = 'suspend';
    await suspend.click();
    await waitFor(() => releases.size === 2);
    assert.equal(await row('beta').getByRole('group', { name: 'Actions for beta', exact: true }).getAttribute('aria-busy'), 'true');
    assert.equal(await row('gamma').getByRole('group', { name: 'Actions for gamma', exact: true }).getAttribute('aria-busy'), 'true');
    releases.get('gamma')();
    await status('gamma', 'suspended'); await selected(1);
    assert(!await select('gamma').isChecked(), 'A completed target remained selected while another target was pending');
    await toolbar.getByText('1 / 2 processed', { exact: true }).waitFor();
    holdOperation = ''; releases.get('beta')(); await selected(0);
    await status('beta', 'suspended'); await status('gamma', 'suspended');
    await suspend.locator('.loading').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.releaseStaleInventory());
    await page.waitForTimeout(100);
    await status('beta', 'suspended'); await status('gamma', 'suspended');
    assert.deepEqual(operations.filter(operation => operation.operation === 'suspend').map(operation => operation.name).sort(), ['beta', 'gamma']);
    console.log('PASS parallel Suspend, out-of-order progress and rejection of an inventory response captured before the operation');

    await select('alpha').check(); await select('beta').check();
    for (const theme of ['light', 'dark']) {
      await page.getByLabel('Theme', { exact: true }).selectOption(theme);
      if (process.env.ARTIFACT_DIR) await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/sandbox-bulk-${theme}.png`, fullPage: true });
    }
    await remove.click();
    const confirmation = page.getByRole('dialog', { name: 'Delete 2 Sandboxes', exact: true });
    await confirmation.waitFor();
    assert.deepEqual((await confirmation.locator('li').allTextContents()).sort(), ['alpha', 'beta']);
    assert.equal(await page.locator(':focus').textContent(), 'Cancel');
    const beforeDelete = operations.length;
    await page.keyboard.press('Escape'); await confirmation.waitFor({ state: 'hidden' });
    assert.equal(operations.length, beforeDelete, 'Cancelled deletion made an API call');
    await remove.click(); await confirmation.waitFor();
    actors.find(actor => actor.metadata.name === 'beta').metadata.uid = 'replacement-beta';
    holdOperation = 'delete';
    await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
    await waitFor(() => releases.has('alpha'));
    assert.equal(operations.length, beforeDelete + 1, 'Deletion must stay sequential');
    holdOperation = ''; releases.get('alpha')();
    await confirmation.waitFor({ state: 'hidden' }); await selected(0);
    assert(actors.some(actor => actor.metadata.uid === 'replacement-beta'), 'A replacement sandbox was deleted');
    assert(!actors.some(actor => actor.metadata.name === 'alpha'));
    assert.equal(operations.filter(operation => operation.operation === 'delete').length, 2);
    console.log('PASS named delete confirmation, cancel, mixed-state deletion and stale UID protection');

    await select('gamma').check(); await select('delta').check(); failDelete = 'gamma';
    await remove.click();
    await page.getByRole('dialog', { name: 'Delete 2 Sandboxes', exact: true }).getByRole('button', { name: 'Delete', exact: true }).click();
    await selected(1);
    assert(await select('gamma').isChecked() && actors.some(actor => actor.metadata.name === 'gamma'));
    assert(!actors.some(actor => actor.metadata.name === 'delta'));
    assert.equal(operations.filter(operation => operation.operation === 'delete' && operation.name === 'gamma').length, 1);
    await page.setViewportSize({ width: 390, height: 844 });
    await toolbar.scrollIntoViewIfNeeded();
    for (const button of await toolbar.getByRole('button').all()) {
      const bounds = await button.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= 390, 'Bulk control overflows mobile viewport');
    }
    if (process.env.ARTIFACT_DIR) await page.screenshot({ path: `${process.env.ARTIFACT_DIR}/sandbox-bulk-mobile.png`, fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS failed deletion stays selected, no automatic repeat, themes and responsive bulk controls');

    await page.setViewportSize({ width: 1600, height: 1100 });
    await toolbar.getByRole('button', { name: 'Clear', exact: true }).click();
    actors.push(...['epsilon', 'zeta'].map(name => ({ metadata: { name, uid: 'uid-' + name }, actorTemplate: { name: 'sandbox-v1-fixture' }, status: { state: 'ACTOR_STATE_SUSPENDED', snapshots: [] } })));
    await refresh.click(); await refresh.locator('.loading').waitFor({ state: 'hidden' });
    await all.check(); await selected(4);
    const beforeNavigation = operations.length;
    holdOperation = 'resume';
    await resume.click(); await waitFor(() => releases.size === 2);
    assert.deepEqual(operations.slice(beforeNavigation).map(item => item.name).sort(), ['beta', 'epsilon']);
    assert.equal(await row('gamma').getByRole('group', { name: 'Actions for gamma', exact: true }).getAttribute('aria-busy'), 'false');
    releases.get('epsilon')();
    await waitFor(() => releases.has('gamma'));
    assert.deepEqual(operations.slice(beforeNavigation).map(item => item.name).sort(), ['beta', 'epsilon', 'gamma']);
    assert.equal(releases.size, 2, 'Resume exceeded the concurrency limit');
    await toolbar.getByText('1 / 4 processed', { exact: true }).waitFor();
    await page.evaluate(() => { window.location.hash = '/console'; });
    await page.getByRole('heading', { name: 'Sandbox Management', exact: true }).waitFor({ state: 'hidden' });
    holdOperation = ''; releases.get('beta')(); releases.get('gamma')();
    await waitFor(() => ['beta', 'gamma'].every(name => actors.find(actor => actor.metadata.name === name).status.state === 'ACTOR_STATE_RUNNING'));
    await page.waitForTimeout(100);
    assert.equal(operations.length, beforeNavigation + 3, 'Unmounted page dispatched an unstarted target');
    await page.evaluate(() => { window.location.hash = '/sandboxes'; });
    await selected(0); await status('beta', 'running'); await status('gamma', 'running'); await status('epsilon', 'running'); await status('zeta', 'suspended');
    assert.deepEqual(errors, []);
    console.log('PASS two-request limit, immediate slot refill, navigation stops queued targets and reopening reads current inventory');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

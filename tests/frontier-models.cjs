const { chromium } = require('/work/browser/node_modules/playwright-core');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const origin = process.env.AGENT_URL || 'https://192.0.2.10:18443';
const models = ['gpt-6-luna', 'gpt-6-astra', 'gpt-6.1-sol'];

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true,  });
  await require('./browser-auth.cjs')(context, origin, fs.readFileSync('/run/panel-password', 'utf8').trim());
  const errors = [], posts = [];
  let failure = '';
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const api = async path => {
    const response = await context.request.get(origin + path);
    assert(response.ok());
    return response.json();
  };
  try {
    await page.route('**/api/agents?stream=1', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      posts.push(route.request().postDataJSON());
      const name = route.request().postDataJSON().name;
      if (failure === 'network') return route.abort('failed');
      if (failure === 'prompt') return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'error', stage: 'prompt', status: 'failed', name, uid: 'partial-fixture', error: 'Prompt acceptance was not confirmed. Check Superterminal before sending again', prompt_delivery: 'uncertain' }) + '\n' });
      await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: JSON.stringify({ type: 'complete', name, actor: { metadata: { name, uid: 'model-fixture' } } }) + '\n' });
    });
    await page.goto(origin + '/#/sandboxes');
    for (const kind of ['codex', 'pi']) {
      for (const model of models) {
        await page.getByRole('button', { name: 'Create Sandbox', exact: true }).first().click();
        const form = page.locator('dialog[open]').filter({ hasText: 'Create Sandbox' });
        await form.getByLabel('Name', { exact: true }).fill('verify-model-choice');
        await form.getByRole('combobox', { name: 'Agent', exact: true }).selectOption(kind);
        await form.getByRole('combobox', { name: 'Model', exact: true }).selectOption(model);
        assert.equal(await form.getByRole('textbox', { name: 'Model ID', exact: true }).count(), 0);
        await form.getByRole('button', { name: 'Create Sandbox', exact: true }).click();
        await form.waitFor({ state: 'hidden' });
        assert.deepEqual(posts.at(-1), { name: 'verify-model-choice', kind, model, cwd: '/workspace' });
      }
    }
    await page.getByRole('button', { name: 'Create Sandbox', exact: true }).first().click();
    const form = page.locator('dialog[open]').filter({ hasText: 'Create Sandbox' });
    await form.getByLabel('Name', { exact: true }).fill('verify-custom-model');
    await form.getByRole('combobox', { name: 'Model', exact: true }).selectOption('');
    await form.getByRole('button', { name: 'Create Sandbox', exact: true }).click();
    assert.equal(posts.length, 6);
    await form.getByRole('textbox', { name: 'Model ID', exact: true }).fill('custom/model');
    await form.getByRole('button', { name: 'Create Sandbox', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    assert.equal(posts.at(-1).model, 'custom/model');
    for (const mode of ['prompt', 'network']) {
      failure = mode;
      await page.getByRole('button', { name: 'Create Sandbox', exact: true }).first().click();
      const dialog = page.locator('dialog[open]');
      await dialog.getByLabel('Name', { exact: true }).fill('verify-delivery-state');
      await dialog.getByLabel('Initial prompt', { exact: true }).fill('Synthetic unsent task');
      const before = posts.length;
      await dialog.getByRole('button', { name: 'Create Sandbox', exact: true }).click();
      await dialog.getByRole('alert').waitFor();
      assert.equal(posts.length, before + 1, 'Creation was repeated automatically');
      assert(await dialog.getByLabel('Name', { exact: true }).isDisabled());
      await dialog.getByRole('button', { name: mode === 'prompt' ? 'Open sandbox' : 'Check status', exact: true }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Create Sandbox', exact: true }).count(), 0);
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
    }
    await page.unroute('**/api/agents?stream=1');
    assert.deepEqual(errors, []);
    fs.writeFileSync('/work/evidence/frontier-models-production.json', JSON.stringify({ models, create_payloads: posts.length, custom_model_preserved: true, partial_resource_retained: true, uncertain_delivery_blocks_replay: true, errors }, null, 2) + '\n');
    console.log('PASS frontier presets, custom model ID, partial resource and uncertain delivery without replay');
  } finally {
    await context.request.post(origin + '/api/auth/logout', { headers: { Origin: origin } }).catch(() => {});
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });

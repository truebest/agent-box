const { chromium, request } = require('/tmp/agent-box-host-browser/node_modules/playwright-core');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
(async () => {
  const origin = 'https://192.0.2.10:8443';
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  await require('./browser-auth.cjs')(context, origin, execFileSync('ssh', ['operator@192.0.2.10', 'cat /home/operator/.config/substrate-panel/password'], { encoding: 'utf8' }).trim());
  const noauth = await request.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) });
  try {
    await page.goto(origin);
    await page.getByRole('heading', { name: 'Sandbox Management', exact: true }).waitFor();
    const asset = await page.locator('script[type=module]').getAttribute('src');
    assert.equal((await noauth.get(origin)).status(), 200);
    assert.equal((await noauth.get(new URL(asset, origin).href)).status(), 200);
    assert.equal((await noauth.get(origin + '/api/agents')).status(), 401);
    await page.getByRole('button', { name: 'Create Sandbox', exact: true }).click();
    const dialog = page.locator('dialog[open]'), input = dialog.getByLabel('Name', { exact: true });
    for (const [value, expected] of [['valid-01', true], ['Invalid', false], ['a-', false], ['a', false], ['../escape', false], ['zz42', true]]) {
      await input.fill(value);
      assert.equal(await input.evaluate(element => element.checkValidity()), expected, value);
    }
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.deepEqual(errors, []);
    await page.screenshot({ path: 'evidence/panel.png', fullPage: true });
    await fs.writeFile('evidence/web-ui-smoke.json', JSON.stringify({ nameValidation: true, loginAssetsPublic: true, APIsRequireAuth: true, javascriptAndConsoleErrors: errors }, null, 2) + '\n');
    console.log('PASS name validation, public login assets, protected APIs, no browser console errors');
  } finally {
    await noauth.dispose(); await context.close(); await browser.close();
  }
})().catch(error => { console.error(error.message); process.exit(1) });

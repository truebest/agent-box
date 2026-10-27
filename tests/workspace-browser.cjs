const { chromium } = require('/work/browser/node_modules/playwright-core');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const origin = process.env.AGENT_URL || 'https://127.0.0.1:18443';
const target = JSON.parse(fs.readFileSync('/work/evidence/native-test-sandboxes.json'))[0];
assert.equal(target.name, 'verify-native-mixed');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true,  });
  await require('./browser-auth.cjs')(context, origin, fs.readFileSync('/run/panel-password', 'utf8').trim());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const actor = await (await context.request.get(origin + '/api/agents/' + target.name)).json();
    assert.equal(actor.metadata.uid, target.uid);
    assert.equal(actor.status.state, 'ACTOR_STATE_RUNNING');
    await page.goto(origin + '/#/files?sandbox=' + target.name);
    const contents = Buffer.from([0, 1, 127, 128, 255, 10]);
    const chooserReady = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload File', exact: true }).click();
    await (await chooserReady).setFiles({ name: 'native-browser-roundtrip.bin', mimeType: 'application/octet-stream', buffer: contents });
    const row = page.getByRole('row').filter({ hasText: 'native-browser-roundtrip.bin' });
    await row.waitFor();
    await row.getByRole('button', { name: 'Download', exact: true }).click();
    const downloadReady = page.waitForEvent('download');
    await page.locator('dialog[open]').getByRole('button', { name: 'Download', exact: true }).click();
    const stream = await (await downloadReady).createReadStream(), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), contents);
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.locator('dialog[open]').getByRole('button', { name: 'Delete', exact: true }).click();
    await row.waitFor({ state: 'hidden' });

    let output = false;
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => { if (Buffer.from(payload)[0] === 48) output = true; }));
    await page.goto(origin + '/#/terminal?sandbox=' + target.name);
    await page.getByText('Connected', { exact: true }).waitFor();
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type("printf NATIVE_BROWSER_TTY > /workspace/native-browser-tty");
    await page.keyboard.press('Enter');
    const deadline = Date.now() + 15000;
    while (true) {
      const response = await context.request.get(origin + '/api/agents/' + target.name + '/files?path=/workspace/native-browser-tty&uid=' + encodeURIComponent(target.uid));
      if (response.ok() && await response.text() === 'NATIVE_BROWSER_TTY') break;
      assert(Date.now() < deadline, 'Shell command did not reach the shared workspace');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    assert(output);
    assert.deepEqual(errors, []);
    fs.writeFileSync('/work/evidence/workspace-browser.json', JSON.stringify({ binary_upload_download_delete: true, shell_input_output: true, uid: target.uid, errors }, null, 2) + '\n');
    console.log('PASS binary file roundtrip and shell input/output');
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error.stack); process.exit(1); });

const { chromium } = require('/work/browser/node_modules/playwright-core');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const origin = process.env.AGENT_URL || 'https://192.0.2.10:18443';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true,  });
  await require('./browser-auth.cjs')(context, origin, fs.readFileSync('/run/panel-password', 'utf8').trim());
  const page = await context.newPage(), errors = [], input = []; let output = false, protocol = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    if (!socket.url().includes('/terminal/ws')) return;
    protocol = true;
    socket.on('framesent', ({ payload }) => { const data = Buffer.from(payload); if (data[0] === 48) input.push(data.subarray(1).toString('hex')); });
    socket.on('framereceived', ({ payload }) => { if (Buffer.from(payload)[0] === 48) output = true; });
  });
  try {
    const response = await context.request.get(origin + '/api/agents/codex-01');
    assert(response.ok());
    const actor = await response.json();
    assert.equal(actor.metadata.uid, '50418b1c-7d03-4add-9168-a239b8dca735');
    assert.equal(actor.status.state, 'ACTOR_STATE_RUNNING');
    await page.goto(origin + '/#/terminal?sandbox=codex-01');
    await page.getByText('Connected', { exact: true }).waitFor({ timeout: 30000 });
    const deadline = Date.now() + 15000;
    while (!output) { assert(Date.now() < deadline, 'Legacy tty output missing'); await page.waitForTimeout(50); }
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    assert(protocol && output);
    const replies = new Set(['1b5b3f313031363b322479', '1b5b3f313b3263']);
    assert(input.every(data => replies.has(data)), 'Legacy terminal sent task input');
    assert.deepEqual(errors, []);
    fs.writeFileSync('/work/evidence/idle-terminal.json', JSON.stringify({ image: JSON.parse(fs.readFileSync('/work/evidence/console-candidate.json')).image, legacy_terminal: true, no_task_input: true, browser_errors: errors }, null, 2) + '\n');
    console.log('PASS tty subprotocol, binary output and no task input through the activity-aware proxy');
  } finally { await context.close(); await browser.close(); }
})().catch(error => { console.error(error.stack); process.exit(1); });

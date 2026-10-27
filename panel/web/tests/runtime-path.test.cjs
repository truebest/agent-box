const { test } = require('node:test');
const assert = require('node:assert/strict');
const runtimePaths = require('../../../tests/runtime-path.cjs');

test('live clients preserve observed UIDs and allow an explicitly selected replacement', async () => {
  let lookups = 0;
  const path = runtimePaths(async name => { lookups++; return { metadata: { name, uid: 'current' } }; });
  path.observe({ metadata: { name: 'sandbox', uid: 'selected' } });
  path.observe({ agents: [{ name: 'sandbox', uid: 'replacement' }] });
  assert.equal(await path('/api/agents/sandbox/session'), '/api/agents/sandbox/session?uid=selected');
  assert.equal(await path('/api/agents/sandbox/files?path=%2Fworkspace'), '/api/agents/sandbox/files?path=%2Fworkspace&uid=selected');
  assert.equal(await path('/api/agents/sandbox/prompt?uid=replacement'), '/api/agents/sandbox/prompt?uid=replacement');
  assert.equal(lookups, 0);
  assert.equal(await path('/api/agents/other/terminal/ws'), '/api/agents/other/terminal/ws?uid=current');
  assert.equal(lookups, 1);
  assert.equal(await path('/api/console'), '/api/console');
});

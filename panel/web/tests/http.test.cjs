const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(fs.readFileSync('src/lib/api/http.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function client(fetch) {
  const exports = {}, auth = { expired: 0 };
  vm.runInNewContext(source, {
    exports, require: () => ({ authRequired: () => auth.expired++ }),
    fetch, Headers, Response,
  });
  return { ...exports, auth };
}

test('waits through heartbeats, submits once, and preserves the final status', async () => {
  let controller, calls = 0, completed = false;
  const body = new ReadableStream({ start(value) { controller = value; } });
  const api = client(async (path, options) => {
    calls++;
    assert.equal(path, '/api/agents/test/resume?uid=current');
    assert.equal(options.headers.get('Accept'), 'application/x-ndjson');
    assert.equal(options.operation, undefined);
    return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });
  });
  const pending = api.request('/api/agents/test/resume?uid=current', { method: 'POST', operation: true });
  pending.then(() => { completed = true; }, () => { completed = true; });
  controller.enqueue(new TextEncoder().encode('\n\n'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  controller.enqueue(new TextEncoder().encode(JSON.stringify({ status: 409, body: '{"error":"Snapshot unavailable"}' })));
  controller.close();
  await assert.rejects(pending, error => error.status === 409 && error.message === 'Snapshot unavailable');
  assert.equal(calls, 1);
});

test('interrupted and malformed streams report uncertain delivery without retry', async () => {
  for (const text of ['\n', '{"status":200}', 'invalid']) {
    let calls = 0;
    const api = client(async () => {
      calls++;
      return new Response(text, { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    await assert.rejects(api.request('/api/agents/test', { method: 'DELETE', operation: true }), /uncertain/);
    assert.equal(calls, 1);
  }
});

test('success, legacy JSON, authentication errors and Access login HTML', async () => {
  for (const stream of [false, true]) {
    const api = client(async () => new Response(stream ? '\n{"status":200,"body":"{\\"ready\\":true}"}' : '{"ready":true}', {
      headers: { 'Content-Type': stream ? 'application/x-ndjson' : 'application/json' },
    }));
    assert.deepEqual(await (await api.request('/api/console/agents/test/current/connect', { method: 'POST', operation: true })).json(), { ready: true });
  }
  const api = client(async () => new Response('{"error":"Authentication required"}', { status: 401 }));
  await assert.rejects(api.request('/api/agents/test', { operation: true }), error => error.status === 401);
  assert.equal(api.auth.expired, 1);
  const login = client(async () => new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(login.request('/api/console/agents/test/current/connect', { operation: true }), /Sign in again/);
});

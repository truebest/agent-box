const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

test('files, tasks and terminal requests retain the selected sandbox UID', async () => {
  const calls = [], sockets = [];
  const cache = {};
  function load(name) {
    if (cache[name]) return cache[name];
    const exports = cache[name] = {};
    const source = ts.transpileModule(fs.readFileSync(`src/lib/api/${name}.ts`, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    vm.runInNewContext(source, {
      exports, URL, URLSearchParams, TextEncoder,
      window: { location: { origin: 'https://panel.example' } },
      WebSocket: class {
        constructor(url) { sockets.push(url); }
        addEventListener() {}
      },
      require: dependency => dependency === './sandbox' ? load('sandbox') : {
        request: async (path, options) => {
          calls.push({ path, options });
          return { json: async () => ({ entries: [] }), blob: async () => new Blob() };
        },
      },
    });
    return exports;
  }
  const sandbox = load('sandbox'), files = load('files'), terminal = load('terminal');
  const name = 'same-name', uid = 'selected-uid';
  await files.listSandboxFiles(name, uid);
  await files.uploadSandboxFile(name, uid, '/workspace', { name: 'file.txt', size: 3 });
  await files.deleteSandboxFile(name, uid, '/workspace/file.txt');
  await files.createSandboxDirectory(name, uid, '/workspace/new');
  await files.downloadSandboxFile(name, uid, '/workspace/file.txt');
  const prompt = new URL(sandbox.agentRuntimePath(name, uid, 'prompt'), 'https://panel.example');
  assert.equal(prompt.searchParams.get('uid'), uid);
  terminal.createSandboxTerminalSession(name, uid, () => {});
  for (const { path } of calls) {
    const url = new URL(path, 'https://panel.example');
    assert.equal(url.pathname, '/api/agents/same-name/files');
    assert.equal(url.searchParams.get('uid'), uid);
    assert.ok(url.searchParams.get('path').startsWith('/workspace'));
  }
  assert.equal(calls.length, 5);
  assert.equal(sockets[0].protocol, 'wss:');
  assert.equal(sockets[0].searchParams.get('uid'), uid);
  const before = calls.length;
  await assert.rejects(files.listSandboxFiles(name, ''), /UID/);
  assert.throws(() => terminal.createSandboxTerminalSession(name, '', () => {}), /UID/);
  assert.throws(() => sandbox.agentRuntimePath(name, '', 'prompt'), /UID/);
  assert.equal(calls.length, before);
  assert.equal(sockets.length, 1);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(fs.readFileSync('src/lib/api/workers.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const api = {};
let saved;
vm.runInNewContext(source, { exports: api, require: () => ({ request: async (_path, init) => { saved = JSON.parse(init.body); } }) });

test('adds one Worker reserve to whole sandbox allocations and previews both versions', () => {
  const legacy = { cpu_milli: 8250, memory_mib: 8704, slots: 4, sandbox_cpu_milli: 2000, sandbox_memory_mib: 2048, reserved_cpu_milli: 250, reserved_memory_mib: 512 };
  const current = api.resizeProfile(legacy, { sandbox_memory_mib: 2048 });
  assert.equal(current.memory_mib, 8256);
  assert.equal(current.cpu_milli, 8000);
  assert.equal(current.reserved_cpu_milli, 0);
  assert.equal(current.reserved_memory_mib, 64);
  assert.equal(legacy.memory_mib, 8704);
  for (const profile of [legacy, current]) {
    assert.equal(api.profileSummary(profile), '2 CPU / 2048 MiB per sandbox · 4 slots per Worker');
  }
  const larger = api.resizeProfile(current, { sandbox_memory_mib: 3072, slots: 2 });
  assert.equal(larger.memory_mib, 6208);
  assert.equal(larger.cpu_milli, 4000);
  assert.equal(api.profileSummary(larger), '2 CPU / 3072 MiB per sandbox · 2 slots per Worker');
  const faster = api.resizeProfile(larger, { sandbox_cpu_milli: 4000 });
  assert.equal(faster.cpu_milli, 8000);
  assert.equal(faster.memory_mib, 6208);
  assert.equal(api.profileSummary(faster), '4 CPU / 3072 MiB per sandbox · 2 slots per Worker');
});

test('sends the new reserve even when total Worker memory matches a legacy version', async () => {
  const profile = api.resizeProfile({ cpu_milli: 8250, memory_mib: 8704, slots: 4, sandbox_cpu_milli: 2000, sandbox_memory_mib: 2048, reserved_cpu_milli: 250, reserved_memory_mib: 512 }, { sandbox_memory_mib: 2160 });
  await api.saveWorkerProfile(profile);
  assert.equal(saved.memory_mib, 8704);
  assert.equal(saved.reserved_memory_mib, 64);
  assert.equal(saved.cpu_milli, 8000);
  assert.equal(saved.reserved_cpu_milli, 0);
});

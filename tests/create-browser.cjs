const { chromium } = require('/work/browser/node_modules/playwright-core');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const origin = process.env.AGENT_URL || 'https://192.0.2.10:18443';
const password = fs.readFileSync('/run/panel-password', 'utf8').trim();
const targets = fs.existsSync('/work/private/create-targets.json') ? JSON.parse(fs.readFileSync('/work/private/create-targets.json')) : [], secrets = [password], checks = [];
const stamp = Date.now().toString(36);
const save = () => fs.writeFileSync('/work/private/create-targets.json', JSON.stringify(targets));
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1000 } });
  const runtimePath = require('./runtime-path.cjs')(async name => {
    const response = await context.request.get(origin + '/api/agents/' + encodeURIComponent(name));
    assert(response.ok(), `Sandbox lookup failed: HTTP ${response.status()}`);
    return response.json();
  });
  try {
    await require('./browser-auth.cjs')(context, origin, password);
    secrets.push(...(await context.cookies()).map(cookie => cookie.value));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(30000);
    const api = async (method, path, data) => {
      path = await runtimePath(path);
      const response = await context.request.fetch(origin + path, { method, data, headers: { Origin: origin }, timeout: 330000 });
      assert(response.ok(), `${method} ${path}: HTTP ${response.status()}`);
      return runtimePath.observe(await response.json());
    };
    const exec = async (name, script) => {
      const result = await api('POST', `/api/agents/${name}/exec`, { argv: ['python3', '-c', script] });
      assert.equal(result.exit_code, 0, result.output);
      return result.output.trim();
    };
    const record = actor => {
      if (actor.metadata.uid && !targets.some(target => target.uid === actor.metadata.uid)) {
        targets.push({ name: actor.metadata.name, uid: actor.metadata.uid }); save();
      }
    };
    const create = async data => {
      const response = await context.request.post(origin + '/api/agents?stream=1', { data, headers: { Origin: origin }, timeout: 330000 });
      assert(response.ok());
      const events = (await response.text()).trim().split('\n').map(JSON.parse);
      for (const event of events) if (event.uid) record(event.actor || { metadata: { name: event.name, uid: event.uid } });
      return events;
    };
    await page.goto(origin + '/#/sandboxes');
    await page.getByRole('button', { name: 'Create Sandbox', exact: true }).click();
    const form = page.locator('dialog[open]');
    const name = await form.getByLabel('Name', { exact: true }).inputValue();
    assert.match(name, /^sandbox-[0-9a-f]{8}$/);
    assert.equal(await form.getByLabel('Agent', { exact: true }).inputValue(), 'codex');
    assert.equal(await form.getByLabel('Model', { exact: true }).inputValue(), 'gpt-6.1-sol');
    await form.getByRole('button', { name: 'Generate another name' }).click();
    const emptyName = await form.getByLabel('Name', { exact: true }).inputValue();
    assert.notEqual(emptyName, name);
    await form.getByLabel('Agent', { exact: true }).selectOption('none');
    assert.equal(await form.getByLabel('Model', { exact: true }).count(), 0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await form.evaluate(element => element.scrollWidth <= innerWidth));
    await page.screenshot({ path: '/work/evidence/create-mobile.png' });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.screenshot({ path: '/work/evidence/create-empty.png' });
    await form.getByRole('button', { name: 'Create Sandbox', exact: true }).click();
    await form.getByRole('button', { name: 'Create Sandbox', exact: true }).locator('.loading').waitFor();
    assert(await form.getByRole('button', { name: 'Create Sandbox', exact: true }).isDisabled());
    await page.keyboard.press('Escape');
    assert(await form.isVisible());
    await form.locator('[data-stage="sandbox"][data-status="running"]').waitFor();
    await form.waitFor({ state: 'hidden', timeout: 330000 });
    assert.equal(new URL(page.url()).hash, '#/sandboxes');
    await page.getByRole('button', { name: 'Open Terminal', exact: true }).waitFor();
    const emptyActor = await api('GET', `/api/agents/${emptyName}`); record(emptyActor);
    const empty = await api('GET', `/api/agents/${emptyName}/session`);
    assert.equal(empty.kind, 'none'); assert.equal(empty.ready, false); assert.equal(empty.agents.length, 0);
    const row = page.locator('tbody tr').filter({ hasText: emptyName });
    await row.getByText('No agent', { exact: true }).first().waitFor();
    checks.push('generated editable name; optional agent; mobile and reduced motion; pending lock; real progress; remain in list');
    const memoryProgram = "from http.server import BaseHTTPRequestHandler,HTTPServer\nimport secrets\nvalue=secrets.token_hex(32)\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write(value.encode())\n def log_message(self,*args):pass\nHTTPServer(('127.0.0.1',8082),H).serve_forever()";
    const memoryPID = await exec(emptyName, `import subprocess;print(subprocess.Popen(['python3','-c',${JSON.stringify(memoryProgram)}],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True).pid)`);
    const probe = "import time,urllib.request\nfor attempt in range(50):\n try:\n  value=urllib.request.urlopen('http://127.0.0.1:8082',timeout=1).read().decode();break\n except OSError:time.sleep(.1)\nelse:raise RuntimeError('Memory probe unavailable')\nprint(value)";
    const memory = await exec(emptyName, probe);
    const before = await exec(emptyName, "from pathlib import Path;Path('/workspace/empty-proof').write_text('retained');print(Path('/proc/1/stat').read_text().split()[21])");
    const suspended = await api('POST', `/api/agents/${emptyName}/suspend`);
    assert(suspended.status.snapshots.some(snapshot => snapshot.fidelity === 'SNAPSHOT_FIDELITY_MEMORY' && snapshot.durableSnapshot?.status === 'SNAPSHOT_STORAGE_STATUS_COMPLETED'));
    await api('POST', `/api/agents/${emptyName}/resume`);
    assert.equal(await exec(emptyName, "from pathlib import Path;assert Path('/workspace/empty-proof').read_text()=='retained';print(Path('/proc/1/stat').read_text().split()[21])"), before);
    assert.equal(await exec(emptyName, probe), memory, 'Memory-only value changed after Resume');
    await exec(emptyName, `import os;from pathlib import Path;pid=${Number(memoryPID)};assert b'HTTPServer' in Path('/proc/'+str(pid)+'/cmdline').read_bytes();os.kill(pid,15)`);
    assert.equal((await api('GET', `/api/agents/${emptyName}/session`)).agents.length, 0);
    checks.push('empty MEMORY checkpoint uploaded to durable storage and resumed with same process, memory-only value and files');
    await page.goto(origin + `/#/terminal?sandbox=${emptyName}`);
    await page.getByText('Connected', { exact: true }).waitFor();
    await page.goto(origin + `/#/console?uid=${emptyActor.metadata.uid}`);
    const session = page.frameLocator('iframe[title="Superterminal navigation"]').frameLocator(`iframe[title="${emptyName} Superterminal"]`);
    await session.locator('.conn-live').waitFor({ state: 'attached', timeout: 180000 });
    checks.push('empty Terminal and Superterminal open');
    for (const kind of ['codex', 'pi']) {
      const sandbox = `verify-create-${kind}-${stamp}`;
      const prompt = `Use a tool to write exactly CREATED into /workspace/project/initial-proof.txt. Then reply done. Do not run anything else.`;
      const events = await create({ name: sandbox, kind, model: 'gpt-6.1-sol', cwd: '/workspace/project', prompt });
      const final = events.at(-1);
      assert.equal(final.type, 'complete', final.error); assert.equal(final.prompt_delivery, 'accepted');
      assert.deepEqual(events.filter(event => event.status === 'done').map(event => event.stage), ['sandbox', 'agent', 'prompt']);
      const deadline = Date.now() + 150000;
      while (await exec(sandbox, "from pathlib import Path;p=Path('/workspace/project/initial-proof.txt');print(p.read_text().strip() if p.exists() else 'pending')") !== 'CREATED') {
        assert(Date.now() < deadline, `${kind} did not execute initial prompt`); await page.waitForTimeout(1000);
      }
      const state = await api('GET', `/api/agents/${sandbox}/session`);
      assert(state.ready && state.runner.agent_session); assert.equal(state.agents.length, 1);
      const audit = `import json;from pathlib import Path
session=${JSON.stringify(state.runner.agent_session.value)}
path=Path(session) if session.startswith('/') else next((Path.home()/'.codex/sessions').rglob('*'+session+'*.jsonl'))
rows=[json.loads(line) for line in path.read_text().splitlines()]
prompt=${JSON.stringify(prompt)}
count=0
for row in rows:
 message=row.get('message',row.get('payload',{}))
 content=message.get('content',[])
 if message.get('role')=='user' and any(item.get('text')==prompt for item in content if isinstance(item,dict)):count+=1
assert count==1,count
print('once')`;
      assert.equal(await exec(sandbox, audit), 'once');
      const duplicate = await create({ name: sandbox, kind, prompt });
      assert.equal(duplicate.at(-1).type, 'error');
      assert.equal(await exec(sandbox, audit), 'once');
      checks.push(`${kind}: safe directory creation, initial prompt accepted and executed once, duplicate create did not replay input`);
    }
    const failure = await create({ name: `verify-create-failure-${stamp}`, kind: 'pi', model: 'deliberately-invalid-model', prompt: 'Do not send this task' });
    assert.equal(failure.at(-1).type, 'error'); assert(failure.at(-1).uid);
    assert.equal(failure.at(-1).prompt_delivery, 'not_sent');
    checks.push('partial startup failure preserves sandbox identity and does not send initial prompt');
    assert.deepEqual(errors, []);
    fs.writeFileSync('/work/evidence/create-browser.json', JSON.stringify({ origin, checks, javascript_errors: errors }, null, 2) + '\n');
    console.log(checks.map(check => 'PASS ' + check).join('\n'));
  } finally {
    await context.request.post(origin + '/api/auth/logout', { headers: { Origin: origin } }).catch(() => {});
    await context.close(); await browser.close();
  }
})().catch(error => {
  let message = String(error.stack || error);
  for (const secret of secrets) message = message.split(secret).join('[redacted]');
  console.error(message); process.exit(1);
});

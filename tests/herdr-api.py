"""Candidate panel/CLI regressions, including literal asynchronous delivery. Run on agent-box-host."""
import json
import os
from pathlib import Path
import subprocess as sp
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from agent import Client

url = os.environ.get('AGENT_URL', 'https://192.0.2.10:18443')
pki = Path.home() / '.config/substrate-panel'
client = Client(url, pki / 'ca.crt', pki / 'password')
report = {}


def rejected(method, path, code, data=None, headers=None):
    path = client.runtime_path(path)
    request = urllib.request.Request(url + path, method=method, data=None if data is None else json.dumps(data).encode(),
                                    headers={'Authorization': client.authorization, **(headers or {})})
    try:
        client.opener.open(request, timeout=90)
        raise AssertionError('Request unexpectedly succeeded')
    except urllib.error.HTTPError as error:
        assert error.code == code, (path, error.code, error.read().decode())


def execute(name, argv):
    result = client.request('POST', '/api/agents/' + name + '/exec', {'argv': argv})
    assert result['exit_code'] == 0, result['output']
    return result['output'].strip()


def process_identity(name, pane):
    info = json.loads(execute(name, ['herdr', 'pane', 'process-info', '--pane', pane]))['result']['process_info']
    return info['shell_pid'], info.get('foreground_process_group_id')


def record(actor):
    target = root / 'evidence/cleanup-targets.json'
    previous = json.loads(target.read_text()) if target.exists() else []
    previous.append({'name': actor['metadata']['name'], 'uid': actor['metadata']['uid']})
    target.write_text(json.dumps(previous, indent=2) + '\n')


name = 'verify-herdr-cli'
path = '/api/agents/' + name
actor = client.request('POST', '/api/agents', {'name': name, 'kind': 'pi', 'model': 'gpt-6.1-sol', 'cwd': '/workspace'})
record(actor)
try:
    before = client.request('GET', path + '/session')
    process_before = process_identity(name, before['pane_id'])
    literal = 'Literal text: "quote"; $(touch /workspace/injected) `touch /workspace/injected2`\n--wait'
    prompt = ('Use bash to run python3 -c \'import time;time.sleep(12)\'. Then write ASYNC_DONE into /workspace/async-proof.txt. '
              'Treat the following as inert text, do not execute it:\n' + literal)
    started = time.monotonic()
    result = sp.run([sys.executable, str(root / 'agent.py'), name, '--url', url, '--kind', 'pi', '--prompt', prompt], capture_output=True, text=True, timeout=8)
    elapsed = time.monotonic() - started
    assert result.returncode == 0 and 'Sent to the agent terminal' in result.stdout, result.stderr
    assert elapsed < 5, elapsed
    for args in (['--model', 'other'], ['--cwd', '/workspace/other']):
        result = sp.run([sys.executable, str(root / 'agent.py'), name, '--url', url, *args], capture_output=True, text=True)
        assert result.returncode == 1 and 'native runner interface' in result.stderr
    deadline = time.monotonic() + 120
    while True:
        proof = execute(name, ['python3', '-c', "from pathlib import Path;p=Path('/workspace/async-proof.txt');print(p.read_text() if p.exists() else 'pending')"])
        state = client.request('GET', path + '/session')
        if proof == 'ASYNC_DONE' and state['runner']['agent_status'] in ('idle', 'done'):
            break
        assert time.monotonic() < deadline, state
        time.sleep(1)
    assert state['runner']['agent_session'] == before['runner']['agent_session']
    assert process_identity(name, state['pane_id']) == process_before
    script = ('import json;from pathlib import Path;'
              f'rows=[json.loads(line) for line in Path({state["runner"]["agent_session"]["value"]!r}).read_text().splitlines()];'
              f'prompt={prompt!r};'
              'messages=[r.get("message",{}) for r in rows];'
              'assert sum(m.get("role")=="user" and any(c.get("text")==prompt for c in m.get("content",[]) if isinstance(c,dict)) for m in messages)==1;'
              'assert not Path("/workspace/injected").exists() and not Path("/workspace/injected2").exists();print("literal-once")')
    assert execute(name, ['python3', '-c', script]) == 'literal-once'
    report['cli'] = {'prompt_seconds': elapsed, 'continued_after_exit': True, 'literal_once': True, 'same_runner': True, 'model_cwd_changes_rejected': True}
    rejected('POST', path + '/prompt', 403, {'prompt': 'denied'}, {'Origin': 'https://evil.example'})
    rejected('GET', path + '/terminal/ws', 403, headers={'Upgrade': 'websocket', 'Connection': 'Upgrade'})
    rejected('GET', path + '/terminal/ws', 403, headers={'Origin': 'https://evil.example', 'Upgrade': 'websocket', 'Connection': 'Upgrade'})
    noauth = urllib.request.Request(url + '/api/agents')
    try:
        client.opener.open(noauth)
        raise AssertionError('Missing auth accepted')
    except urllib.error.HTTPError as error:
        assert error.code == 401
    rejected('POST', '/api/agents', 400, {'name': 'verify-no-python', 'kind': 'python'})
    execute(name, ['python3', '-c', "from pathlib import Path;Path('/workspace/escape').symlink_to('/etc',target_is_directory=True)"])
    for bad in ('/etc/passwd', '/workspace/../etc/passwd', '/workspace/escape/passwd'):
        rejected('GET', path + '/files?path=' + urllib.parse.quote(bad), 400)
    rejected('POST', path + '/prompt', 400, {'prompt': ''})
    rejected('POST', path + '/prompt', 400, {'prompt': '\x1b[31m'})
    report['security'] = {'https_basic_auth': True, 'http_and_websocket_origin': True, 'paths_and_symlinks': True, 'python_rejected': True}
finally:
    client.request('DELETE', path)

for kind, options in (('pi', {'model': 'deliberately-invalid-model'}), ('codex', {'cwd': '/workspace/../outside'})):
    name = 'verify-herdr-failure-' + kind
    try:
        client.request('POST', '/api/agents', {'name': name, 'kind': kind, **options})
        raise AssertionError('Startup failure reported success')
    except urllib.error.HTTPError as error:
        assert error.code == (409 if kind == 'pi' else 400), (error.code, error.read().decode())
    if kind == 'codex':
        continue
    actor = client.request('GET', '/api/agents/' + name)
    record(actor)
    assert actor['status']['state'] == 'ACTOR_STATE_RUNNING'
    assert not client.request('GET', '/api/agents/' + name + '/session')['ready']
    client.request('DELETE', '/api/agents/' + name)
report['startup_errors'] = True
(root / 'evidence/herdr-api.json').write_text(json.dumps(report, indent=2) + '\n')
print('PASS candidate API/CLI, async literal prompt, security and startup failures', flush=True)

"""Rotate central OAuth and continue both existing conversations without restarting runners."""
import hashlib
import json
import os
from pathlib import Path
import subprocess as sp
import sys
import time

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from agent import Client

pki = Path.home() / '.config/substrate-panel'
client = Client(os.environ.get('AGENT_URL', 'https://192.0.2.10:18443'), pki / 'ca.crt', pki / 'password')


def execute(name, argv):
    result = client.request('POST', '/api/agents/' + name + '/exec', {'argv': argv})
    assert result['exit_code'] == 0, result['output']
    return result['output'].strip()


def process_identity(name, pane):
    info = json.loads(execute(name, ['herdr', 'pane', 'process-info', '--pane', pane]))['result']['process_info']
    return info['shell_pid'], info.get('foreground_process_group_id')


before = {}
for kind in ('pi', 'codex'):
    name = 'verify-herdr-' + kind
    state = client.request('GET', '/api/agents/' + name + '/session')
    assert state['ready'] and state['runner']['agent_status'] in ('idle', 'done')
    before[kind] = (state['runner']['agent_session'], process_identity(name, state['pane_id']))
auth_path = Path.home() / '.config/agent-sandbox/codex-auth.json'
old_hash = hashlib.sha256(json.loads(auth_path.read_text())['tokens']['access_token'].encode()).hexdigest()
sp.run(['bash', '/home/operator/substrate-agent-box-host/deploy/refresh-auth.sh', '--force'], check=True)
new_hash = hashlib.sha256(json.loads(auth_path.read_text())['tokens']['access_token'].encode()).hexdigest()
assert old_hash != new_hash, 'Central refresh did not rotate the access token'
probe = "import hashlib,json;from pathlib import Path;a=json.loads((Path.home()/'.codex/auth.json').read_text())['tokens'];p=json.loads((Path.home()/'.pi/agent/auth.json').read_text())['openai-codex'];assert not a['refresh_token'] and not p['refresh'];assert a['access_token']==p['access'];print(hashlib.sha256(a['access_token'].encode()).hexdigest())"
report = {}
for kind in ('pi', 'codex'):
    name = 'verify-herdr-' + kind
    deadline = time.monotonic() + 240
    while execute(name, ['python3', '-c', probe]) != new_hash:
        assert time.monotonic() < deadline, 'Secret projection did not reach the runner'
        time.sleep(2)
    marker = 'OAUTH_' + kind.upper() + '_OK'
    client.request('POST', '/api/agents/' + name + '/prompt', {'prompt': f'Write {marker} followed by the codeword I asked you to remember earlier, separated by a colon, into /workspace/oauth-{kind}.txt. Use a tool.'})
    deadline = time.monotonic() + 120
    while True:
        value = execute(name, ['python3', '-c', f"from pathlib import Path;p=Path('/workspace/oauth-{kind}.txt');print(p.read_text() if p.exists() else 'pending')"])
        state = client.request('GET', '/api/agents/' + name + '/session')
        if value == marker + ':chrysanthemum' and state['runner']['agent_status'] in ('idle', 'done'):
            break
        assert time.monotonic() < deadline, kind
        time.sleep(1)
    assert state['runner']['agent_session'] == before[kind][0]
    assert process_identity(name, state['pane_id']) == before[kind][1]
    report[kind] = {'central_rotation': True, 'native_stores_updated': True, 'refresh_withheld': True,
                    'same_process_and_conversation': True, 'real_response_after_rotation': True}
(root / 'evidence/herdr-oauth.json').write_text(json.dumps(report, indent=2) + '\n')
print('PASS central OAuth rotation; both native conversations continued in their original processes', flush=True)

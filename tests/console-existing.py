"""Attach the verified bridge to codex-01 without sending input or replacing its runner."""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from agent import Client

pki = Path.home() / '.config/substrate-panel'
image = json.loads((root / 'evidence/console-candidate.json').read_text())['image']
browser = json.loads((root / 'evidence/console-browser.json').read_text())
assert browser['image'] == image and all(browser.get(key) is True for key in ('pi', 'codex', 'uid_isolation', 'keyboard_resize_reconnect', 'browser_independence'))
api = json.loads((root / 'evidence/console-api.json').read_text())
assert api['image'] == image and api['http_ws_auth_origin'] and api['files']
assert len(json.loads((root / 'evidence/console-memory.json').read_text())) == 2
assert json.loads((root / 'evidence/console-lifecycle.json').read_text())['recreated_name']
client = Client('https://192.0.2.10:18443', pki / 'ca.crt', pki / 'password')
name = 'codex-01'
uid = '50418b1c-7d03-4add-9168-a239b8dca735'
path = f'/api/agents/{name}'
actor = client.request('GET', path)
assert actor['metadata']['uid'] == uid, 'Existing agent was replaced; attachment refused'
initial_state = actor['status']['state']
if initial_state == 'ACTOR_STATE_SUSPENDED':
    assert actor['status']['snapshots'][0]['durableSnapshot']['status'] == 'SNAPSHOT_STORAGE_STATUS_COMPLETED'
    actor = client.request('POST', path + '/resume')
assert actor['metadata']['uid'] == uid and actor['status']['state'] == 'ACTOR_STATE_RUNNING'
before = client.request('GET', path + '/session')
assert before['ready'] and before['runner']['agent_session'], 'Existing conversation is unavailable'


def process():
    result = client.request('POST', path + '/exec', {'argv': ['herdr', 'pane', 'process-info', '--pane', before['pane_id']]})
    assert result['exit_code'] == 0
    info = json.loads(result['output'])['result']['process_info']
    return {key: info[key] for key in ('shell_pid', 'foreground_process_group_id')}


pid_before = process()
bridge = f'/api/console/agents/{name}/{uid}'
client.request('POST', bridge + '/connect')
health = client.request('GET', bridge + '/bridge/api/health')
assert health['ok'] and health['herdr']['version'] == '0.9.5' and health['herdr']['terminal_attach']
assert client.request('GET', bridge + f'/bridge/api/pane/conversation?pane_id={before["pane_id"]}').get('turns')
after = client.request('GET', path + '/session')
assert before['pane_id'] == after['pane_id']
assert before['runner']['agent_session'] == after['runner']['agent_session']
assert pid_before == process(), 'Bridge replaced the existing runner'
report = {
    'image': image, 'uid': uid, 'initial_state': initial_state, 'existing_codex': True,
    'process_before': pid_before, 'process_after': process(),
    'conversation_before': before['runner']['agent_session'],
    'conversation_after': after['runner']['agent_session'],
    'input_sent': False,
}
(root / 'evidence/console-existing.json').write_text(json.dumps(report, indent=2) + '\n')
print('PASS codex-01: same UID, pane, conversation and runner PIDs; no input sent')

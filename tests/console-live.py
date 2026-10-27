"""Exercise the candidate on temporary agents; never send input to user sandboxes."""
import base64
import json
import os
from pathlib import Path
import ssl
import subprocess as sp
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from agent import Client

pki = Path.home() / '.config/substrate-panel'
origin = os.environ.get('AGENT_URL', 'https://192.0.2.10:18443')
client = Client(origin, pki / 'ca.crt', pki / 'password')
targets_file = root / 'evidence/console-targets.json'


def execute(name, argv):
    result = client.request('POST', '/api/agents/' + name + '/exec', {'argv': argv})
    assert result['exit_code'] == 0, result['output']
    return result['output'].strip()


def bridge(agent):
    return f'/api/console/agents/{agent["name"]}/{agent["uid"]}'


def rejected(method, path, want, headers=None, authenticate=True):
    request = urllib.request.Request(origin + path, method=method, headers={**({'Authorization': client.authorization} if authenticate else {}), **(headers or {})})
    try:
        urllib.request.urlopen(request, context=client.context, timeout=30)
    except urllib.error.HTTPError as error:
        assert error.code == want, (path, error.code, want)
    else:
        raise AssertionError('Unexpectedly accepted ' + path)


def setup():
    pool = client.request('GET', '/api/console')
    assert pool['enabled'] and len(pool['workers']) >= 1
    targets = json.loads(targets_file.read_text()) if targets_file.exists() else []
    for kind in ('pi', 'codex'):
        name = 'verify-console-' + kind
        agent = next((a for a in targets if a['name'] == name), None)
        if agent:
            actor = client.request('GET', '/api/agents/' + name)
            assert actor['metadata']['uid'] == agent['uid'], 'Test target identity changed'
        else:
            assert all(a['name'] != name for a in pool['agents'])
            actor = client.request('POST', '/api/agents', {'name': name, 'kind': kind})
            agent = {'name': name, 'uid': actor['metadata']['uid'], 'kind': kind}
            targets.append(agent)
        targets_file.write_text(json.dumps(targets, indent=2) + '\n')
        if actor['status']['state'] == 'ACTOR_STATE_SUSPENDED':
            client.request('POST', bridge(agent) + '/resume')
        session = client.request('GET', '/api/agents/' + name + '/session')
        agent['pane'] = session['pane_id']
        before = json.loads(execute(name, ['herdr', 'pane', 'process-info', '--pane', agent['pane']]))['result']['process_info']
        client.request('POST', bridge(agent) + '/connect')
        health = client.request('GET', bridge(agent) + '/bridge/api/health')
        assert health['ok'] and health['herdr']['terminal_attach'] is not False, health
        assert health['herdr']['version'] == '0.9.5', health['herdr']
        snapshot = client.request('GET', bridge(agent) + '/bridge/api/session')['snapshot']
        assert any(pane['pane_id'] == agent['pane'] for pane in snapshot['panes'])
        client.request('POST', bridge(agent) + '/connect')
        after = json.loads(execute(name, ['herdr', 'pane', 'process-info', '--pane', agent['pane']]))['result']['process_info']
        assert before['shell_pid'] == after['shell_pid'] and before['foreground_process_group_id'] == after['foreground_process_group_id']
        agent['process'] = before
        targets_file.write_text(json.dumps(targets, indent=2) + '\n')
        print('PASS bridge with gVisor, existing runner, idempotent install:', kind, flush=True)
    for path in ('/api/console', '/api/console/ui/', bridge(targets[0]) + '/ui/', bridge(targets[0]) + '/bridge/api/session', '/console-assets/assets/missing.js'):
        rejected('GET', path, 401, authenticate=False)
    rejected('POST', bridge(targets[0]) + '/connect', 403, {'Origin': 'https://evil.example'})
    for headers, authenticate, want in (({'Upgrade': 'websocket', 'Connection': 'Upgrade', 'Origin': origin}, False, 401),
                                         ({'Upgrade': 'websocket', 'Connection': 'Upgrade', 'Origin': 'https://evil.example'}, True, 403),
                                         ({'Upgrade': 'websocket', 'Connection': 'Upgrade'}, True, 403)):
        rejected('GET', bridge(targets[0]) + '/bridge/ws', want, headers, authenticate)
    for endpoint in ('updates', 'devices', 'devices/pair', 'telemetry', 'access', 'herdr/update', 'machines', 'push', 'voice'):
        rejected('GET', bridge(targets[0]) + '/bridge/api/' + endpoint, 404)
    execute(targets[0]['name'], ['python3', '-c', "from pathlib import Path;p=Path('/workspace/console-file.txt');p.write_text('console-file');link=Path('/workspace/console-link');link.unlink(missing_ok=True);link.symlink_to('/etc')"])
    assert client.request('GET', bridge(targets[0]) + '/bridge/api/fs/stat?path=/workspace/console-file.txt')['size'] == 12
    for path in ('/etc/passwd', '/workspace/console-link/passwd'):
        rejected('GET', bridge(targets[0]) + '/bridge/api/fs/file?path=' + urllib.parse.quote(path), 404)
    upload = client.request('POST', bridge(targets[0]) + '/bridge/api/pane/image', {
        'pane_id': targets[0]['pane'], 'name': '../verification.txt', 'content_type': 'text/plain',
        'data_base64': base64.b64encode(b'attachment').decode()})
    assert upload['path'].startswith('/workspace/.agent-state/herdr-web-ui/uploads/')
    assert client.request('GET', bridge(targets[0]) + '/bridge/api/fs/stat?path=' + urllib.parse.quote(upload['path']))['size'] == 10
    image = json.loads((root / 'evidence/console-candidate.json').read_text())['image']
    (root / 'evidence/console-api.json').write_text(json.dumps({'image': image, 'http_ws_auth_origin': True, 'files': True}, indent=2) + '\n')
    print('PASS HTTP/WebSocket auth, Origin, disabled standalone services, file boundaries', flush=True)


def memory():
    targets = json.loads(targets_file.read_text())
    details = []
    states = {}
    conversations = {}
    for agent in targets:
        state = client.request('GET', '/api/agents/' + agent['name'])
        assert state['metadata']['uid'] == agent['uid']
        if state['status']['state'] == 'ACTOR_STATE_SUSPENDED':
            client.request('POST', bridge(agent) + '/resume')
            state = client.request('GET', '/api/agents/' + agent['name'])
        states[agent['uid']] = state
        conversations[agent['uid']] = client.request('GET', '/api/agents/' + agent['name'] + '/session')['runner']['agent_session']
    for agent in targets:
        name = agent['name']
        # Free the other test agent's capacity; existing user agents keep running.
        for other in targets:
            if other['uid'] != agent['uid']:
                current = client.request('GET', '/api/agents/' + other['name'])
                assert current['metadata']['uid'] == other['uid']
                if current['status']['state'] == 'ACTOR_STATE_RUNNING':
                    client.request('POST', '/api/agents/' + other['name'] + '/suspend')
        state = states[agent['uid']]
        old_worker = state['status']['workerAssignment']['worker']['name']
        before = conversations[agent['uid']]
        paused = client.request('GET', '/api/agents/' + name)
        assert paused['metadata']['uid'] == agent['uid']
        if paused['status']['state'] == 'ACTOR_STATE_RUNNING':
            paused = client.request('POST', '/api/agents/' + name + '/suspend')
        snapshot = paused['status']['snapshots'][0]
        assert snapshot['fidelity'] == 'SNAPSHOT_FIDELITY_MEMORY'
        assert snapshot['durableSnapshot']['status'] == 'SNAPSHOT_STORAGE_STATUS_COMPLETED'
        assert snapshot['durableSnapshot']['object']['snapshotUri'].startswith('s3://agent-box-snapshots/')
        pool = client.request('GET', '/api/console')
        assert next(a for a in pool['agents'] if a['uid'] == agent['uid'])['sandbox'] == 'SUSPENDED'
        rejected('GET', bridge(agent) + '/bridge/api/session', 409)
        controller = str(root / 'vendor/substrate/bin/console-worker')
        try:
            sp.run([controller, 'unavailable', old_worker], check=True)
            client.request('POST', bridge(agent) + '/resume')
        finally:
            sp.run([controller, 'available', old_worker], check=True)
        resumed = client.request('GET', '/api/agents/' + name)
        new_worker = resumed['status']['workerAssignment']['worker']['name']
        assert new_worker != old_worker
        after = client.request('GET', '/api/agents/' + name + '/session')['runner']['agent_session']
        assert before == after
        health = client.request('GET', bridge(agent) + '/bridge/api/health')
        assert health['ok']
        conversation = client.request('GET', bridge(agent) + '/bridge/api/pane/conversation?pane_id=' + agent['pane'])
        assert conversation.get('turns'), 'Conversation history lost after Resume'
        details.append({'uid': agent['uid'], 'worker_before': old_worker, 'worker_after': new_worker, 'snapshot': snapshot})
        print('PASS MEMORY/R2 and bridge on another worker:', agent['kind'], flush=True)
    for agent in targets:
        state = client.request('GET', '/api/agents/' + agent['name'])
        assert state['metadata']['uid'] == agent['uid']
        if state['status']['state'] == 'ACTOR_STATE_SUSPENDED':
            client.request('POST', bridge(agent) + '/resume')
    (root / 'evidence/console-memory.json').write_text(json.dumps(details, indent=2) + '\n')


if __name__ == '__main__':
    {'setup': setup, 'memory': memory}[sys.argv[1]]()

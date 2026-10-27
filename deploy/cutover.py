"""Switch to the verified Herdr runtime; preserve configuration and images for rollback."""
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess as sp
import sys
import time
import urllib.error
import urllib.request

root = Path(__file__).resolve().parents[1]
live = Path('/home/operator/substrate-agent-box-host')
sys.path.insert(0, str(root))
from agent import Client

ate = str(live / 'vendor/substrate/bin/kubectl-ate')
pki = Path.home() / '.config/substrate-panel'
client = Client('https://192.0.2.10:18443', pki / 'ca.crt', pki / 'password')
old_name = 'agent-pi-001'
old_uid = '3e5e05fb-e6a6-43c9-a638-637c6c1df06b'


def run(*args, data=None):
    return sp.check_output(args, input=None if data is None else json.dumps(data).encode())


def template(name):
    value = json.loads(run(ate, 'get', 'actor-template', name, '-a', 'pvm-agents', '-o', 'json'))
    value['metadata'] = {'atespace': 'pvm-agents', 'name': name}
    value.pop('status', None)
    return value


def forward(action):
    run('docker', 'run', '--rm', '--privileged', '--pid=host', '-v', '/:/host', 'python:3.12',
        'nsenter', '-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'systemctl', action, 'substrate-panel.service')


models = json.loads((root / 'evidence/herdr-models.json').read_text())
assert set(models) == {'pi', 'codex'}
assert all(m['real_tool_call'] and m['conversation_continued'] and m['no_terminal_client'] for m in models.values())
browser = json.loads((root / 'evidence/herdr-browser.json').read_text())
assert browser['javascriptErrors'] == []
for kind in ('pi', 'codex'):
    assert all(browser[kind].values())
    assert all(json.loads((root / 'evidence/herdr-oauth.json').read_text())[kind].values())
assert json.loads((root / 'evidence/herdr-memory.json').read_text())['memory'] is True
assert json.loads((root / 'evidence/herdr-api.json').read_text())['startup_errors'] is True
assert json.loads((root / 'evidence/herdr-crashed-delete.json').read_text())['delete_crashed']
ui = json.loads((root / 'evidence/web-ui.json').read_text())
assert ui['javascriptErrors'] == [] and len(ui['checks']) >= 8
cleanup = json.loads((root / 'evidence/cleanup.json').read_text())
assert cleanup and all(a['s3_objects'] == 0 and a['local_user_files'] == 0 for a in cleanup)
images = json.loads((root / 'herdr-images.json').read_text())
old_images = json.loads((live / 'images.json').read_text())
candidate = json.loads(run('kubectl', '-n', 'pvm-agents', 'get', 'deployment', 'panel-herdr-candidate', '-o', 'json'))
images['panel'] = candidate['spec']['template']['spec']['containers'][0]['image']
assert all('@sha256:' in images[kind] for kind in ('pi', 'codex', 'panel'))
built = json.loads((root / 'evidence/herdr-build.json').read_text())
assert built['go_tests'] and built['typescript_build'] and built['python_unit_tests'] >= 14
assert built['images'] == images, 'The verified images differ from this candidate'
new_templates = {}
old_templates = {kind: template(kind) for kind in ('pi', 'codex', 'python')}
for kind in ('pi', 'codex'):
    new = template('herdr-' + kind)
    new['metadata']['name'] = kind
    assert new['containers'][0]['image'] == images[kind]
    old = json.loads(json.dumps(old_templates[kind]))
    old['containers'][0]['image'] = images[kind]
    assert new == old, 'Sandbox/storage/resource settings changed'
    new_templates[kind] = new
actors = client.request('GET', '/api/agents').get('actors', [])
assert all(a['metadata']['name'] == old_name and a['metadata']['uid'] == old_uid for a in actors), 'Unexpected agent exists; switch refused'
backup = live / 'archives' / ('before-herdr-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
backup.mkdir(parents=True, mode=0o700)
for item in ('runtime', 'panel', 'deploy', 'tests', 'agent.py', 'README.md', 'images.json'):
    source = live / item
    if source.is_dir():
        shutil.copytree(source, backup / item, ignore=shutil.ignore_patterns('node_modules', 'dist', '__pycache__'))
    else:
        shutil.copy2(source, backup / item)
legacy_cli = Path.home() / 'agent-sandbox-setup/shared-auth/agent.py'
shutil.copy2(legacy_cli, backup / 'agent-previous.py')
(backup / 'templates.json').write_text(json.dumps(old_templates, indent=2) + '\n')
deployment = json.loads(run('kubectl', '-n', 'pvm-agents', 'get', 'deployment', 'panel', '-o', 'json'))
(backup / 'panel-deployment.json').write_text(json.dumps(deployment, indent=2) + '\n')
print('Rollback configuration:', backup, flush=True)
changed_templates = []
forward('stop')
try:
    pid = int((root / 'candidate-forward.pid').read_text())
    try:
        command = Path(f'/proc/{pid}/cmdline').read_bytes()
        assert b'port-forward' in command and b'panel-herdr-candidate' in command, 'Candidate forward PID changed'
        os.kill(pid, 15)
    except FileNotFoundError:
        pass
    actors = json.loads(run(ate, 'get', 'actors', '-a', 'pvm-agents', '-o', 'json')).get('actors', [])
    assert all(a['metadata']['name'] == old_name and a['metadata']['uid'] == old_uid for a in actors), 'Inventory changed during maintenance'
    if actors:
        current = json.loads(run(ate, 'get', 'actor', old_name, '-a', 'pvm-agents', '-o', 'json'))
        assert current['metadata']['uid'] == old_uid, 'Same name has a different UID; delete refused'
        if current['status']['state'] not in ('ACTOR_STATE_SUSPENDED', 'ACTOR_STATE_CRASHED', 'ACTOR_STATE_DELETING'):
            suspended = json.loads(run(ate, 'suspend', 'actor', old_name, '-a', 'pvm-agents', '-o', 'json'))
            assert suspended['status']['state'] == 'ACTOR_STATE_SUSPENDED'
            assert any(s.get('durableSnapshot', {}).get('status') == 'SNAPSHOT_STORAGE_STATUS_COMPLETED' for s in suspended['status'].get('snapshots', []))
        run(ate, 'delete', 'actor', old_name, '-a', 'pvm-agents')
        deadline = time.monotonic() + 180
        while any(a['metadata']['uid'] == old_uid for a in json.loads(run(ate, 'get', 'actors', '-a', 'pvm-agents', '-o', 'json')).get('actors', [])):
            assert time.monotonic() < deadline, 'Actor deletion did not complete'
            time.sleep(1)
        target_file = root / 'evidence/cleanup-targets.json'
        targets = json.loads(target_file.read_text())
        targets.append({'name': old_name, 'uid': old_uid})
        target_file.write_text(json.dumps(targets, indent=2) + '\n')
        sp.run([sys.executable, str(root / 'tests/cleanup.py'), '--audit-only'], check=True)
    assert not json.loads(run(ate, 'get', 'actors', '-a', 'pvm-agents', '-o', 'json')).get('actors', []), 'Template references remain'
    for kind in ('pi', 'codex', 'python'):
        run(ate, 'delete', 'actor-template', kind, '-a', 'pvm-agents')
        changed_templates.append(kind)
        if kind in new_templates:
            run(ate, 'create', 'actor-template', '-f', '-', data=new_templates[kind])
    run('kubectl', '-n', 'pvm-agents', 'set', 'image', 'deployment/panel', 'panel=' + images['panel'])
    run('kubectl', '-n', 'pvm-agents', 'rollout', 'status', 'deployment/panel', '--timeout=180s')
    for item in ('runtime', 'panel', 'deploy', 'tests', 'README.md', 'agent.py'):
        source = root / item
        if source.is_dir():
            shutil.copytree(source, live / item, dirs_exist_ok=True, ignore=shutil.ignore_patterns('node_modules', 'dist', '__pycache__'))
        else:
            shutil.copy2(source, live / item)
    (live / 'runtime/configure_pi.py').unlink(missing_ok=True)
    shutil.copy2(root / 'agent.py', legacy_cli)
    old_images.update(agents={kind: images[kind] for kind in ('pi', 'codex')}, panel=images['panel'], herdr='0.9.5')
    (live / 'images.json').write_text(json.dumps(old_images, indent=2) + '\n')
    report = {'images': old_images, 'rollback': str(backup), 'removed_actor': {'name': old_name, 'uid': old_uid},
              'new_user_agent_created': False, 'switched_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    (root / 'evidence/herdr-cutover.json').write_text(json.dumps(report, indent=2) + '\n')
except Exception:
    for kind in changed_templates:
        sp.run([ate, 'delete', 'actor-template', kind, '-a', 'pvm-agents'], stdout=sp.DEVNULL, stderr=sp.DEVNULL)
        run(ate, 'create', 'actor-template', '-f', '-', data=old_templates[kind])
    previous_image = deployment['spec']['template']['spec']['containers'][0]['image']
    run('kubectl', '-n', 'pvm-agents', 'set', 'image', 'deployment/panel', 'panel=' + previous_image)
    run('kubectl', '-n', 'pvm-agents', 'rollout', 'status', 'deployment/panel', '--timeout=180s')
    shutil.copy2(backup / 'agent-previous.py', legacy_cli)
    shutil.copy2(backup / 'images.json', live / 'images.json')
    raise
finally:
    forward('start')
print('Herdr switch complete; original images/templates retained for rollback. User agent not recreated.', flush=True)

"""Stage the console with isolated sessions and, when enabled, its own Worker catalog."""
import json
import runpy
import os
from pathlib import Path
import signal
import socket
import subprocess as sp
import time
import urllib.request

root = Path(__file__).resolve().parents[1]
storage = runpy.run_path(str(Path(__file__).with_name("panel-image.py")))
configure_session_storage = storage["configure_session_storage"]
ensure_session_claim = storage["ensure_session_claim"]
stage_worker_candidate = runpy.run_path(str(Path(__file__).with_name("worker-profiles.py")))["stage_candidate"]
request = urllib.request.Request('http://127.0.0.1:5001/v2/panel/manifests/console-0.4.8', headers={'Accept': 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json'})
with urllib.request.urlopen(request) as response:
    image = 'localhost:5001/panel@' + response.headers['Docker-Content-Digest']
deployment = json.loads(sp.check_output(['kubectl', '-n', 'pvm-agents', 'get', 'deployment', 'panel', '-o', 'json']))
deployment['metadata'] = {'name': 'panel-console-candidate', 'namespace': 'pvm-agents'}
configure_session_storage(deployment, "panel-console-candidate-sessions")
ensure_session_claim("panel-console-candidate-sessions")
deployment.pop('status', None)
deployment['spec']['selector']['matchLabels'] = {'app': 'panel-console-candidate'}
deployment['spec']['template']['metadata'] = {'labels': {'app': 'panel-console-candidate'}}
container = deployment['spec']['template']['spec']['containers'][0]
container['image'] = image
container['env'] = [item for item in container.get('env', []) if item['name'] not in ('PANEL_ORIGIN', 'CONSOLE_ENABLED', 'AGENT_IDLE_TIMEOUT')]
container['env'] += [{'name': 'CONSOLE_ENABLED', 'value': 'true'}, {'name': 'AGENT_IDLE_TIMEOUT', 'value': '0s'}, {'name': 'PANEL_ORIGIN', 'value': 'https://192.0.2.10:18443'}]
if not any(item['name'] == 'AGENT_TEMPLATE_PREFIX' for item in container['env']):
    container['env'].append({'name': 'AGENT_TEMPLATE_PREFIX', 'value': ''})
if not any(item['name'] == 'WORKER_MAX_REPLICAS' for item in container['env']):
    container['env'].append({'name': 'WORKER_MAX_REPLICAS', 'value': '8'})
if not any(volume['name'] == 'kubernetes' for volume in deployment['spec']['template']['spec']['volumes']):
    deployment['spec']['template']['spec']['volumes'].append({'name': 'kubernetes', 'projected': {'defaultMode': 0o440, 'sources': [
        {'serviceAccountToken': {'expirationSeconds': 3600, 'path': 'token'}},
        {'configMap': {'name': 'kube-root-ca.crt', 'items': [{'key': 'ca.crt', 'path': 'ca.crt'}]}}]}})
    container['volumeMounts'].append({'name': 'kubernetes', 'mountPath': '/run/kubernetes', 'readOnly': True})
deployment['spec']['template']['spec']['volumes'] = [volume for volume in deployment['spec']['template']['spec']['volumes'] if volume['name'] != 'console-database']
container['volumeMounts'] = [mount for mount in container['volumeMounts'] if mount['name'] != 'console-database']
stage_worker_candidate(deployment)
sp.run(['kubectl', 'apply', '-f', '-'], input=json.dumps(deployment).encode(), check=True)
sp.run(['kubectl', '-n', 'pvm-agents', 'rollout', 'status', 'deployment/panel-console-candidate', '--timeout=180s'], check=True)
(root / 'evidence').mkdir(exist_ok=True)
(root / 'evidence/console-candidate.json').write_text(json.dumps({'image': image}, indent=2) + '\n')
for process_dir in Path('/proc').iterdir():
    if not process_dir.name.isdigit():
        continue
    try:
        args = (process_dir / 'cmdline').read_bytes().split(b'\0')
        if args[0].endswith(b'kubectl') and all(value in args for value in (b'port-forward', b'deployment/panel-console-candidate', b'18443:8443')):
            os.kill(int(process_dir.name), signal.SIGTERM)
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        pass
deadline = time.monotonic() + 10
while True:
    with socket.socket() as probe:
        probe.settimeout(1)
        if probe.connect_ex(('192.0.2.10', 18443)) != 0:
            break
    assert time.monotonic() < deadline, 'Previous candidate listener did not release port 18443'
    time.sleep(0.05)
with (root / 'console-forward.log').open('ab') as log:
    process = sp.Popen(['kubectl', '-n', 'pvm-agents', 'port-forward', '--address=192.0.2.10',
                       'deployment/panel-console-candidate', '18443:8443'], stdin=sp.DEVNULL, stdout=log, stderr=log, start_new_session=True)
(root / 'console-forward.pid').write_text(str(process.pid))
deadline = time.monotonic() + 10
while True:
    assert process.poll() is None, 'Candidate port-forward failed; inspect console-forward.log'
    try:
        with socket.create_connection(('192.0.2.10', 18443), timeout=1):
            break
    except OSError:
        assert time.monotonic() < deadline, 'Candidate port-forward did not become ready'
        time.sleep(0.1)
print('Console candidate: https://192.0.2.10:18443')

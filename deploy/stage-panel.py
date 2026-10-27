"""Run the candidate panel on port 18443 against the isolated Herdr templates."""
import json
import runpy
from pathlib import Path
import subprocess as sp
import urllib.request

root = Path(__file__).resolve().parents[1]
if sp.check_output(["kubectl", "-n", "pvm-agents", "get", "configmap", "worker-profiles", "--ignore-not-found", "-o", "name"]).strip():
    raise SystemExit("Worker profiles require deploy/stage-native.py or deploy/stage-console.py with an isolated catalog")
storage = runpy.run_path(str(Path(__file__).with_name("panel-image.py")))
configure_session_storage = storage["configure_session_storage"]
ensure_session_claim = storage["ensure_session_claim"]
request = urllib.request.Request('http://127.0.0.1:5001/v2/panel/manifests/herdr-0.9.5', headers={'Accept': 'application/vnd.oci.image.index.v1+json'})
with urllib.request.urlopen(request) as response:
    image = 'localhost:5001/panel@' + response.headers['Docker-Content-Digest']
images = json.loads((root / 'herdr-images.json').read_text())
images['panel'] = image
(root / 'herdr-images.json').write_text(json.dumps(images, indent=2) + '\n')
deployment = json.loads(sp.check_output(['kubectl', '-n', 'pvm-agents', 'get', 'deployment', 'panel', '-o', 'json']))
deployment['metadata'] = {'name': 'panel-herdr-candidate', 'namespace': 'pvm-agents'}
configure_session_storage(deployment, "panel-herdr-candidate-sessions")
ensure_session_claim("panel-herdr-candidate-sessions")
deployment.pop('status', None)
deployment['spec']['selector']['matchLabels'] = {'app': 'panel-herdr-candidate'}
deployment['spec']['template']['metadata'] = {'labels': {'app': 'panel-herdr-candidate'}}
container = deployment['spec']['template']['spec']['containers'][0]
container['image'] = image
container['env'] = [{'name': 'AGENT_TEMPLATE_PREFIX', 'value': 'herdr-'},
                    {'name': 'PANEL_ORIGIN', 'value': 'https://192.0.2.10:18443'}]
sp.run(['kubectl', 'create', '-f', '-'], input=json.dumps(deployment).encode(), check=True)
sp.run(['kubectl', '-n', 'pvm-agents', 'rollout', 'status', 'deployment/panel-herdr-candidate', '--timeout=120s'], check=True)
with (root / 'candidate-forward.log').open('ab') as log:
    process = sp.Popen(['kubectl', '-n', 'pvm-agents', 'port-forward', '--address=192.0.2.10',
                       'deployment/panel-herdr-candidate', '18443:8443'], stdin=sp.DEVNULL, stdout=log, stderr=log, start_new_session=True)
(root / 'candidate-forward.pid').write_text(str(process.pid))
print('Candidate panel: https://192.0.2.10:18443, existing TLS and Basic authentication')

"""Create isolated Herdr templates and test actors without changing the live templates."""
import json
from pathlib import Path
import subprocess as sp
import sys
import urllib.request

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from agent import Client

ate = str(root / 'vendor/substrate/bin/kubectl-ate')
pki = Path.home() / '.config/substrate-panel'
client = Client('https://192.0.2.10:8443', pki / 'ca.crt', pki / 'password')


def run(*args, data=None):
    return sp.check_output([ate, *args], input=None if data is None else json.dumps(data).encode())


def execute(name, argv):
    result = client.request('POST', '/api/agents/' + name + '/exec', {'argv': argv})
    assert result['exit_code'] == 0, result['output']
    return result['output'].strip()


images = {}
for kind in ('pi', 'codex'):
    request = urllib.request.Request(f'http://127.0.0.1:5001/v2/agents/{kind}/manifests/herdr-0.9.5', headers={'Accept': 'application/vnd.oci.image.index.v1+json'})
    with urllib.request.urlopen(request) as response:
        image = f'localhost:5001/agents/{kind}@{response.headers["Docker-Content-Digest"]}'
    images[kind] = image
    (root / 'herdr-images.json').write_text(json.dumps(images, indent=2) + '\n')
    template = json.loads(run('get', 'actor-template', kind, '-a', 'pvm-agents', '-o', 'json'))
    template['metadata'] = {'atespace': 'pvm-agents', 'name': 'herdr-' + kind}
    template.pop('status', None)
    template['containers'][0]['image'] = image
    run('create', 'actor-template', '-f', '-', data=template)
    name = 'verify-herdr-' + kind
    actor = json.loads(run('create', 'actor', name, '-a', 'pvm-agents', '--template', 'herdr-' + kind, '-o', 'json'))
    targets = root / 'evidence/cleanup-targets.json'
    targets.parent.mkdir(exist_ok=True)
    previous = json.loads(targets.read_text()) if targets.exists() else []
    targets.write_text(json.dumps([*previous, {'name': name, 'uid': actor['metadata']['uid']}], indent=2) + '\n')
    policy = {'rules': [{'tlsPassthrough': {'hostnames': ['*'], 'ports': {'numbers': [443]}}},
                        {'http': {'hostnames': ['*'], 'ports': {'numbers': [80]}}}]}
    run('create', 'egress-policy', name, '-a', 'pvm-agents', '-f', '-', data=policy)
    client.request('POST', '/api/agents/' + name + '/resume')
    print('STARTED', name, flush=True)
    script = "import json,urllib.request; r=urllib.request.Request('http://127.0.0.1/session',data=b'{}',headers={'Content-Type':'application/json'}); print(urllib.request.urlopen(r,timeout=80).read().decode())"
    try:
        print(execute(name, ['python3', '-c', script]), flush=True)
    except Exception:
        print(execute(name, ['tail', '-30', '/workspace/.agent-state/herdr.log']), flush=True)
        print(execute(name, ['herdr', 'pane', 'list']), flush=True)
        print(execute(name, ['herdr', 'pane', 'read', 'w1:p1']), flush=True)
        raise
(root / 'herdr-images.json').write_text(json.dumps(images, indent=2) + '\n')

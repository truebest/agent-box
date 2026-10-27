"""MEMORY restore on a different worker while a Herdr pane owns a memory-only value."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess as sp
import sys
import time

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from agent import Client

pki = Path.home() / '.config/substrate-panel'
client = Client(os.environ.get('AGENT_URL', 'https://192.0.2.10:18443'), pki / 'ca.crt', pki / 'password')
name = 'verify-herdr-pi'
path = '/api/agents/' + name


def execute(argv):
    result = client.request('POST', path + '/exec', {'argv': argv})
    assert result['exit_code'] == 0, result['output']
    return result['output'].strip()


state = client.request('GET', path + '/session')
conversation = state['runner']['agent_session']
created = json.loads(execute(['herdr', 'tab', 'create', '--label', 'memory-proof', '--cwd', '/workspace']))
pane = created['result']['root_pane']['pane_id']
program = '''from http.server import BaseHTTPRequestHandler,HTTPServer
import secrets
value=secrets.token_hex(32)
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(value.encode())
 def log_message(self,*args): pass
HTTPServer(('127.0.0.1',8082),H).serve_forever()
'''
execute(['herdr', 'pane', 'run', pane, 'python3 -c ' + shlex.quote(program)])
probe = ['python3', '-c', "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8082').read().decode())"]
value = execute(probe)
client.request('POST', path + '/prompt', {'prompt': 'Use bash to run python3 -c \'import pathlib,time;pathlib.Path("/workspace/memory-start").write_text("started");time.sleep(45);pathlib.Path("/workspace/memory-done").write_text("continued")\'. After the command finishes, write the codeword you remember from our earlier conversation into /workspace/memory-context.txt.'})
deadline = time.monotonic() + 60
while execute(['python3', '-c', "from pathlib import Path;print(Path('/workspace/memory-start').exists())"]) != 'True':
    assert time.monotonic() < deadline
    time.sleep(1)
actor = client.request('GET', path)
worker = actor['status']['workerAssignment']['workerPod']
# Only this test's known companion may be suspended automatically.
companion = client.request('GET', '/api/agents/verify-herdr-codex')
if companion['status']['state'] == 'ACTOR_STATE_RUNNING' and companion['status']['workerAssignment']['workerPod'] == worker:
    client.request('POST', '/api/agents/verify-herdr-codex/suspend')
suspended = client.request('POST', path + '/suspend')
snapshots = suspended['status']['snapshots']
assert any(s['fidelity'] == 'SNAPSHOT_FIDELITY_MEMORY' and s.get('durableSnapshot', {}).get('status') == 'SNAPSHOT_STORAGE_STATUS_COMPLETED' for s in snapshots)
inventory = json.loads(sp.check_output([str(root / 'vendor/substrate/bin/kubectl-ate'), 'get', 'actors', '-A', '-o', 'json']))
for other in inventory.get('actors', []):
    assert other.get('status', {}).get('state') != 'ACTOR_STATE_RUNNING' or other['status'].get('workerAssignment', {}).get('workerPod') != worker, 'Running agent uses this worker; replacement refused'
sp.run(['kubectl', '-n', 'pvm-agents', 'delete', 'pod', worker, '--wait=true', '--timeout=60s'], check=True)
restored = client.request('POST', path + '/resume')
assert restored['status']['workerAssignment']['workerPod'] != worker
assert execute(probe) == value, 'Memory-only value changed'
deadline = time.monotonic() + 150
while True:
    proof = execute(['python3', '-c', "from pathlib import Path;p=Path('/workspace/memory-done');q=Path('/workspace/memory-context.txt');print((p.read_text() if p.exists() else 'pending')+':'+(q.read_text() if q.exists() else 'pending'))"])
    state = client.request('GET', path + '/session')
    if proof == 'continued:chrysanthemum' and state['runner']['agent_status'] in ('idle', 'done'):
        break
    assert time.monotonic() < deadline, (proof, state)
    time.sleep(1)
assert state['runner']['agent_session'] == conversation
client.request('POST', '/api/agents/verify-herdr-codex/resume')
report = {'memory': True, 'worker_before': worker, 'worker_after': restored['status']['workerAssignment']['workerPod'],
          'snapshots': snapshots, 'memory_only_value_sha256': hashlib.sha256(value.encode()).hexdigest(),
          'files_retained': True, 'same_conversation': True, 'task_continued': True}
(root / 'evidence/herdr-memory.json').write_text(json.dumps(report, indent=2) + '\n')
print('PASS MEMORY upload completed, different worker, memory-only value, files and live task/conversation retained', flush=True)

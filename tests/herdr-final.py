"""Verify the installed CLI and both stable templates after the Herdr switch."""
import json
from pathlib import Path
import subprocess as sp
import sys
import time
import uuid

from models import client, execute, root, session_request

results = {}
for kind in ('pi', 'codex'):
    name = 'verify-final-' + kind + '-' + uuid.uuid4().hex[:8]
    actor = client.request('POST', '/api/agents', {'name': name, 'kind': kind})
    assert actor['actorTemplate']['name'] == kind
    targets = root / 'evidence/cleanup-targets.json'
    previous = json.loads(targets.read_text())
    previous.append({'name': name, 'uid': actor['metadata']['uid']})
    targets.write_text(json.dumps(previous, indent=2) + '\n')
    marker = 'FINAL_' + kind.upper() + '_OK'
    prompt = f'Use a tool to compute 3*7. Write exactly {marker}:21 into /workspace/final-proof.txt. Report the result.'
    started = time.monotonic()
    sent = sp.run([sys.executable, str(Path.home() / 'agent-sandbox-setup/shared-auth/agent.py'), name,
                   '--prompt', prompt], text=True, capture_output=True, timeout=10)
    elapsed = time.monotonic() - started
    assert sent.returncode == 0 and 'Sent to the agent terminal' in sent.stdout, sent.stderr
    assert elapsed < 5
    deadline = time.monotonic() + 120
    while True:
        proof = execute(name, ['python3', '-c', "from pathlib import Path;p=Path('/workspace/final-proof.txt');print(p.read_text() if p.exists() else 'pending')"])
        state = session_request(name, 'GET', '/session')
        if proof == marker + ':21' and state['runner']['agent_status'] in ('idle', 'done'):
            break
        assert time.monotonic() < deadline, kind
        time.sleep(1)
    assert state['ready'] and state['runner']['agent_session']
    results[kind] = {'stable_template': kind, 'actor_uid': actor['metadata']['uid'], 'model': state['model'],
                     'native_tool_response': True, 'installed_cli_seconds': elapsed}
    (root / 'evidence/herdr-final.json').write_text(json.dumps(results, indent=2) + '\n')
    print('PASS installed', kind, 'template, saved CLI path, asynchronous real tool response', flush=True)

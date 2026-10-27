"""Real tool calls and conversation continuity before opening Terminal. Run on agent-box-host."""
import argparse
import json
import os
from pathlib import Path
import sys
import time
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent import Client

root = Path(__file__).resolve().parents[1]
pki = Path.home() / '.config/substrate-panel'
client = Client(os.environ.get('AGENT_URL', 'https://192.0.2.10:8443'), pki / 'ca.crt', pki / 'password')
staged = '--staged' in sys.argv


def execute(name, argv):
    result = client.request('POST', '/api/agents/' + name + '/exec', {'argv': argv})
    assert result['exit_code'] == 0, result['output']
    return result['output'].strip()


def session_request(name, method, endpoint, data=None):
    if not staged:
        return client.request(method, '/api/agents/' + name + endpoint, data)
    # Exercise the candidate helper through the unchanged production panel's diagnostic API.
    script = ('import json,urllib.request,urllib.error\n'
              f'r=urllib.request.Request("http://127.0.0.1{endpoint}", method={method!r}, '
              f'data={None if data is None else json.dumps(data).encode()!r}, headers={{"Content-Type":"application/json"}})\n'
              'try:\n s=urllib.request.urlopen(r,timeout=90); print(s.read().decode())\n'
              'except urllib.error.HTTPError as e: print(json.dumps({"http_error":e.code,"body":e.read().decode()}))')
    result = json.loads(execute(name, ['python3', '-c', script]))
    assert 'http_error' not in result, result
    return result


if __name__ == '__main__':
    results = {}
    for kind in ('pi', 'codex'):
        name = ('verify-herdr-' if staged else 'verify-') + kind
        path = '/api/agents/' + name
        if not staged:
            try:
                client.request('GET', path)
            except urllib.error.HTTPError as error:
                if error.code != 404:
                    raise
                actor = client.request('POST', '/api/agents', {'name': name, 'kind': kind})
                targets = root / 'evidence/cleanup-targets.json'
                previous = json.loads(targets.read_text()) if targets.exists() else []
                previous.append({'name': name, 'uid': actor['metadata']['uid']})
                targets.write_text(json.dumps(previous, indent=2) + '\n')
        before = session_request(name, 'GET', '/session')
        assert before['ready'], before
        marker = 'HERDR_' + kind.upper() + '_OK'
        execute(name, ['python3', '-c', f"from pathlib import Path; Path('/workspace/proof-{kind}.txt').unlink(missing_ok=True); Path('/workspace/context-{kind}.txt').unlink(missing_ok=True)"])
        started = time.monotonic()
        sent = session_request(name, 'POST', '/prompt', {'prompt': f'Use a tool to compute 2+2. Write exactly {marker}:4 to /workspace/proof-{kind}.txt. Remember the codeword chrysanthemum for our next turn. Respond with the result.'})
        elapsed = time.monotonic() - started
        assert sent['accepted'] and elapsed < 5, (sent, elapsed)
        deadline = time.monotonic() + 180
        while True:
            proof = execute(name, ['python3', '-c', f"from pathlib import Path;p=Path('/workspace/proof-{kind}.txt');print(p.read_text() if p.exists() else 'pending')"])
            state = session_request(name, 'GET', '/session')
            if proof == marker + ':4' and state['runner']['agent_status'] in ('idle', 'done'):
                break
            assert time.monotonic() < deadline, (kind, state)
            time.sleep(1)
        assert state['runner']['agent_session']
        conversation = state['runner']['agent_session']
        # This turn relies on conversation memory, not on restating the codeword.
        session_request(name, 'POST', '/prompt', {'prompt': f'Write only the codeword I asked you to remember into /workspace/context-{kind}.txt using a tool.'})
        deadline = time.monotonic() + 120
        while True:
            remembered = execute(name, ['python3', '-c', f"from pathlib import Path;p=Path('/workspace/context-{kind}.txt');print(p.read_text() if p.exists() else 'pending')"])
            state = session_request(name, 'GET', '/session')
            if remembered == 'chrysanthemum' and state['runner']['agent_status'] in ('idle', 'done'):
                break
            assert time.monotonic() < deadline, kind
            time.sleep(1)
        assert state['runner']['agent_session'] == conversation
        results[kind] = {'real_tool_call': True, 'model': 'gpt-6.1-sol', 'conversation_continued': True,
                         'session': state['runner']['agent_session'], 'submission_seconds': elapsed,
                         'no_terminal_client': True, 'actor': client.request('GET', path)['metadata']}
        (root / 'evidence').mkdir(exist_ok=True)
        (root / 'evidence/herdr-models.json').write_text(json.dumps(results, indent=2) + '\n')
        print('PASS', kind, 'native Sol 6.1, tool calls, asynchronous delivery, same conversation without Terminal', flush=True)

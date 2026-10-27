"""Verify deletion after a test-only worker is replaced. Run on agent-box-host."""
from pathlib import Path
import datetime
import json
import os
import subprocess as sp
import sys
import time
import urllib.error
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent import Client

root = Path(__file__).resolve().parents[1]
pki = Path.home() / '.config/substrate-panel'
client = Client(os.environ.get('AGENT_URL', 'https://192.0.2.10:8443'), str(pki / 'ca.crt'), str(pki / 'password'))
name = 'verify-crash-' + uuid.uuid4().hex[:12]
endpoint = '/api/agents/' + name
created = False
uid = None
report = {}

try:
    try:
        actor = client.request('POST', '/api/agents', {'name': name, 'kind': 'pi'})
    except urllib.error.HTTPError as error:
        if error.code >= 500:
            try:
                partial = client.request('GET', endpoint)
            except urllib.error.HTTPError as lookup:
                if lookup.code != 404:
                    raise
            else:
                assert partial['metadata']['name'] == name and partial['actorTemplate']['name'] == 'pi'
                sp.run([str(root / 'vendor/substrate/bin/kubectl-ate'), 'delete', 'actor', name,
                        '-a', 'pvm-agents', '--any-state'], check=True, stdout=sp.DEVNULL)
        raise
    created = True
    uid = actor['metadata']['uid']
    assert str(uuid.UUID(uid)) == uid
    target_file = root / 'evidence/cleanup-targets.json'
    targets = json.loads(target_file.read_text()) if target_file.exists() else []
    targets.append({'name': name, 'uid': uid})
    target_file.write_text(json.dumps(targets, indent=2) + '\n')
    assert not actor['status'].get('snapshots')
    try:
        client.request('POST', endpoint + '/revert')
        raise AssertionError('Restore without a snapshot unexpectedly succeeded')
    except urllib.error.HTTPError as error:
        assert error.code == 409 and 'No completed snapshot' in error.read().decode()
    after = client.request('GET', endpoint)
    assert after['metadata']['version'] == actor['metadata']['version']
    assert after['status']['state'] == 'ACTOR_STATE_RUNNING'
    report['no_snapshot_revert'] = '409; actor was not modified'
    print('PASS restore without a snapshot refused without modifying the actor', flush=True)

    worker = actor['status']['workerAssignment']['workerPod']
    inventory = json.loads(sp.check_output([str(root / 'vendor/substrate/bin/kubectl-ate'), 'get', 'actors', '-A', '-o', 'json']))
    for other in inventory.get('actors', []):
        placement = other.get('status', {}).get('workerAssignment', {}).get('workerPod')
        assert other['metadata']['name'] == name or placement != worker, 'Another actor uses the worker; restart refused'
    sp.run(['kubectl', '-n', 'pvm-agents', 'delete', 'pod', worker,
            '--grace-period=1', '--wait=true', '--timeout=30s'], check=True)
    deadline = time.monotonic() + 100
    while True:
        actor = client.request('GET', endpoint)
        if actor['status']['state'] == 'ACTOR_STATE_CRASHED':
            break
        assert time.monotonic() < deadline, 'Worker did not report the test actor crash'
        time.sleep(2)
    report['crash'] = actor['status']['crash']['message']
    report['actor'] = {'name': name, 'uid': uid}
    print('PASS test actor entered CRASHED after replacing its worker', flush=True)
    try:
        client.request('POST', endpoint + '/revert')
        raise AssertionError('Crashed actor without a snapshot was reset')
    except urllib.error.HTTPError as error:
        assert error.code == 409
    assert client.request('GET', endpoint)['status']['state'] == 'ACTOR_STATE_CRASHED'
    client.request('DELETE', endpoint)
    created = False
    try:
        client.request('GET', endpoint)
        raise AssertionError('Deleted actor is still visible')
    except urllib.error.HTTPError as error:
        assert error.code == 404
    report['delete_crashed'] = 'completed; GetActor returns 404'
    report['verified_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    (root / 'evidence/herdr-crashed-delete.json').write_text(json.dumps(report, indent=2) + '\n')
    print('PASS delete CRASHED actor without Suspend or Revert', flush=True)
finally:
    if created:
        current = client.request('GET', endpoint)
        assert current['metadata']['uid'] == uid
        sp.run([str(root / 'vendor/substrate/bin/kubectl-ate'), 'delete', 'actor', name,
                '-a', 'pvm-agents', '--any-state'], check=True, stdout=sp.DEVNULL)

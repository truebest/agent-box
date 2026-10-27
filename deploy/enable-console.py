"""Enable only the console image that passed the candidate checks; retain rollback."""
import datetime
import json
from pathlib import Path
import subprocess as sp

root = Path(__file__).resolve().parents[1]
evidence = json.loads((root / 'evidence/console-verification.json').read_text())
required = ('pi', 'codex', 'uid_isolation', 'keyboard_resize_reconnect', 'browser_independence',
            'memory_other_worker', 'http_ws_auth_origin', 'files', 'recreated_name', 'existing_codex',
            'integrated_navigation', 'worker_filter', 'message_source_checks')
assert all(evidence.get(key) is True for key in required), 'Console compatibility checks are incomplete'
candidate = json.loads(sp.check_output(['kubectl', '-n', 'pvm-agents', 'get', 'deployment', 'panel-console-candidate', '-o', 'json']))
image = candidate['spec']['template']['spec']['containers'][0]['image']
assert evidence['image'] == image, 'Verification belongs to another candidate image'
live = json.loads(sp.check_output(['kubectl', '-n', 'pvm-agents', 'get', 'deployment', 'panel', '-o', 'json']))
backup = root / 'archives' / ('before-console-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
backup.mkdir(parents=True)
(backup / 'panel.json').write_text(json.dumps(live, indent=2) + '\n')
if (root / 'images.json').exists():
    (backup / 'images.json').write_bytes((root / 'images.json').read_bytes())
container = live['spec']['template']['spec']['containers'][0]
old_image = container['image']
container['image'] = image
container['env'] = [item for item in container.get('env', []) if item['name'] != 'CONSOLE_ENABLED'] + [{'name': 'CONSOLE_ENABLED', 'value': 'true'}]
patch = {'spec': {'template': {'spec': {'containers': [container]}}}}
try:
    sp.run(['kubectl', '-n', 'pvm-agents', 'patch', 'deployment', 'panel', '--type=strategic', '-p', json.dumps(patch)], check=True)
    sp.run(['kubectl', '-n', 'pvm-agents', 'rollout', 'status', 'deployment/panel', '--timeout=180s'], check=True)
except BaseException:
    old = json.loads((backup / 'panel.json').read_text())['spec']['template']['spec']['containers'][0]
    sp.run(['kubectl', '-n', 'pvm-agents', 'patch', 'deployment', 'panel', '--type=json', '-p', json.dumps([{'op': 'replace', 'path': '/spec/template/spec/containers/0', 'value': old}])], check=True)
    raise
images = json.loads((root / 'images.json').read_text()) if (root / 'images.json').exists() else {}
images.update(panel=image, console={'version': '0.4.8', 'commit': 'cb65ecb9d1d251b42a6875427b6c7d0958150796'})
(root / 'images.json').write_text(json.dumps(images, indent=2) + '\n')
(root / 'evidence/console-cutover.json').write_text(json.dumps({'image': image, 'previous_image': old_image, 'backup': str(backup)}, indent=2) + '\n')
print('Console enabled; rollback:', backup)

"""Prepare the configured host's XFS workspace volume and KIND node."""
import datetime
from pathlib import Path
import subprocess as sp
from configuration import load

config = load()
if sp.check_output(["hostname"], text=True).strip() != config["hostname"]:
    raise SystemExit("This host does not match the installation configuration")


def run(*args, **kwargs):
    return sp.run(args, check=True, text=True, **kwargs)


inotify = max(1024, int(Path('/proc/sys/fs/inotify/max_user_instances').read_text()))
Path('/etc/sysctl.d/90-agent-box-inotify.conf').write_text(f'fs.inotify.max_user_instances={inotify}\n')
run('sysctl', '-w', f'fs.inotify.max_user_instances={inotify}')
volume = '/dev/' + config['volume_group'] + '/' + config['workspace_volume']
if not Path(volume).exists():
    run('lvs', config['volume_group'] + '/' + config['thin_pool'], stdout=sp.DEVNULL)
    run('lvcreate', '-V', config['workspace_size'], '-T', config['volume_group'] + '/' + config['thin_pool'], '-n', config['workspace_volume'])
    run('mkfs.xfs', volume)
if sp.check_output(['blkid', '-s', 'TYPE', '-o', 'value', volume], text=True).strip() != 'xfs':
    raise RuntimeError('The workspace volume must use XFS')
mount = config['workspace_mount']
Path(mount).mkdir(parents=True, exist_ok=True)
if sp.run(['mountpoint', '-q', mount]).returncode == 0:
    source = sp.check_output(['findmnt', '-n', '-o', 'SOURCE', '--mountpoint', mount], text=True).strip()
    if Path(source).resolve() != Path(volume).resolve():
        raise RuntimeError('Workspace mount belongs to another device')
else:
    if any(Path(mount).iterdir()):
        raise RuntimeError('Workspace mount directory must be empty')
    run('mount', '-o', 'discard', volume, mount)
Path(mount, '.substrate-volume').touch()

mount_unit = sp.check_output(['systemd-escape', '--path', '--suffix=mount', mount], text=True).strip()
Path('/etc/systemd/system', mount_unit).write_text(f"""[Unit]
Description=Agent Box workspace volume
Before=docker.service
[Mount]
What={volume}
Where={mount}
Type=xfs
Options=discard
[Install]
WantedBy=multi-user.target
""")
dropin = Path('/etc/systemd/system/docker.service.d')
dropin.mkdir(exist_ok=True)
(dropin / ('agent-box-' + config['kind_cluster'] + '.conf')).write_text(f'[Unit]\nRequires={mount_unit}\nAfter={mount_unit}\n')
run('systemctl', 'daemon-reload')
run('systemctl', 'enable', '--now', mount_unit)

node = config['kind_node']
if sp.run(['docker', 'inspect', node], stdout=sp.DEVNULL, stderr=sp.DEVNULL).returncode:
    print('Workspace volume ready. Create the KIND cluster, then run this command again.')
    raise SystemExit(0)

backup = Path(config['repository']) / 'backups' / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup.mkdir(parents=True, mode=0o700)
for source in ('/etc/kubernetes/manifests/kube-apiserver.yaml', '/var/lib/kubelet/config.yaml'):
    run('docker', 'cp', f'{node}:{source}', str(backup / Path(source).name))
apiserver = (backup / 'kube-apiserver.yaml').read_text()
required = ('ClusterTrustBundle=true', 'ClusterTrustBundleProjection=true', 'PodCertificateRequest=true', 'certificates.k8s.io/v1beta1=true')
if not all(value in apiserver for value in required):
    raise RuntimeError('Create the cluster with deploy/create-cluster.py to enable the required Kubernetes features')
def mount_script(config):
    mount = config['workspace_mount']
    volume = '/dev/' + config['volume_group'] + '/' + config['workspace_volume']
    node = config['kind_node']
    mapper = config['volume_group'].replace('-', '--') + '-' + config['workspace_volume'].replace('-', '--')
    return f'''#!/bin/bash
set -euo pipefail
mountpoint -q {mount} || mount -o discard {volume} {mount}
pid=$(docker inspect -f '{{{{.State.Pid}}}}' {node})
test "$pid" -gt 0
nsenter -t "$pid" -m -- mkdir -p /var/lib/ate
if ! nsenter -t "$pid" -m -- mountpoint -q /var/lib/ate; then
    nsenter -t "$pid" -m -- mount -t xfs -o discard /host-dev/mapper/{mapper} /var/lib/ate
fi
nsenter -t "$pid" -m -- test -e /var/lib/ate/.substrate-volume
docker exec {node} sysctl net.ipv4.conf.all.proxy_arp=1
docker exec {node} sysctl -e net.ipv6.conf.all.proxy_ndp=1
while test "$(docker inspect -f '{{{{.State.Pid}}}}' {node})" = "$pid"; do sleep 3; done
exit 1
'''


path = Path('/usr/local/sbin/substrate-ate-mount')
path.write_text(mount_script(config))
path.chmod(0o700)
Path('/etc/systemd/system/substrate-ate-mount.service').write_text('''[Unit]
Description=Mount the Agent Box workspace volume in its KIND node
Requires=docker.service
After=docker.service
StartLimitIntervalSec=0
[Service]
ExecStart=/usr/local/sbin/substrate-ate-mount
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
''')
run('systemctl', 'daemon-reload')
run('systemctl', 'enable', '--now', 'substrate-ate-mount.service')
print('Host preparation complete.')

"""Run as root on agent-box-host, with the existing KIND container running."""
import datetime
from pathlib import Path
import subprocess as sp


def run(*args, **kwargs):
    return sp.run(args, check=True, text=True, **kwargs)


assert sp.check_output(["hostname"], text=True).strip() == "agent-box-host"
node = "agent-sandbox-demo-control-plane"
inotify_instances = max(1024, int(Path("/proc/sys/fs/inotify/max_user_instances").read_text()))
Path("/etc/sysctl.d/90-agent-box-inotify.conf").write_text(f"fs.inotify.max_user_instances={inotify_instances}\n")
run("sysctl", "-w", f"fs.inotify.max_user_instances={inotify_instances}")
backup = Path("/home/operator/substrate-agent-box-host/backups") / datetime.datetime.now(datetime.UTC).strftime("%Y%m%dT%H%M%SZ")
backup.mkdir(parents=True, mode=0o700)
for source in ("/etc/kubernetes/manifests/kube-apiserver.yaml", "/var/lib/kubelet/config.yaml"):
    run("docker", "cp", f"{node}:{source}", str(backup / Path(source).name))

apiserver = (backup / "kube-apiserver.yaml").read_text()
if "--feature-gates=" in apiserver:
    assert all(value in apiserver for value in ("ClusterTrustBundle=true", "ClusterTrustBundleProjection=true", "PodCertificateRequest=true", "certificates.k8s.io/v1beta1=true")), "Review existing feature gates before merging"
else:
    assert "--runtime-config=\n" in apiserver
    apiserver = apiserver.replace("--runtime-config=\n", "--runtime-config=certificates.k8s.io/v1beta1=true\n    - --feature-gates=ClusterTrustBundle=true,ClusterTrustBundleProjection=true,PodCertificateRequest=true\n")
    run("docker", "exec", "-i", node, "sh", "-c", "cat > /etc/kubernetes/manifests/kube-apiserver.yaml", input=apiserver)
kubelet = (backup / "config.yaml").read_text()
if "featureGates:" in kubelet:
    assert all(value in kubelet for value in ("ClusterTrustBundle: true", "ClusterTrustBundleProjection: true", "PodCertificateRequest: true"))
else:
    kubelet += "\nfeatureGates:\n  ClusterTrustBundle: true\n  ClusterTrustBundleProjection: true\n  PodCertificateRequest: true\nserializeImagePulls: false\nmaxParallelImagePulls: 4\n"
    run("docker", "exec", "-i", node, "sh", "-c", "cat > /var/lib/kubelet/config.yaml", input=kubelet)
    run("docker", "exec", node, "systemctl", "restart", "kubelet")

lv = "/dev/workspaces/substrate-ate"
if not Path(lv).exists():
    run("lvcreate", "-V", "256G", "-T", "workspaces/pool", "-n", "substrate-ate")
    run("mkfs.xfs", lv)
assert sp.check_output(["blkid", "-s", "TYPE", "-o", "value", lv], text=True).strip() == "xfs"
Path("/srv/substrate-ate").mkdir(exist_ok=True)
if sp.run(["mountpoint", "-q", "/srv/substrate-ate"]).returncode:
    run("mount", "-o", "discard", lv, "/srv/substrate-ate")
mount_script = '''#!/bin/bash
set -euo pipefail
lv=/dev/workspaces/substrate-ate
mountpoint -q /srv/substrate-ate || mount -o discard "$lv" /srv/substrate-ate
node=agent-sandbox-demo-control-plane
pid=$(docker inspect -f '{{.State.Pid}}' "$node")
test "$pid" -gt 0
nsenter -t "$pid" -m -- mkdir -p /var/lib/ate
if ! nsenter -t "$pid" -m -- mountpoint -q /var/lib/ate; then
  nsenter -t "$pid" -m -- mount -t xfs -o discard /var/lib/topolvm/host-dev/mapper/workspaces-substrate--ate /var/lib/ate
fi
nsenter -t "$pid" -m -- test -e /var/lib/ate/.substrate-volume
docker exec "$node" sysctl net.ipv4.conf.all.proxy_arp=1
docker exec "$node" sysctl -e net.ipv6.conf.all.proxy_ndp=1
while test "$(docker inspect -f '{{.State.Pid}}' "$node")" = "$pid"; do sleep 3; done
exit 1
'''
Path("/srv/substrate-ate/.substrate-volume").touch()
path = Path("/usr/local/sbin/substrate-ate-mount")
path.write_text(mount_script)
path.chmod(0o700)
Path("/etc/systemd/system/substrate-ate-mount.service").write_text('''[Unit]
Description=Mount Substrate thin volume into the existing KIND node
Requires=docker.service agent-sandbox-lvm-devices.service
After=docker.service agent-sandbox-lvm-devices.service
StartLimitIntervalSec=0
[Service]
ExecStart=/usr/local/sbin/substrate-ate-mount
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
''')
run("systemctl", "daemon-reload")
run("systemctl", "enable", "--now", "substrate-ate-mount.service")
print("Host preparation complete; backups:", backup)

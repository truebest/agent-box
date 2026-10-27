"""Prepare Secrets and the private local image registry on agent-box-host."""
import base64
import json
from pathlib import Path
import secrets
import subprocess as sp


def run(*args, **kwargs):
    return sp.run(args, check=True, text=True, **kwargs)


run("kubectl", "create", "namespace", "ate-system", "--dry-run=client", "-o", "json", stdout=open("/tmp/substrate-ns.json", "w"))
run("kubectl", "apply", "-f", "/tmp/substrate-ns.json")
existing = sp.check_output(["kubectl", "-n", "ate-system", "get", "secret", "substrate-storage", "--ignore-not-found", "-o", "name"], text=True)
if not existing.strip():
    values = {"access-key": secrets.token_hex(16), "secret-key": secrets.token_urlsafe(48), "postgres-password": secrets.token_urlsafe(48)}
    manifest = {"apiVersion": "v1", "kind": "Secret", "metadata": {"namespace": "ate-system", "name": "substrate-storage"},
                "data": {k: base64.b64encode(v.encode()).decode() for k, v in values.items()}}
    run("kubectl", "create", "-f", "-", input=json.dumps(manifest))
run("docker", "volume", "create", "--driver", "workspace-lvm", "substrate-registry")
if sp.run(["docker", "inspect", "kind-registry"], stdout=sp.DEVNULL, stderr=sp.DEVNULL).returncode:
    run("docker", "run", "-d", "--restart=always", "--name", "kind-registry", "--network", "kind", "-p", "127.0.0.1:5001:5000", "-v", "substrate-registry:/var/lib/registry", "registry:3")
else:
    info = json.loads(sp.check_output(["docker", "inspect", "kind-registry"]))[0]
    assert any(m.get("Name") == "substrate-registry" for m in info["Mounts"])
node = "agent-sandbox-demo-control-plane"
run("docker", "exec", node, "mkdir", "-p", "/etc/containerd/certs.d/localhost:5001")
run("docker", "exec", "-i", node, "sh", "-c", "cat > /etc/containerd/certs.d/localhost:5001/hosts.toml", input='[host."http://kind-registry:5000"]\n')
print("Storage Secret prepared; registry uses workspace-lvm.")

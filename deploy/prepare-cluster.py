"""Prepare storage credentials and the configured local image registry."""
import base64
import ipaddress
import json
import secrets
import subprocess as sp
from configuration import load, require_context

config = load()
require_context(config)


def run(*args, **kwargs):
    return sp.run(args, check=True, text=True, **kwargs)


namespace = sp.check_output(["kubectl", "create", "namespace", "ate-system", "--dry-run=client", "-o", "json"], text=True)
run("kubectl", "apply", "-f", "-", input=namespace)
existing = sp.check_output(["kubectl", "-n", "ate-system", "get", "secret", "substrate-storage", "--ignore-not-found", "-o", "name"], text=True)
if not existing.strip():
    values = {"access-key": secrets.token_hex(16), "secret-key": secrets.token_urlsafe(48), "postgres-password": secrets.token_urlsafe(48)}
    manifest = {"apiVersion": "v1", "kind": "Secret", "metadata": {"namespace": "ate-system", "name": "substrate-storage"},
                "data": {k: base64.b64encode(v.encode()).decode() for k, v in values.items()}}
    run("kubectl", "create", "-f", "-", input=json.dumps(manifest))
network = json.loads(sp.check_output(["docker", "network", "inspect", "kind"]))[0]
address = next((pool["Gateway"] for pool in network["IPAM"]["Config"]
                if pool.get("Gateway") and ipaddress.ip_address(pool["Gateway"]).version == 4), None)
if not address:
    raise RuntimeError("The KIND network needs an IPv4 gateway")
volume = sp.run(["docker", "volume", "inspect", config["registry_volume"]], capture_output=True)
if volume.returncode == 0:
    if json.loads(volume.stdout)[0]["Driver"] != config["registry_driver"]:
        raise RuntimeError("Existing registry volume uses another driver")
else:
    run("docker", "volume", "create", "--driver", config["registry_driver"], config["registry_volume"])
if sp.run(["docker", "container", "inspect", config["registry_name"]], stdout=sp.DEVNULL, stderr=sp.DEVNULL).returncode:
    run("docker", "run", "-d", "--restart=always", "--name", config["registry_name"], "--network", "kind", "-p", "127.0.0.1:" + str(config["registry_port"]) + ":5000", "-p", address + ":" + str(config["registry_port"]) + ":5000", "-v", config["registry_volume"] + ":/var/lib/registry", "registry:3")
else:
    info = json.loads(sp.check_output(["docker", "container", "inspect", config["registry_name"]]))[0]
    ports = info["HostConfig"]["PortBindings"].get("5000/tcp", [])
    if (not any(m.get("Name") == config["registry_volume"] and m["Destination"] == "/var/lib/registry" for m in info["Mounts"])
            or sorted((p["HostIp"], p["HostPort"]) for p in ports) != sorted((host, str(config["registry_port"])) for host in ("127.0.0.1", address))
            or "kind" not in info["NetworkSettings"]["Networks"]):
        raise RuntimeError("Existing registry container differs from the installation configuration")
    if not info["State"]["Running"]:
        run("docker", "start", config["registry_name"])
# Atelet's KIND overlay resolves this service when pulling sandbox runtime images.
run("kubectl", "apply", "-f", "-", input=json.dumps({"apiVersion": "v1", "kind": "List", "items": [
    {"apiVersion": "v1", "kind": "Service", "metadata": {"name": "kind-registry", "namespace": "ate-system"},
     "spec": {"ports": [{"name": "registry", "port": 5000, "targetPort": config["registry_port"]}]}},
    {"apiVersion": "discovery.k8s.io/v1", "kind": "EndpointSlice",
     "metadata": {"name": "kind-registry", "namespace": "ate-system", "labels": {"kubernetes.io/service-name": "kind-registry"}},
     "addressType": "IPv4", "ports": [{"name": "registry", "protocol": "TCP", "port": config["registry_port"]}],
     "endpoints": [{"addresses": [address], "conditions": {"ready": True}}]},
]}))
node = config["kind_node"]
run("docker", "exec", node, "mkdir", "-p", "/etc/containerd/certs.d/" + config["registry_address"])
run("docker", "exec", "-i", node, "sh", "-c", "cat > /etc/containerd/certs.d/" + config["registry_address"] + "/hosts.toml", input='[host."http://' + config["registry_name"] + ':5000"]\n')
print("Storage credentials and registry prepared.")

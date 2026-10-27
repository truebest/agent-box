"""Deploy the panel and digest-pinned agent templates after ate-system is ready."""
import base64
import ipaddress
import re
import hashlib
import json
import os
from pathlib import Path
import secrets
import runpy
import subprocess as sp
import urllib.request
from configuration import load, require_context, require_user

config = load()
require_context(config)
require_user(config)

root = Path(__file__).resolve().parents[1]
if sp.check_output(["kubectl", "-n", "pvm-agents", "get", "configmap", "worker-profiles", "--ignore-not-found", "-o", "name"]).strip():
    raise SystemExit("Worker profiles are installed. Use deploy/panel-image.py to update an installation with Worker profiles.")
ate = str(root / "vendor/substrate/bin/kubectl-ate")


def run(*args, **kw):
    return sp.run(args, check=True, text=True, **kw)


def deploy_worker_pool(manifest):
    remaining = []
    for document in manifest.split("---\n"):
        if "kind: WorkerPool\n" not in document:
            remaining.append(document)
            continue
        exists = sp.run(["kubectl", "-n", "pvm-agents", "get", "workerpool", "agents"], capture_output=True).returncode == 0
        if not exists:
            run("kubectl", "create", "-f", "-", input=document)
        # A separate field manager leaves autoscaled replicas under /scale ownership.
        configuration = re.sub(r"^  replicas: [0-9]+\n", "", document, flags=re.MULTILINE)
        run("kubectl", "apply", "--server-side", "--field-manager=pvm-worker-config", "-f", "-", input=configuration)
    return "---\n".join(remaining)


def digest(repository, tag):
    request = urllib.request.Request(f"{config['registry_url']}/v2/{repository}/manifests/{tag}", headers={"Accept": "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"})
    with urllib.request.urlopen(request) as response:
        return f"{config['registry_address']}/{repository}@{response.headers['Docker-Content-Digest']}"


def secret(name, values):
    manifest = {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": name, "namespace": "pvm-agents"},
                "data": {k: base64.b64encode(v).decode() for k, v in values.items()}}
    run("kubectl", "apply", "--server-side", "--field-manager=" + ("agent-box-host" if name == "chatgpt-auth" else "agent-box-install"), "-f", "-", input=json.dumps(manifest))


run("kubectl", "apply", "-f", "-", input=json.dumps({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "pvm-agents", "labels": {"ate.dev/api-access": "true"}}}))
pki = Path(config["home"]) / ".config/substrate-panel"
pki.mkdir(mode=0o700, parents=True, exist_ok=True)
pki.chmod(0o700)
os.umask(0o077)
if not (pki / "password").exists():
    (pki / "password").write_text(secrets.token_urlsafe(24) + "\n")
if not (pki / "ca.crt").exists():
    run("openssl", "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "3650", "-keyout", str(pki / "ca.key"), "-out", str(pki / "ca.crt"), "-subj", "/CN=" + config["hostname"] + " Agent Panel CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign", stderr=sp.DEVNULL)
if not (pki / "tls.crt").exists():
    run("openssl", "req", "-newkey", "rsa:3072", "-nodes", "-keyout", str(pki / "tls.key"), "-out", str(pki / "tls.csr"), "-subj", "/CN=" + config["panel_hostname"], stderr=sp.DEVNULL)
    try:
        ipaddress.ip_address(config["panel_hostname"])
        san_type = "IP"
    except ValueError:
        san_type = "DNS"
    (pki / "extensions").write_text("subjectAltName=" + san_type + ":" + config["panel_hostname"] + "\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n")
    run("openssl", "x509", "-req", "-in", str(pki / "tls.csr"), "-CA", str(pki / "ca.crt"), "-CAkey", str(pki / "ca.key"), "-CAcreateserial", "-out", str(pki / "tls.crt"), "-days", "365", "-extfile", str(pki / "extensions"), stderr=sp.DEVNULL)
try:
    ipaddress.ip_address(config["panel_hostname"])
    verify_name = "-checkip"
except ValueError:
    verify_name = "-checkhost"
run("openssl", "x509", "-in", str(pki / "tls.crt"), "-noout", verify_name, config["panel_hostname"], stdout=sp.DEVNULL)
run("openssl", "verify", "-CAfile", str(pki / "ca.crt"), str(pki / "tls.crt"), stdout=sp.DEVNULL)
if not (pki / "bridge-key").exists():
    (pki / "bridge-key").write_bytes(hashlib.sha256((pki / "password").read_bytes().strip()).digest())
secret("panel", {k: (pki / k).read_bytes() for k in ("password", "bridge-key", "tls.crt", "tls.key")})
source_auth = Path(config["home"]) / ".config/agent-sandbox/codex-auth.json"
if source_auth.exists():
    secret("chatgpt-auth", {"auth.json": source_auth.read_bytes()})
elif not sp.check_output(["kubectl", "-n", "pvm-agents", "get", "secret", "chatgpt-auth", "--ignore-not-found", "-o", "name"]).strip():
    secret("chatgpt-auth", {"auth.json": b"{}"})
release = json.loads((root / "images.json").read_text()) if (root / "images.json").exists() else {}
native = release.get("sandbox", {}).get("image") or digest("agents/native", "herdr-0.9.5")
images = release["agents"] if release.get("agents") else {kind: native for kind in ("codex", "pi")}
snapshot_location = release.get("snapshotStore", {}).get("location", "s3://ate-snapshots/agent-box/")
sandbox_resources = {"limits": [{"name": "cpu", "quantity": "2"}, {"name": "memory", "quantity": "2Gi"}]}
for kind, image in images.items():
    existing = sp.run([ate, "get", "actor-template", kind, "-a", "pvm-agents", "-o", "json"], capture_output=True, text=True)
    if existing.returncode == 0:
        current = json.loads(existing.stdout)
        if current["containers"][0]["image"] != image or current.get("resources") != sandbox_resources:
            raise RuntimeError(f"Template {kind} uses another runtime or resource profile. Validate a candidate and replace only unused templates; preserve templates referenced by existing sandboxes.")
worker = release.get("worker") or digest("substrate/ateom-gvisor", "v0.5.0")
panel = release.get("panel") or digest("panel", "herdr-0.9.5")
manifest = (root / "deploy/agents.yaml").read_text().replace("WORKER_IMAGE", worker).replace("PANEL_IMAGE", panel)
if release.get("console"):
    assert manifest.count("        image: " + panel + "\n") == 1, "Panel container changed; preserve Console explicitly"
    manifest = manifest.replace("        env: [{name: WORKER_MAX_REPLICAS, value: '8'}]\n", "        env: [{name: WORKER_MAX_REPLICAS, value: '8'}, {name: CONSOLE_ENABLED, value: 'true'}]\n")
manifest = manifest.replace("replicas: 3", "replicas: " + str(config["worker_replicas"]))
manifest = manifest.replace('requests: {cpu: "8", memory: 8Gi}', 'requests: {cpu: "' + str(config["worker_cpu"]) + '", memory: ' + config["worker_memory"] + '}')
manifest = manifest.replace('limits: {cpu: "8", memory: 8Gi}', 'limits: {cpu: "' + str(config["worker_cpu"]) + '", memory: ' + config["worker_memory"] + '}')
manifest = manifest.replace("storageClassName: agent-thin", "storageClassName: " + config["storage_class"])
manifest = manifest.replace("        env: [{name: WORKER_MAX_REPLICAS, value: '8'}]", "        env: [{name: WORKER_MAX_REPLICAS, value: '8'}, {name: CONSOLE_ENABLED, value: 'true'}]")
manifest = deploy_worker_pool(manifest)
run("kubectl", "apply", "-f", "-", input=manifest)
run("python3", str(root / "deploy/configure-egress.py"))
exists = sp.run([ate, "get", "atespace", "pvm-agents"], stdout=sp.DEVNULL, stderr=sp.DEVNULL).returncode == 0
if not exists:
    run(ate, "create", "atespace", "pvm-agents")
for kind, image in images.items():
    template = {"metadata": {"atespace": "pvm-agents", "name": kind},
                "workerSelector": {"matchLabels": {"workload": "pvm-agents"}},
                "containers": [{"name": "agent", "image": image, "securityContext": {"capabilities": {"add": ["CHOWN", "SETUID", "SETGID"]}}, "wakeupProbe": {"httpGet": {"path": "/readyz", "port": 80}, "timeoutSeconds": 30}, "volumeMounts": [{"name": "workspace", "mountPath": "/workspace"}]}],
                "volumes": [{"name": "workspace", "durableDir": {}}],
                "snapshotConfig": {"preferredFidelity": "SNAPSHOT_FIDELITY_MEMORY", "storageLocation": snapshot_location, "goldenSnapshotConfig": {"mode": "GOLDEN_SNAPSHOT_MODE_DISABLED"}},
                "sandboxConfig": {"sandboxClass": "gvisor", "configName": "gvisor-default"},
                "resources": sandbox_resources}
    if sp.run([ate, "get", "actor-template", kind, "-a", "pvm-agents"], stdout=sp.DEVNULL, stderr=sp.DEVNULL).returncode:
        run(ate, "create", "actor-template", "-f", "-", input=json.dumps(template))
sandbox = release.get("sandbox") or {"image": native, "template": "sandbox-v1-" + native.rsplit("sha256:", 1)[1][:12]}
installer = runpy.run_path(str(root / "deploy/panel-image.py"))
installer["ensure_sandbox_template"](sandbox["image"], sandbox["template"])
run("kubectl", "-n", "pvm-agents", "set", "env", "deployment/panel", "SANDBOX_TEMPLATE=" + sandbox["template"], "PANEL_ORIGIN=" + config["panel_origin"], "PANEL_HOST=" + config["hostname"])
release["sandbox"] = sandbox
release.setdefault("snapshotStore", {"location": snapshot_location})
release.update({"substrateCommit": "e8d40c33f96f4b7a4984bfea7334a36ab5b45b7b", "agents": images, "worker": worker, "panel": panel, "herdr": "0.9.5"})
(root / "images.json").write_text(json.dumps(release, indent=2) + "\n")
run("kubectl", "-n", "pvm-agents", "rollout", "status", "deployment/panel", "--timeout=180s")
print("Panel deployed. Password remains in ~/.config/substrate-panel/password; CA: ~/.config/substrate-panel/ca.crt")

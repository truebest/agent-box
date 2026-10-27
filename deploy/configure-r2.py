"""Connect the snapshot plugins to private R2 storage; run with no actors present."""
import base64
import datetime
import json
import os
from pathlib import Path
import re
import stat
import subprocess as sp
import urllib.parse
import urllib.request
import uuid
from configuration import load, require_context

root = Path(__file__).resolve().parents[1]
ate = str(root / "vendor/substrate/bin/kubectl-ate")


def run(*args, data=None):
    return sp.check_output(args, input=None if data is None else json.dumps(data).encode())


def settings(directory):
    config = json.loads((directory / "config.json").read_text())
    endpoint = urllib.parse.urlsplit(config["endpoint"])
    if (endpoint.scheme != "https" or endpoint.username or endpoint.password or endpoint.port
            or endpoint.path not in ("", "/") or endpoint.query or endpoint.fragment
            or not re.fullmatch(r"[a-f0-9]{32}\.r2\.cloudflarestorage\.com", endpoint.hostname or "")):
        raise ValueError("endpoint must be the HTTPS R2 S3 API origin, without a bucket path")
    if config["bucket"] != "agent-box-snapshots" or config["region"] != "auto":
        raise ValueError("Use bucket=agent-box-snapshots and region=auto")
    with os.fdopen(os.open(directory / "credentials.json", os.O_RDONLY | os.O_NOFOLLOW)) as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("credentials.json must be owned by the current user with mode 600")
        credentials = json.load(file)
    if set(credentials) != {"access_key_id", "secret_access_key"} or any(
            not isinstance(v, str) or not v.strip() or v != v.strip() for v in credentials.values()):
        raise ValueError("Fill access_key_id and secret_access_key in credentials.json")
    config["endpoint"] = config["endpoint"].rstrip("/")
    return config, credentials


def storage_env(config):
    return [{"name": k, "value": v} for k, v in {
        "ATE_STORAGE_BACKEND": "s3", "ATE_SNAPSHOT_ARCHIVE": "tar.zst",
        "AWS_REGION": config["region"], "AWS_ENDPOINT_URL": config["endpoint"],
        "AWS_S3_USE_PATH_STYLE": "true", "AWS_REQUEST_CHECKSUM_CALCULATION": "when_required",
        "AWS_RESPONSE_CHECKSUM_VALIDATION": "when_required",
    }.items()] + [{"name": name, "valueFrom": {"secretKeyRef": {"name": "substrate-r2", "key": key}}}
                 for name, key in (("AWS_ACCESS_KEY_ID", "access-key"), ("AWS_SECRET_ACCESS_KEY", "secret-key"))]


def smoke_test(config):
    name = "r2-check-" + uuid.uuid4().hex[:10]
    key = "agent-box-host/connectivity/" + uuid.uuid4().hex
    original = json.loads(run("kubectl", "-n", "ate-system", "get", "job", "rustfs-bucket-init", "-o", "json"))
    image = original["spec"]["template"]["spec"]["containers"][0]["image"]
    command = f'''set -eu
export AWS_PAGER=""
printf r2-snapshot-check > /tmp/source
trap 'aws s3api delete-object --bucket agent-box-snapshots --key {key} >/dev/null' EXIT
aws s3api put-object --bucket agent-box-snapshots --key {key} --body /tmp/source >/dev/null
aws s3api get-object --bucket agent-box-snapshots --key {key} /tmp/restored >/dev/null
cmp /tmp/source /tmp/restored
aws s3api list-objects-v2 --bucket agent-box-snapshots --prefix {key} >/dev/null
'''
    job = {"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": name, "namespace": "ate-system"},
           "spec": {"backoffLimit": 0, "activeDeadlineSeconds": 120, "ttlSecondsAfterFinished": 600,
                    "template": {"spec": {"restartPolicy": "Never", "automountServiceAccountToken": False,
                                          "containers": [{"name": "check", "image": image, "env": storage_env(config),
                                                          "command": ["/bin/sh", "-ec", command]}]}}}}
    try:
        run("kubectl", "create", "-f", "-", data=job)
        run("kubectl", "-n", "ate-system", "wait", "--for=condition=complete", "job/" + name, "--timeout=135s")
    finally:
        run("kubectl", "-n", "ate-system", "delete", "job", name, "--ignore-not-found")


def digest(component):
    installation = load()
    request = urllib.request.Request(f"{installation['registry_url']}/v2/substrate/{component}/manifests/r2-archive-v1",
                                     headers={"Accept": "application/vnd.oci.image.index.v1+json"})
    with urllib.request.urlopen(request) as response:
        return f"{installation['registry_address']}/substrate/{component}@{response.headers['Docker-Content-Digest']}"


def template(name):
    value = json.loads(run(ate, "get", "actor-template", name, "-a", "pvm-agents", "-o", "json"))
    value["metadata"] = {"atespace": "pvm-agents", "name": name}
    value.pop("status", None)
    return value


def storage_templates(images):
    names = {"pi", "codex"}
    if images.get("sandbox"):
        names.add(images["sandbox"]["template"])
    return {name: template(name) for name in sorted(names)}


def forward(action):
    run("docker", "run", "--rm", "--privileged", "--pid=host", "-v", "/:/host", "python:3.12",
        "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "systemctl", action, "substrate-panel.service")


def require_empty():
    if json.loads(run(ate, "get", "actors", "-A", "-o", "json")).get("actors"):
        raise RuntimeError("Actors still exist; storage switch refused to preserve their snapshots")


def patch_workload(kind, name, pod):
    run("kubectl", "-n", "ate-system", "patch", kind, name, "--type=merge", "-p",
        json.dumps({"spec": {"template": pod}}))
    run("kubectl", "-n", "ate-system", "rollout", "status", kind + "/" + name, "--timeout=180s")


def main():
    require_context(load())
    if run("kubectl", "-n", "pvm-agents", "get", "configmap", "worker-profiles", "--ignore-not-found", "-o", "name").strip():
        raise RuntimeError("Configure snapshot storage before bootstrapping Worker profiles")
    os.umask(0o077)
    config, credentials = settings(Path.home() / ".config/substrate-r2")
    pins = {name: digest(name) for name in ("atelet", "objectstore-plugin")}
    require_empty()
    secret = {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "substrate-r2", "namespace": "ate-system"},
              "data": {k: base64.b64encode(credentials[v].encode()).decode()
                       for k, v in (("access-key", "access_key_id"), ("secret-key", "secret_access_key"))}}
    run("kubectl", "apply", "-f", "-", data=secret)
    smoke_test(config)
    images = json.loads((root / "images.json").read_text())
    old_templates = storage_templates(images)
    old_workloads = {(kind, name): json.loads(run("kubectl", "-n", "ate-system", "get", kind, name, "-o", "json"))["spec"]["template"]
                     for kind, name in (("daemonset", "atelet"), ("deployment", "ate-api-server"))}
    backup = root / "archives" / ("before-r2-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    backup.mkdir(parents=True, mode=0o700)
    (backup / "templates.json").write_text(json.dumps(old_templates, indent=2) + "\n")
    for (_, name), pod in old_workloads.items():
        (backup / (name + ".json")).write_text(json.dumps(pod, indent=2) + "\n")
    (backup / "images.json").write_text(json.dumps(images, indent=2) + "\n")
    changed = []
    forward("stop")
    try:
        require_empty()
        for (kind, name), pod in old_workloads.items():
            new = json.loads(json.dumps(pod))
            plugin = next(c for c in new["spec"]["initContainers"] if c["name"] == "objectstore-plugin")
            plugin["image"] = pins["objectstore-plugin"]
            replacement = storage_env(config)
            names = {v["name"] for v in replacement}
            plugin["env"] = [v for v in plugin.get("env", []) if v["name"] not in names] + replacement
            if name == "atelet":
                atelet = next(c for c in new["spec"]["containers"] if c["name"] == "atelet")
                atelet["image"] = pins["atelet"]
                atelet["env"] = [v for v in atelet.get("env", []) if v["name"] != "ATE_SNAPSHOT_ARCHIVE"] + [{"name": "ATE_SNAPSHOT_ARCHIVE", "value": "tar.zst"}]
            changed.append((kind, name))
            patch_workload(kind, name, new)
        for kind, old in old_templates.items():
            run(ate, "delete", "actor-template", kind, "-a", "pvm-agents")
            new = json.loads(json.dumps(old))
            new["snapshotConfig"]["storageLocation"] = "s3://agent-box-snapshots/agent-box-host/"
            run(ate, "create", "actor-template", "-f", "-", data=new)
        images["snapshotStore"] = {**config, **pins, "location": "s3://agent-box-snapshots/agent-box-host/", "format": "tar.zst"}
        (root / "images.json").write_text(json.dumps(images, indent=2) + "\n")
    except Exception:
        for kind, name in reversed(changed):
            patch_workload(kind, name, old_workloads[(kind, name)])
        for kind, old in old_templates.items():
            sp.run([ate, "delete", "actor-template", kind, "-a", "pvm-agents"], check=False, stdout=sp.DEVNULL)
            run(ate, "create", "actor-template", "-f", "-", data=old)
        raise
    finally:
        forward("start")
    report = {"config": config, "images": pins, "rollback": str(backup), "s3_round_trip": True}
    (backup / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print("R2 connected; rollback configuration:", backup, flush=True)


if __name__ == "__main__":
    main()

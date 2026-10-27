"""Bootstrap immutable Worker profiles and migrate an inventoried legacy pool."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from agent import Client

ATE = str(ROOT / "vendor/substrate/bin/kubectl-ate")
SPACE = "pvm-agents"


def kubectl(*args, body=None):
    return subprocess.check_output(["kubectl", *args], input=None if body is None else json.dumps(body).encode())


def actors():
    return json.loads(subprocess.check_output([ATE, "get", "actors", "-a", SPACE, "-o", "json"])).get("actors", [])


def templates():
    return json.loads(subprocess.check_output([ATE, "get", "actor-template", "-a", SPACE, "-o", "json"])).get("actorTemplates", [])


def identity(values):
    return sorted((item["metadata"]["name"], item["metadata"]["uid"]) for item in values)


def compatible(template):
    limits = {item["name"]: item["quantity"] for item in template.get("resources", {}).get("limits", [])}
    return (limits.get("cpu") in ("2", "2000m") and limits.get("memory") in ("2Gi", "2048Mi")
            and template.get("sandboxConfig", {}).get("sandboxClass") == "gvisor"
            and template.get("snapshotConfig", {}).get("preferredFidelity") == "SNAPSHOT_FIDELITY_MEMORY"
            and template.get("workerSelector") == {"matchLabels": {"workload": SPACE}})


def catalog(base, old_templates, node, worker_image, candidate_id=None):
    if not re.fullmatch(r"localhost:5001/substrate/ateom-gvisor@sha256:[0-9a-f]{64}", worker_image):
        raise ValueError("A verified Worker digest is required")
    if not compatible(base):
        raise ValueError("Base template is not compatible with Standard v1")
    candidate = candidate_id is not None
    profile_id = candidate_id or "standard"
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,36}[a-z0-9]", profile_id):
        raise ValueError("Invalid candidate profile identity")
    name = "profile-" + profile_id + "-v1"
    template = copy.deepcopy(base)
    template["metadata"] = {"atespace": SPACE, "name": name}
    template.pop("status", None)
    template["workerSelector"] = {"matchLabels": {"agent-box/managed": "true", "agent-box/profile": profile_id, "agent-box/revision": "1"}}
    bindings = {name: {"profile_id": profile_id, "revision": 1}}
    if not candidate:
        for old in old_templates:
            if compatible(old):
                bindings[old["metadata"]["name"]] = {"profile_id": profile_id, "revision": 1}
    revision = {"revision": 1, "cpu_milli": 8000, "memory_mib": 8256, "slots": 4, "reserved_memory_mib": 64, "reserved_cpu_milli": 0,
                "template": name, "template_spec": template, "worker_image": worker_image,
                "sandbox_config": base["sandboxConfig"]["configName"], "legacy": not candidate}
    return {"mode": "active" if candidate else "quiescing", "default_id": profile_id,
            "node": node, "worker_image": worker_image, "base_template": base,
            "bindings": bindings, "instances": [], "profiles": [{"id": profile_id, "name": "Standard",
                "version": 1, "min_workers": 0, "max_workers": 8, "enabled": True, "revisions": [revision]}]}


def backup(directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    for filename, value in (("actors.json", actors()), ("templates.json", templates())):
        (directory / filename).write_text(json.dumps(value, indent=2) + "\n")
    for resource in ("workerpools", "deployments", "configmaps"):
        (directory / (resource + ".json")).write_bytes(kubectl("-n", SPACE, "get", resource, "-o", "json"))
    (directory / "controller.json").write_bytes(kubectl("-n", "ate-system", "get", "deployment", "ate-controller", "-o", "json"))
    (directory / "images.json").write_bytes((ROOT / "images.json").read_bytes())


def bootstrap(args):
    current = kubectl("-n", SPACE, "get", "configmap", args.catalog, "--ignore-not-found", "-o", "json")
    if current.strip():
        raise RuntimeError("Catalog already exists; immutable versions must not be replaced")
    old = templates()
    base = next(item for item in old if item["metadata"]["name"] == args.template)
    if args.candidate and args.catalog == "worker-profiles":
        raise ValueError("Candidate verification requires a separate catalog")
    value = catalog(base, old, args.node, args.worker_image, args.catalog if args.candidate else None)
    if not args.candidate:
        for actor in actors():
            if actor["actorTemplate"]["name"] not in value["bindings"]:
                raise RuntimeError("Inventory contains an incompatible sandbox template")
    kubectl("create", "-f", "-", body={"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": args.catalog, "namespace": SPACE}, "data": {"catalog.json": json.dumps(value)}})


def stage_candidate(deployment, runtime=None):
    name = deployment["metadata"]["name"]
    if not name.endswith("-candidate"):
        raise ValueError("An isolated candidate Deployment is required")
    raw = kubectl("-n", SPACE, "get", "configmap", "worker-profiles", "--ignore-not-found", "-o", "json")
    if not raw.strip():
        return False
    production = json.loads(json.loads(raw)["data"]["catalog.json"])
    base = copy.deepcopy(production["base_template"])
    if runtime is not None:
        base["containers"][0]["image"] = runtime
    value = catalog(base, [], production["node"], production["worker_image"], name)
    catalog_name = "worker-profiles-" + name
    current = kubectl("-n", SPACE, "get", "configmap", catalog_name, "--ignore-not-found", "-o", "json")
    if current.strip():
        existing = json.loads(json.loads(current)["data"]["catalog.json"])
        if any(existing.get(key) != value[key] for key in ("node", "worker_image", "base_template")):
            raise RuntimeError("Candidate catalog differs; clean up its test sandboxes, pools and catalog before staging new images")
    else:
        kubectl("create", "-f", "-", body={"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": catalog_name, "namespace": SPACE}, "data": {"catalog.json": json.dumps(value)}})
    container = deployment["spec"]["template"]["spec"]["containers"][0]
    changed = {"WORKER_PROFILES": "true", "WORKER_CATALOG": catalog_name, "WORKER_MAX_REPLICAS": "0"}
    container["env"] = [item for item in container.get("env", []) if item["name"] not in (*changed, "POD_NAME", "POD_UID")]
    container["env"] += [{"name": key, "value": value} for key, value in changed.items()]
    container["env"] += [{"name": "POD_NAME", "valueFrom": {"fieldRef": {"fieldPath": "metadata.name"}}},
                         {"name": "POD_UID", "valueFrom": {"fieldRef": {"fieldPath": "metadata.uid"}}}]
    return True


def cutover(args):
    spec = importlib.util.spec_from_file_location("lifecycle", ROOT / "deploy/host-lifecycle.py")
    lifecycle = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lifecycle)
    pki = Path.home() / ".config/substrate-panel"
    client = Client(args.url, pki / "ca.crt", pki / "password")
    mode = client.request("GET", "/api/worker-management")
    client.request("PUT", "/api/worker-management", {"mode": "quiescing", "version": mode["version"]})
    expected = json.loads((args.backup / "actors.json").read_text())
    before = actors()
    if identity(before) != identity(expected):
        raise RuntimeError("Sandbox UIDs differ from the saved inventory; remain quiescing")
    running = [actor for actor in before if actor["status"]["state"] == "ACTOR_STATE_RUNNING"]
    running_file = args.backup / "running-before.json"
    if not running_file.exists():
        temporary = args.backup / "running-before.json.tmp"
        temporary.write_text(json.dumps(identity(running)))
        os.replace(temporary, running_file)
    original_running = json.loads(running_file.read_text())
    if not set(map(tuple, original_running)).issubset(set(identity(expected))):
        raise RuntimeError("Saved running inventory differs from the checkpoint")
    location = json.loads((ROOT / "images.json").read_text())["snapshotStore"]["location"]
    for actor in running:
        lifecycle.suspend(actor, client.request, location)
    after = actors()
    if identity(after) != identity(expected) or any(lifecycle.saved(actor, location) is None for actor in after):
        raise RuntimeError("Inventory or MEMORY snapshot verification failed; remain quiescing")
    pools = json.loads((args.backup / "workerpools.json").read_text())["items"]
    legacy = next(pool for pool in pools if pool["metadata"]["name"] == "agents")
    mode = client.request("GET", "/api/worker-management")
    client.request("PUT", "/api/worker-management", {"mode": "quiescing", "version": mode["version"], "legacy_pool_uid": legacy["metadata"]["uid"]})
    deadline = time.monotonic() + 300
    while kubectl("-n", SPACE, "get", "workerpool", "agents", "--ignore-not-found", "-o", "name").strip():
        if time.monotonic() > deadline:
            raise RuntimeError("Legacy pool deletion did not finish; remain quiescing")
        time.sleep(2)
    mode = client.request("GET", "/api/worker-management")
    client.request("PUT", "/api/worker-management", {"mode": "active", "version": mode["version"]})
    for name, uid in original_running:
        restored = client.request("POST", "/api/agents/" + quote(name, safe="") + "/resume?uid=" + quote(uid, safe=""))
        if restored["metadata"]["uid"] != uid:
            raise RuntimeError("Restored sandbox UID differs")
    final = actors()
    if identity(final) != identity(expected):
        raise RuntimeError("Final inventory changed")
    (args.backup / "actors-after.json").write_text(json.dumps(final, indent=2) + "\n")
    print("Migration verified:", len(final), "sandboxes retained;", len(original_running), "previously running sandboxes resumed")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    save = commands.add_parser("backup")
    save.add_argument("directory", type=Path)
    init = commands.add_parser("bootstrap")
    init.add_argument("--catalog", default="worker-profiles")
    init.add_argument("--candidate", action="store_true")
    init.add_argument("--template", required=True)
    init.add_argument("--node", required=True)
    init.add_argument("--worker-image", required=True)
    migrate = commands.add_parser("cutover")
    migrate.add_argument("--backup", type=Path, required=True)
    migrate.add_argument("--url", default="https://192.0.2.10:8443")
    args = parser.parse_args()
    if args.action == "backup":
        backup(args.directory)
    elif args.action == "bootstrap":
        bootstrap(args)
    else:
        cutover(args)


if __name__ == "__main__":
    main()

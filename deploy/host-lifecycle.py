"""Save the pool before Docker stops; publish the panel only after a safe boot."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import quote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from agent import Client
sys.path.insert(0, str(ROOT / "deploy"))
from configuration import load

PRIVATE_PORT = 19443


class RecoveryRequired(RuntimeError):
    pass


def request(method, path, body=None, *, port=PRIVATE_PORT, identity=None):
    url = load()["panel_origin"]
    pki = Path.home() / ".config/substrate-panel"
    if identity == "devin-pilot":
        pki = Path.home() / ".config/devin-agent-box-pilot"
        url = "https://panel-devin-pilot.pvm-agents.svc:8443"
    elif identity is not None:
        raise RecoveryRequired("Unknown lifecycle panel identity")
    client = Client(url, pki / "ca.crt", pki / "password")
    host = urlsplit(url).hostname
    command = ["curl", "--disable", "--silent", "--show-error", "--fail-with-body",
               "--noproxy", "*", "--proto", "=https", "--max-time", "360",
               "--cacert", str(pki / "ca.crt"), "--connect-to",
               f"{host}:{urlsplit(url).port or 443}:127.0.0.1:{port}",
               "--config", "-", "--request", method, url + path]
    if method in ("POST", "PUT"):
        command += ["--header", "Content-Type: application/json", "--data", json.dumps(body or {})]
    config = "header = " + json.dumps("Authorization: " + client.authorization) + "\n"
    result = subprocess.run(command, input=config, text=True, capture_output=True, timeout=370)
    if result.returncode:
        raise RuntimeError(f"Panel {method} {path} failed (curl {result.returncode}); inspect panel logs")
    return json.loads(result.stdout)


def saved(actor, location):
    metadata, state = actor["metadata"], actor["status"]
    if state["state"] == "ACTOR_STATE_CRASHED":
        raise RecoveryRequired(f"{metadata['name']} is Crashed; preserve local data before explicit recovery")
    if state["state"] != "ACTOR_STATE_SUSPENDED":
        return None
    if state.get("workerAssignment"):
        raise RecoveryRequired(f"{metadata['name']} still has a Worker assignment")
    snapshots = state.get("snapshots", [])
    if not snapshots and not state.get("lastAssignedGeneration", 0):
        return {"name": metadata["name"], "uid": metadata["uid"], "snapshot": None}
    snapshot = max(snapshots, key=lambda item: item.get("generation", 0)) if snapshots else {}
    durable = snapshot.get("durableSnapshot", {})
    if (snapshot.get("fidelity") != "SNAPSHOT_FIDELITY_MEMORY" or
            durable.get("status") != "SNAPSHOT_STORAGE_STATUS_COMPLETED" or
            not durable.get("object", {}).get("snapshotUri", "").startswith(location) or
            any(item.get("durableSnapshot", {}).get("status") == "SNAPSHOT_STORAGE_STATUS_PENDING" for item in snapshots)):
        raise RecoveryRequired(f"{metadata['name']} has no completed MEMORY snapshot in the configured store")
    return {"name": metadata["name"], "uid": metadata["uid"], "snapshot": snapshot["uuid"]}


def suspend(actor, api, location):
    path = "/api/agents/" + quote(actor["metadata"]["name"], safe="") + "/suspend"
    result = api("POST", path)
    if result["metadata"]["uid"] != actor["metadata"]["uid"]:
        raise RecoveryRequired("Sandbox identity changed during shutdown")
    record = saved(result, location)
    old = {item["uuid"] for item in actor["status"].get("snapshots", [])
           if item.get("durableSnapshot", {}).get("status") == "SNAPSHOT_STORAGE_STATUS_COMPLETED"}
    if record is None or not record["snapshot"] or record["snapshot"] in old:
        raise RecoveryRequired(f"{actor['metadata']['name']} did not finish a fresh MEMORY snapshot")
    print("Saved", json.dumps(record), flush=True)


def drain_once(api, location):
    actors = api("GET", "/api/agents").get("actors", [])
    running = [actor for actor in actors if actor["status"]["state"] in ("ACTOR_STATE_RUNNING", "ACTOR_STATE_SUSPENDING")]
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(suspend, actor, api, location) for actor in running]
        for future in futures:
            future.result()
    records = [saved(actor, location) for actor in api("GET", "/api/agents").get("actors", [])]
    return sorted(records, key=lambda item: item["uid"]) if all(record is not None for record in records) else None


@contextmanager
def forward_panel(target="svc/panel", port=PRIVATE_PORT):
    process = subprocess.Popen(["kubectl", "--context", load()["kube_context"], "-n", "pvm-agents", "port-forward", "--address=127.0.0.1",
                                target, f"{port}:8443"],
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        yield process
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def management_mode(mode):
    catalog = subprocess.check_output(["kubectl", "--context", load()["kube_context"], "-n", "pvm-agents", "get", "configmap", "worker-profiles", "--ignore-not-found", "-o", "name"])
    if not catalog.strip():
        return
    current = request("GET", "/api/worker-management")
    if current["mode"] != mode:
        request("PUT", "/api/worker-management", {"mode": mode, "version": current["version"]})
    if mode == "quiescing":
        quiesce_candidates()
    elif mode == "active":
        candidate_management("active", persistent_only=True)


def quiesce_candidates():
    candidate_management("quiescing")


def candidate_management(mode, persistent_only=False):
    command = ["kubectl", "--context", load()["kube_context"], "-n", "pvm-agents"]
    catalogs = json.loads(subprocess.check_output(command + ["get", "configmaps", "-l", "agent-box/worker-catalog=true", "-o", "json"]))
    for cm in catalogs["items"]:
        if cm["metadata"]["name"] == "worker-profiles":
            continue
        annotations = cm["metadata"].get("annotations", {})
        if persistent_only and annotations.get("agent-box/persistent") != "true":
            continue
        identity = annotations.get("agent-box/lifecycle-identity")
        if identity not in (None, "devin-pilot"):
            raise RecoveryRequired("Unknown candidate lifecycle identity")
        options = {"port": PRIVATE_PORT + 1}
        if identity is not None:
            options["identity"] = identity
        catalog = json.loads(cm["data"]["catalog.json"])
        owner = catalog.get("owner_pod")
        pod = subprocess.check_output(command + ["get", "pod", owner, "--ignore-not-found", "-o", "json"]) if owner else b""
        pod = json.loads(pod) if pod.strip() else {}
        if (pod.get("metadata", {}).get("uid") != catalog.get("owner_uid") or
                pod.get("status", {}).get("phase") in ("Succeeded", "Failed") or not owner):
            catalog["mode"] = mode
            cm["data"]["catalog.json"] = json.dumps(catalog)
            subprocess.run(command + ["replace", "-f", "-"], input=json.dumps(cm).encode(), check=True)
            continue
        # The API barrier also waits for an admitted Resume or router handshake.
        with forward_panel("pod/" + owner, PRIVATE_PORT + 1) as forward:
            deadline = time.monotonic() + 30
            while True:
                try:
                    current = request("GET", "/api/worker-management", **options)
                    break
                except RuntimeError:
                    if forward.poll() is not None or time.monotonic() >= deadline:
                        raise
                    time.sleep(0.2)
            request("PUT", "/api/worker-management", {"mode": mode, "version": current["version"]}, **options)


def refresh_worker_pods():
    pools = json.loads(subprocess.check_output(["kubectl", "--context", load()["kube_context"], "-n", "pvm-agents", "get", "workerpools", "-o", "json"]))
    for pool in pools["items"]:
        if pool["metadata"].get("deletionTimestamp") or not pool["spec"]["replicas"]:
            continue
        if pool["metadata"]["name"] != "agents" and pool["metadata"].get("labels", {}).get("agent-box/managed") != "true":
            continue
        deployment = "deployment/" + pool["metadata"]["name"]
        subprocess.run(["kubectl", "--context", load()["kube_context"], "-n", "pvm-agents", "rollout", "restart", deployment], check=True)
        subprocess.run(["kubectl", "--context", load()["kube_context"], "-n", "pvm-agents", "rollout", "status", deployment, "--timeout=300s"], check=True)


def main(mode):
    previous = None
    while True:
        try:
            location = json.loads((ROOT / "images.json").read_text())["snapshotStore"]["location"]
            if not location.startswith("s3://") or not location.endswith("/"):
                raise ValueError("Invalid snapshot store location")
            with forward_panel() as forward:
                while forward.poll() is None:
                    try:
                        management_mode("quiescing")
                        records = drain_once(request, location)
                        if records is not None and records == previous:
                            if mode == "boot":
                                # Substrate v0.5.0 retains old Pod IPs when the Pod UID survives a reboot.
                                refresh_worker_pods()
                                management_mode("active")
                            os.sync()
                            print(mode, "complete:", json.dumps(records), flush=True)
                            return
                        previous = records
                    except Exception as error:
                        previous = None
                        if mode == "boot" and isinstance(error, RecoveryRequired):
                            raise
                        print("Waiting for saved sandboxes:", type(error).__name__, str(error), flush=True)
                    time.sleep(2)
        except Exception as error:
            if mode == "boot" and isinstance(error, RecoveryRequired):
                raise
            print("Waiting for panel:", type(error).__name__, str(error), flush=True)
        time.sleep(5)


if __name__ == "__main__":
    if sys.argv[1:] not in (["boot"], ["stop"]):
        raise SystemExit("Usage: host-lifecycle.py boot|stop")
    main(sys.argv[1])

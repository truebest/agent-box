"""Restart backing services, exercise an object-store outage, and refresh OAuth."""
from pathlib import Path
import hashlib
import json
import subprocess as sp
import sys
import time
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent import Client

root = Path(__file__).resolve().parents[1]
if json.loads((root / "images.json").read_text()).get("snapshotStore", {}).get("bucket") == "agent-box-snapshots":
    raise SystemExit("This legacy outage test requires RustFS snapshots. Use tests/r2.py for the current R2 deployment.")
pki = Path.home() / ".config/substrate-panel"
client = Client("https://192.0.2.10:8443", str(pki / "ca.crt"), str(pki / "password"))
path = "/api/agents/verify-pi"


def kubectl(*args):
    sp.run(["kubectl", "-n", "ate-system", *args], check=True)


report = {}
for resource in ("statefulset/postgres", "deployment/rustfs"):
    kubectl("rollout", "restart", resource)
    kubectl("rollout", "status", resource, "--timeout=120s")
    client.request("GET", path)
    report[resource] = "recovered"
    print("PASS", resource, "restart with persistent data", flush=True)

try:
    client.request("GET", "/api/agents/verify-storage")
except urllib.error.HTTPError as error:
    if error.code != 404:
        raise
    client.request("POST", "/api/agents", {"name": "verify-storage", "kind": "pi"})
client.request("POST", "/api/agents/verify-storage/exec", {"argv": ["python3", "-c", "from pathlib import Path;Path('/workspace/recovery-baseline.txt').write_text('saved before outage')"], "cwd": "/workspace"})
client.request("POST", "/api/agents/verify-storage/suspend")
client.request("POST", "/api/agents/verify-storage/resume")
kubectl("scale", "deployment/rustfs", "--replicas=0")
kubectl("wait", "--for=delete", "pod", "-l", "app=rustfs", "--timeout=60s")
try:
    try:
        result = client.request("POST", "/api/agents/verify-storage/suspend")
        assert not any(s.get("durableSnapshot", {}).get("status") == "SNAPSHOT_STORAGE_STATUS_COMPLETED"
                       for s in result["status"].get("snapshots", [])), "Unavailable storage reported a completed external snapshot"
        report["storage_outage"] = "incomplete snapshot reported"
    except urllib.error.HTTPError as error:
        report["storage_outage"] = {"http_status": error.code}
        assert error.code >= 400
finally:
    kubectl("scale", "deployment/rustfs", "--replicas=1")
    kubectl("rollout", "status", "deployment/rustfs", "--timeout=120s")
print("PASS object-store outage surfaced without claiming durable completion", flush=True)
state = client.request("GET", "/api/agents/verify-storage")
if state["status"]["state"] == "ACTOR_STATE_CRASHED":
    client.request("POST", "/api/agents/verify-storage/revert")
result = client.request("POST", "/api/agents/verify-storage/exec", {"argv": ["cat", "/workspace/recovery-baseline.txt"], "cwd": "/workspace"})
assert result["exit_code"] == 0 and result["output"] == "saved before outage"
client.request("POST", "/api/agents/verify-storage/suspend")
client.request("DELETE", "/api/agents/verify-storage")

sp.run(["bash", str(root / "deploy/refresh-auth.sh"), "--force"], check=True)
auth = json.loads((Path.home() / ".config/agent-sandbox/codex-auth.json").read_text())
expected = hashlib.sha256(auth["tokens"]["access_token"].encode()).hexdigest()
del auth
# Secret volume projection is eventually consistent. Resume injects its current view.
for _ in range(90):
    client.request("POST", path + "/resume")
    result = client.request("POST", path + "/exec", {"argv": ["python3", "-c", "import json,hashlib;from pathlib import Path; a=json.loads((Path.home()/'.codex/auth.json').read_text()); print(hashlib.sha256(a['tokens']['access_token'].encode()).hexdigest()); print(not a['tokens']['refresh_token'])"], "cwd": "/workspace"})
    if result["output"].splitlines() == [expected, "True"]:
        break
    time.sleep(2)
else:
    raise AssertionError("Updated OAuth did not reach the actor")
report["oauth"] = "central refresh succeeded; new access token delivered; refresh token withheld"
(root / "evidence/recovery.json").write_text(json.dumps(report, indent=2) + "\n")
print("PASS central OAuth rotation and fresh delivery; actor has no refresh token", flush=True)

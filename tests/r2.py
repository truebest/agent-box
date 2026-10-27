"""Prove compressed R2 MEMORY snapshots restore both runners on another worker."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shlex
import subprocess as sp
import sys
import time
import urllib.parse
import uuid

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
from agent import Client

spec = importlib.util.spec_from_file_location("r2", root / "deploy/configure-r2.py")
r2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r2)
config = json.loads((root / "images.json").read_text())["snapshotStore"]
pki = Path.home() / ".config/substrate-panel"
client = Client(os.environ.get("AGENT_URL", "https://192.0.2.10:8443"), pki / "ca.crt", pki / "password")
report = {}
actors = {}


def execute(name, argv):
    result = client.request("POST", "/api/agents/" + name + "/exec", {"argv": argv})
    assert result["exit_code"] == 0, result["output"]
    return result["output"].strip()


def wait_file(name, file, expected):
    deadline = time.monotonic() + 180
    code = f"from pathlib import Path;p=Path({file!r});print(p.read_text() if p.exists() else 'pending')"
    while execute(name, ["python3", "-c", code]) != expected:
        assert time.monotonic() < deadline, f"Timed out waiting for {file}"
        time.sleep(1)


def s3(command):
    original = json.loads(sp.check_output(["kubectl", "-n", "ate-system", "get", "job", "rustfs-bucket-init", "-o", "json"]))
    image = original["spec"]["template"]["spec"]["containers"][0]["image"]
    name = "r2-proof-" + uuid.uuid4().hex[:10]
    job = {"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": name, "namespace": "ate-system"},
           "spec": {"backoffLimit": 0, "activeDeadlineSeconds": 120, "ttlSecondsAfterFinished": 600,
                    "template": {"spec": {"restartPolicy": "Never", "automountServiceAccountToken": False,
                                          "containers": [{"name": "check", "image": image, "env": r2.storage_env(config),
                                                          "command": ["/bin/sh", "-ec", command]}]}}}}
    try:
        sp.run(["kubectl", "create", "-f", "-"], input=json.dumps(job).encode(), check=True, stdout=sp.DEVNULL)
        sp.run(["kubectl", "-n", "ate-system", "wait", "--for=condition=complete", "job/" + name, "--timeout=135s"], check=True, stdout=sp.DEVNULL)
        return sp.check_output(["kubectl", "-n", "ate-system", "logs", "job/" + name], text=True).strip()
    finally:
        sp.run(["kubectl", "-n", "ate-system", "delete", "job", name, "--ignore-not-found"], check=True, stdout=sp.DEVNULL)


for kind in ("pi", "codex"):
    name = "verify-r2-" + kind
    actor = client.request("POST", "/api/agents", {"name": name, "kind": kind})
    actors[kind] = {"name": name, "uid": actor["metadata"]["uid"]}
    (root / "evidence/r2-targets.json").write_text(json.dumps(list(actors.values()), indent=2) + "\n")
    target_file = root / "evidence/cleanup-targets.json"
    targets = json.loads(target_file.read_text()) if target_file.exists() else []
    target_file.write_text(json.dumps([*targets, actors[kind]], indent=2) + "\n")
    word = "marigold-" + secrets.token_hex(5)
    client.request("POST", "/api/agents/" + name + "/prompt", {"prompt": f"Remember this codeword for our conversation: {word}. Use bash to write it without a newline into /workspace/before.txt. Reply ready."})
    wait_file(name, "/workspace/before.txt", word)
    deadline = time.monotonic() + 60
    while True:
        state = client.request("GET", "/api/agents/" + name + "/session")
        if state["runner"].get("agent_session") and state["runner"]["agent_status"] in ("idle", "done"):
            break
        assert time.monotonic() < deadline
        time.sleep(1)
    conversation = state["runner"]["agent_session"]
    tab = json.loads(execute(name, ["herdr", "tab", "create", "--label", "r2-memory", "--cwd", "/workspace"]))
    pane = tab["result"]["root_pane"]["pane_id"]
    program = '''from http.server import BaseHTTPRequestHandler,HTTPServer
import secrets
value=secrets.token_hex(32)
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(value.encode())
 def log_message(self,*args): pass
HTTPServer(('127.0.0.1',8082),H).serve_forever()
'''
    execute(name, ["herdr", "pane", "run", pane, "python3 -c " + shlex.quote(program)])
    probe = ["python3", "-c", "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8082').read().decode())"]
    memory = execute(name, probe)
    client.request("POST", "/api/agents/" + name + "/prompt", {"prompt": "Use bash to run python3 -c 'import pathlib,time;pathlib.Path(\"/workspace/started\").write_text(\"started\");time.sleep(75);pathlib.Path(\"/workspace/continued\").write_text(\"continued\")'. Afterward reply done."})
    wait_file(name, "/workspace/started", "started")
    actor = client.request("GET", "/api/agents/" + name)
    worker = actor["status"]["workerAssignment"]["workerPod"]
    before = time.monotonic()
    stopped = client.request("POST", "/api/agents/" + name + "/suspend")
    snapshots = stopped["status"]["snapshots"]
    assert len(snapshots) == 1
    snapshot = snapshots[0]
    assert snapshot["fidelity"] == "SNAPSHOT_FIDELITY_MEMORY"
    assert snapshot["durableSnapshot"]["status"] == "SNAPSHOT_STORAGE_STATUS_COMPLETED"
    uri = snapshot["durableSnapshot"]["object"]["snapshotUri"]
    assert uri.startswith("s3://agent-box-snapshots/agent-box-host/")
    report[kind] = {**actors[kind], "word": word, "conversation": conversation, "memory_hash": hashlib.sha256(memory.encode()).hexdigest(),
                    "worker_before": worker, "snapshot": snapshot, "pause_seconds": round(time.monotonic() - before, 2)}
    print("SAVED", kind, report[kind]["pause_seconds"], "seconds", flush=True)

for kind, proof in report.items():
    prefix = urllib.parse.urlsplit(proof["snapshot"]["durableSnapshot"]["object"]["snapshotUri"]).path.lstrip("/") + "/"
    objects = json.loads(s3(f"aws s3api list-objects-v2 --bucket agent-box-snapshots --prefix {prefix} --query 'Contents' --output json"))
    assert len(objects) == 1 and objects[0]["Key"] == prefix + "snapshot.tar.zst", objects
    magic = s3(f"aws s3api get-object --bucket agent-box-snapshots --key {prefix}snapshot.tar.zst --range bytes=0-3 /tmp/magic >/dev/null; od -An -tx1 /tmp/magic")
    assert magic.split() == ["28", "b5", "2f", "fd"], magic
    proof.update(single_compressed_object=True, archive_bytes=objects[0]["Size"])

ate = str(root / "vendor/substrate/bin/kubectl-ate")
inventory = json.loads(sp.check_output([ate, "get", "actors", "-A", "-o", "json"]))
workers = {p["worker_before"] for p in report.values()}
for other in inventory.get("actors", []):
    assert other.get("status", {}).get("state") != "ACTOR_STATE_RUNNING" or other["status"].get("workerAssignment", {}).get("workerPod") not in workers, "Another running agent uses the worker"
for worker in workers:
    sp.run(["kubectl", "-n", "pvm-agents", "delete", "pod", worker, "--wait=true", "--timeout=60s"], check=True)

for kind, proof in report.items():
    name = proof["name"]
    before = time.monotonic()
    actor = client.request("POST", "/api/agents/" + name + "/resume")
    proof["resume_seconds"] = round(time.monotonic() - before, 2)
    proof["worker_after"] = actor["status"]["workerAssignment"]["workerPod"]
    assert proof["worker_after"] != proof["worker_before"]
    restored_memory = execute(name, ["python3", "-c", "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8082').read().decode())"])
    assert hashlib.sha256(restored_memory.encode()).hexdigest() == proof["memory_hash"]
    wait_file(name, "/workspace/before.txt", proof["word"])
    wait_file(name, "/workspace/continued", "continued")
    deadline = time.monotonic() + 60
    while client.request("GET", "/api/agents/" + name + "/session")["runner"]["agent_status"] not in ("idle", "done"):
        assert time.monotonic() < deadline
        time.sleep(1)
    client.request("POST", "/api/agents/" + name + "/prompt", {"prompt": "Use bash to write the exact codeword you remember from our earlier conversation into /workspace/after.txt without a newline. Reply done."})
    wait_file(name, "/workspace/after.txt", proof["word"])
    state = client.request("GET", "/api/agents/" + name + "/session")
    assert state["runner"]["agent_session"] == proof["conversation"]
    proof.update(memory_restored=True, files_restored=True, task_continued=True, conversation_continued=True)
    print("RESTORED", kind, proof["resume_seconds"], "seconds", flush=True)

for kind, proof in report.items():
    current = client.request("GET", "/api/agents/" + proof["name"])
    assert current["metadata"]["uid"] == proof["uid"]
    client.request("DELETE", "/api/agents/" + proof["name"])
    prefix = f"agent-box-host/atespaces/pvm-agents/actors/{proof['uid']}/"
    count = s3(f"aws s3api list-objects-v2 --bucket agent-box-snapshots --prefix {prefix} --query 'length(Contents || `[]`)' --output text")
    assert count == "0", count
    files = sp.check_output(["docker", "exec", "agent-sandbox-demo-control-plane", "find", "/var/lib/ate/actors/" + proof["uid"], "-type", "f", "!", "-name", "sandbox-assets.json"], text=True)
    assert not files.strip()
    proof.update(deleted=True, r2_objects_after_delete=0, local_user_files_after_delete=0)

(root / "evidence/r2-verification.json").write_text(json.dumps(report, indent=2) + "\n")
print("PASS R2: one zstd archive, MEMORY on another worker, files, conversation, live task and deletion", flush=True)

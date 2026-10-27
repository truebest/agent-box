"""Run prepare, stop the lifecycle unit, start it and the panel, then run verify and cleanup."""
import hashlib
import json
from pathlib import Path
import shlex
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from agent import Client

pki = Path.home() / ".config/substrate-panel"
client = Client("https://192.0.2.10:8443", pki / "ca.crt", pki / "password")
target = ROOT / "evidence/host-lifecycle-live-targets.json"
probe = ["python3", "-c", "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8082', timeout=5).read().decode())"]


def execute(name, argv):
    result = client.request("POST", "/api/agents/" + name + "/exec", {"argv": argv})
    assert result["exit_code"] == 0, result["output"]
    return result["output"].strip()


def inventory():
    return {a["metadata"]["uid"]: a for a in client.request("GET", "/api/agents").get("actors", [])}


def persist(report):
    target.write_text(json.dumps(report, indent=2) + "\n")


mode = sys.argv[1]
if mode == "prepare":
    assert not target.exists(), "Previous test targets still exist"
    baseline = inventory()
    assert all(a["status"]["state"] == "ACTOR_STATE_SUSPENDED" for a in baseline.values())
    report = {"baseline": [], "probes": []}
    for actor in baseline.values():
        item = {"name": actor["metadata"]["name"], "uid": actor["metadata"]["uid"], "status": actor["status"]}
        report["baseline"].append(item)
    persist(report)
    for kind in ("codex", "pi"):
        name = "verify-host-" + kind + "-" + uuid.uuid4().hex[:8]
        actor = client.request("POST", "/api/agents", {"name": name, "kind": kind})
        item = {"name": name, "uid": actor["metadata"]["uid"], "kind": kind}
        report["probes"].append(item)
        persist(report)
        client.request("POST", "/api/agents/" + name + "/prompt", {"prompt": "Reply exactly lifecycle-ready. Do not use tools."})
        deadline = time.monotonic() + 120
        while True:
            session = client.request("GET", "/api/agents/" + name + "/session")
            if session.get("runner", {}).get("agent_session") and session["runner"].get("agent_status") in ("idle", "done"):
                break
            assert time.monotonic() < deadline, "Runner did not finish the test reply"
            time.sleep(1)
        item["conversation"] = session["runner"]["agent_session"]
        item["pane_id"] = session["pane_id"]
        process = json.loads(execute(name, ["herdr", "pane", "process-info", "--pane", session["pane_id"]]))["result"]["process_info"]
        item["process"] = {key: process[key] for key in ("shell_pid", "foreground_process_group_id")}
        tab = json.loads(execute(name, ["herdr", "tab", "create", "--label", "shutdown-memory", "--cwd", "/workspace"]))
        program = '''from http.server import BaseHTTPRequestHandler,HTTPServer
import secrets
value=secrets.token_hex(32)
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(value.encode())
 def log_message(self,*args): pass
HTTPServer(('127.0.0.1',8082),H).serve_forever()
'''
        execute(name, ["herdr", "pane", "run", tab["result"]["root_pane"]["pane_id"], "python3 -c " + shlex.quote(program)])
        item["memory_sha256"] = hashlib.sha256(execute(name, probe).encode()).hexdigest()
        execute(name, ["python3", "-c", "from pathlib import Path;Path('/workspace/shutdown-proof').write_text('saved-before-stop')"])
        persist(report)
    print("PASS prepared Codex/Pi conversations, files and values held only in memory", flush=True)
else:
    report = json.loads(target.read_text())
    current = inventory()
    if mode == "verify":
        assert set(current) == {item["uid"] for item in report["baseline"] + report["probes"]}
        for item in report["baseline"] + report["probes"]:
            actor = current[item["uid"]]
            assert actor["status"]["state"] == "ACTOR_STATE_SUSPENDED" and not actor["status"].get("workerAssignment")
            if item in report["baseline"]:
                assert actor["status"].get("snapshots") == item["status"].get("snapshots")
            else:
                snapshot = max(actor["status"]["snapshots"], key=lambda s: s["generation"])
                assert snapshot["fidelity"] == "SNAPSHOT_FIDELITY_MEMORY"
                assert snapshot["durableSnapshot"]["status"] == "SNAPSHOT_STORAGE_STATUS_COMPLETED"
                assert snapshot["durableSnapshot"]["object"]["snapshotUri"].startswith("s3://agent-box-snapshots/agent-box-host/")
                item["snapshot"] = snapshot
        report["all_suspended_after_start"] = True
        persist(report)
        print("PASS boot left every sandbox Suspended; R2 snapshots complete, existing snapshots unchanged", flush=True)
    elif mode == "cleanup":
        assert report.get("all_suspended_after_start"), "Verify the saved state first"
        for item in report["probes"]:
            path = "/api/agents/" + item["name"]
            assert current[item["uid"]]["metadata"]["name"] == item["name"]
            client.request("POST", path + "/resume")
            assert hashlib.sha256(execute(item["name"], probe).encode()).hexdigest() == item["memory_sha256"]
            assert execute(item["name"], ["cat", "/workspace/shutdown-proof"]) == "saved-before-stop"
            session = client.request("GET", path + "/session")
            assert session["runner"]["agent_session"] == item["conversation"] and session["pane_id"] == item["pane_id"]
            process = json.loads(execute(item["name"], ["herdr", "pane", "process-info", "--pane", session["pane_id"]]))["result"]["process_info"]
            assert {key: process[key] for key in item["process"]} == item["process"]
            assert client.request("GET", path)["metadata"]["uid"] == item["uid"]
            conversation_path = "/api/console/agents/" + item["name"] + "/" + item["uid"] + "/bridge/api/pane/conversation?pane_id=" + item["pane_id"]
            turns = client.request("GET", conversation_path)["turns"]
            def original_prompts(turns):
                return sum(turn["role"] == "user" and any("Reply exactly lifecycle-ready." in part.get("text", "")
                           for part in turn["parts"]) for turn in turns)
            assert original_prompts(turns) == 1, "Original prompt was replayed or lost"
            client.request("POST", path + "/prompt", {"prompt": "Reply exactly restored-ready. Do not use tools."})
            deadline = time.monotonic() + 120
            while True:
                turns = client.request("GET", conversation_path)["turns"]
                if any(turn["role"] == "assistant" and "restored-ready" in part.get("text", "")
                       for turn in turns for part in turn["parts"]):
                    break
                assert time.monotonic() < deadline, "Runner did not reconnect after restore"
                time.sleep(1)
            assert original_prompts(turns) == 1
            assert client.request("GET", path + "/session")["session_id"] == item["conversation"]
            client.request("DELETE", path)
            item["restored_memory_files_conversation"] = True
            item["native_reconnected_without_prompt_replay"] = True
            persist(report)
        assert set(inventory()) == {item["uid"] for item in report["baseline"]}
        report["probes_deleted"] = True
        persist(report)
        print("PASS same processes, files and conversations restored; temporary sandboxes deleted", flush=True)
    else:
        raise SystemExit("Usage: host-lifecycle-live.py prepare|verify|cleanup")

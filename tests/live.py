"""Live checks against the deployed HTTPS panel. Run on agent-box-host."""
import base64
import json
from pathlib import Path
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent import Client

root = Path(__file__).resolve().parents[1]
config = Path.home() / ".config/substrate-panel"
client = Client("https://192.0.2.10:8443", str(config / "ca.crt"), str(config / "password"))
name = "verify-pi"
path = "/api/agents/" + name


def execute(argv):
    result = client.request("POST", path + "/exec", {"argv": argv, "cwd": "/workspace"})
    assert result["exit_code"] == 0, result
    return result["output"].strip()


def raw(method, endpoint, data=None, headers=None):
    endpoint = client.runtime_path(endpoint)
    request = urllib.request.Request(client.url + endpoint, method=method, data=data,
                                    headers={"Authorization": client.authorization, **(headers or {})})
    return client.opener.open(request, timeout=120)


def rejected(method, endpoint, code, headers=None):
    try:
        raw(method, endpoint, headers=headers)
        raise AssertionError("Request unexpectedly succeeded")
    except urllib.error.HTTPError as error:
        assert error.code == code, (endpoint, error.code)


rejected("POST", path + "/resume", 403, {"Origin": "https://evil.example"})
rejected("GET", path + "/terminal/ws", 403, {"Upgrade": "websocket", "Connection": "Upgrade"})
execute(["python3", "-c", "from pathlib import Path; p=Path('/workspace/escape'); p.unlink(missing_ok=True); p.symlink_to('/etc', target_is_directory=True)"])
for bad in ("/etc/passwd", "/workspace/../etc/passwd", "/workspace/escape/passwd"):
    rejected("GET", path + "/files?path=" + urllib.parse.quote(bad), 400)
with raw("PUT", path + "/files?path=/workspace/upload-check.txt", b"substrate-file-check\n") as response:
    assert response.status == 200
with raw("GET", path + "/files?path=/workspace/upload-check.txt") as response:
    assert response.read() == b"substrate-file-check\n"
print("PASS HTTPS, Origin, WebSocket Origin, path boundaries, upload/download", flush=True)

program = """from http.server import BaseHTTPRequestHandler,HTTPServer
import secrets
value=secrets.token_hex(32)
class H(BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(value.encode())
 def log_message(self,*args): pass
HTTPServer(('127.0.0.1',8082),H).serve_forever()
"""
import shlex
created = json.loads(execute(["herdr", "tab", "create", "--label", "memory-proof", "--cwd", "/workspace"]))
execute(["herdr", "pane", "run", created["result"]["root_pane"]["pane_id"], "python3 -c " + shlex.quote(program)])
probe = ["python3", "-c", "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8082').read().decode())"]
before_value = execute(probe)
before = client.request("GET", path)
suspended = client.request("POST", path + "/suspend")
snapshots = suspended["status"]["snapshots"]
assert any(s["fidelity"] == "SNAPSHOT_FIDELITY_MEMORY" and s.get("durableSnapshot", {}).get("status") == "SNAPSHOT_STORAGE_STATUS_COMPLETED" for s in snapshots), snapshots
pod = before["status"]["workerAssignment"]["workerPod"]
for other in client.request("GET", "/api/agents").get("actors", []):
    assert other["metadata"]["name"] == name or other.get("status", {}).get("state") != "ACTOR_STATE_RUNNING" or other.get("status", {}).get("workerAssignment", {}).get("workerPod") != pod, "Another running actor uses this worker"
subprocess.run(["kubectl", "-n", "pvm-agents", "delete", "pod", pod, "--wait=true", "--timeout=60s"], check=True)
restored = client.request("POST", path + "/resume")
assert restored["status"]["workerAssignment"]["workerPod"] != pod
assert execute(probe) == before_value, "Memory-only value changed across restore"
assert execute(["cat", "/workspace/upload-check.txt"]) == "substrate-file-check"
report = {"memory": True, "worker_before": pod, "worker_after": restored["status"]["workerAssignment"]["workerPod"], "snapshots": snapshots}
(root / "evidence").mkdir(exist_ok=True)
(root / "evidence/memory.json").write_text(json.dumps(report, indent=2) + "\n")
print("PASS MEMORY checkpoint, external snapshot completed, different worker, process and files preserved", flush=True)

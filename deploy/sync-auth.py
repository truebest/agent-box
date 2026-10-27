import base64
import json
from pathlib import Path
import subprocess

auth = (Path.home() / ".config/agent-sandbox/codex-auth.json").read_bytes()
json.loads(auth)
manifest = {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "chatgpt-auth", "namespace": "pvm-agents"},
            "data": {"auth.json": base64.b64encode(auth).decode()}}
subprocess.run(["kubectl", "apply", "--server-side", "--field-manager=agent-box-host", "-f", "-"], input=json.dumps(manifest).encode(), check=True, stdout=subprocess.DEVNULL)

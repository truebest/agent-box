"""Delete only recorded actor UIDs and audit their local, RustFS and R2 storage."""
import json
import copy
import os
from pathlib import Path
import subprocess as sp
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from agent import Client

root = Path(__file__).resolve().parents[1]
pki = Path.home() / ".config/substrate-panel"
client = Client(os.environ.get("AGENT_URL", "https://192.0.2.10:8443"), str(pki / "ca.crt"), str(pki / "password"))
inventory = json.loads(sp.check_output([str(root / "vendor/substrate/bin/kubectl-ate"), "get", "actors", "-A", "-o", "json"]))
actors = inventory.get("actors", [])
target_file = root / "evidence/cleanup-targets.json"
tested = json.loads(target_file.read_text()) if target_file.exists() else []
known_uids = {actor["uid"] for actor in tested}
for actor in actors:
    name = actor["metadata"]["name"]
    if actor["metadata"]["uid"] not in known_uids:
        continue
    uid = actor["metadata"]["uid"]
    assert str(uuid.UUID(uid)) == uid
    assert "--audit-only" not in sys.argv, "A recorded actor still exists during deletion audit"
    assert actor["metadata"]["atespace"] == "pvm-agents"
    client.request("DELETE", "/api/agents/" + name)
tested = list({actor["uid"]: actor for actor in tested}.values())
for actor in tested:
    assert str(uuid.UUID(actor["uid"])) == actor["uid"]
    actor_path = "/var/lib/ate/actors/" + actor["uid"]
    count = sp.check_output(["docker", "exec", "agent-sandbox-demo-control-plane", "sh", "-c",
                             f"if test -d {actor_path}; then find {actor_path} -type f ! -name sandbox-assets.json; fi"], text=True)
    assert not count.strip(), "User data remains locally after delete"

original = json.loads(sp.check_output(["kubectl", "-n", "ate-system", "get", "job", "rustfs-bucket-init", "-o", "json"]))
pod_template = original["spec"]["template"]
pod_template["metadata"] = {"labels": {"agent-box-host-cleanup": "true"}}
container = pod_template["spec"]["containers"][0]
container["command"] = ["/bin/sh", "-ec", "\n".join(
    f"count=$(aws s3api list-objects-v2 --no-paginate --bucket ate-snapshots --prefix agent-box-host/atespaces/pvm-agents/actors/{actor['uid']}/ --query 'length(Contents || `[]`)' --output text); echo {actor['uid']} $count" for actor in tested)]
release = json.loads((root / "images.json").read_text())
if release.get("snapshotStore", {}).get("bucket") == "agent-box-snapshots":
    r2_container = copy.deepcopy(container)
    r2_container["name"] = "r2-check"
    workload = json.loads(sp.check_output(["kubectl", "-n", "ate-system", "get", "daemonset", "atelet", "-o", "json"]))
    r2_container["env"] = next(c for c in workload["spec"]["template"]["spec"]["initContainers"] if c["name"] == "objectstore-plugin")["env"]
    r2_container["command"] = [part.replace("--bucket ate-snapshots", "--bucket agent-box-snapshots") for part in container["command"]]
    pod_template["spec"]["containers"].append(r2_container)
job_name = "pvm-cleanup-" + uuid.uuid4().hex[:10]
manifest = {"apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": job_name, "namespace": "ate-system"},
            "spec": {"backoffLimit": 0, "activeDeadlineSeconds": 90, "ttlSecondsAfterFinished": 600, "template": pod_template}}
policy = {"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": {"name": job_name, "namespace": "ate-system"},
          "spec": {"podSelector": {"matchLabels": {"app": "rustfs"}}, "policyTypes": ["Ingress"],
                   "ingress": [{"from": [{"podSelector": {"matchLabels": {"agent-box-host-cleanup": "true"}}}], "ports": [{"protocol": "TCP", "port": 9000}]}]}}
sp.run(["kubectl", "create", "-f", "-"], input=json.dumps(policy).encode(), check=True)
sp.run(["kubectl", "create", "-f", "-"], input=json.dumps(manifest).encode(), check=True)
sp.run(["kubectl", "-n", "ate-system", "wait", "--for=condition=complete", "job/" + job_name, "--timeout=100s"], check=True)
for check_container in pod_template["spec"]["containers"]:
    lines = sp.check_output(["kubectl", "-n", "ate-system", "logs", "job/" + job_name, "-c", check_container["name"]], text=True).splitlines()
    counts = dict(line.split() for line in lines)
    assert all(counts.get(actor["uid"]) == "0" for actor in tested), counts
for actor in tested:
    actor.update(local_user_files=0, s3_objects=0)
(root / "evidence/cleanup.json").write_text(json.dumps(tested, indent=2) + "\n")
sp.run(["kubectl", "-n", "ate-system", "delete", "job", job_name], check=True)
sp.run(["kubectl", "-n", "ate-system", "delete", "networkpolicy", job_name], check=True)
print("PASS recorded deletions: local user files absent, configured S3 stores empty under recorded UIDs", flush=True)

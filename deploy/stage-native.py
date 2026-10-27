"""Stage isolated native Herdr templates and panel. Production templates and inventory are read-only."""
import json
import runpy
import os
from pathlib import Path
import subprocess as sp
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
storage = runpy.run_path(str(Path(__file__).with_name("panel-image.py")))
configure_session_storage = storage["configure_session_storage"]
ensure_session_claim = storage["ensure_session_claim"]
stage_worker_candidate = runpy.run_path(str(Path(__file__).with_name("worker-profiles.py")))["stage_candidate"]
ATE = "/home/operator/substrate-agent-box-host/vendor/substrate/bin/kubectl-ate"


def run(*args, data=None):
    return sp.check_output(args, input=json.dumps(data).encode() if data is not None else None)


def digest(repository, tag):
    request = urllib.request.Request(f"http://127.0.0.1:5001/v2/{repository}/manifests/{tag}", headers={"Accept": "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"})
    with urllib.request.urlopen(request) as response:
        return f"localhost:5001/{repository}@{response.headers['Docker-Content-Digest']}"


def main():
    os.umask(0o077)
    runtime = digest("agents/native", "candidate")
    panel = digest("panel", "native-candidate")
    evidence = ROOT / "evidence"
    evidence.mkdir(exist_ok=True)
    inventory = json.loads(run(ATE, "get", "actors", "-a", "pvm-agents", "-o", "json")).get("actors", [])
    identity = sorted([{"name": a["metadata"]["name"], "uid": a["metadata"]["uid"]} for a in inventory], key=lambda a: a["name"])
    (evidence / "native-staging-inventory.json").write_text(json.dumps(identity, indent=2) + "\n")
    deployment = json.loads(run("kubectl", "-n", "pvm-agents", "get", "deployment", "panel", "-o", "json"))
    deployment["metadata"] = {"name": "panel-native-candidate", "namespace": "pvm-agents"}
    profiled = stage_worker_candidate(deployment, runtime)
    if not profiled:
        for kind in ("codex", "pi"):
            template = json.loads(run(ATE, "get", "actor-template", kind, "-a", "pvm-agents", "-o", "json"))
            template["metadata"] = {"atespace": "pvm-agents", "name": "native-" + kind}
            template.pop("status", None)
            template["containers"][0]["image"] = runtime
            existing = sp.run([ATE, "get", "actor-template", "native-" + kind, "-a", "pvm-agents", "-o", "json"], capture_output=True)
            if existing.returncode == 0:
                if json.loads(existing.stdout)["containers"][0]["image"] != runtime:
                    raise RuntimeError("Candidate template uses another image; clean up its test sandboxes before replacing it")
            else:
                run(ATE, "create", "actor-template", "-f", "-", data=template)
        sandbox_template = storage["ensure_sandbox_template"](runtime, "native-sandbox-v1")
    configure_session_storage(deployment, "panel-native-candidate-sessions")
    ensure_session_claim("panel-native-candidate-sessions")
    deployment.pop("status", None)
    deployment["spec"]["selector"]["matchLabels"] = {"app": "panel-console-candidate", "variant": "native"}
    deployment["spec"]["template"]["metadata"] = {"labels": {"app": "panel-console-candidate", "variant": "native"}}
    container = deployment["spec"]["template"]["spec"]["containers"][0]
    container["image"] = panel
    deployment["spec"]["template"]["spec"]["volumes"] = [volume for volume in deployment["spec"]["template"]["spec"]["volumes"] if volume["name"] != "console-database"]
    container["volumeMounts"] = [mount for mount in container["volumeMounts"] if mount["name"] != "console-database"]
    changed = {"AGENT_TEMPLATE_PREFIX": "native-", "CONSOLE_ENABLED": "true", "AGENT_IDLE_TIMEOUT": "0s", "PANEL_ORIGIN": "https://192.0.2.10:18443"}
    if not profiled:
        changed["SANDBOX_TEMPLATE"] = sandbox_template
    container["env"] = [item for item in container.get("env", []) if item["name"] not in changed]
    container["env"] += [{"name": key, "value": value} for key, value in changed.items()]
    run("kubectl", "apply", "-f", "-", data=deployment)
    run("kubectl", "-n", "pvm-agents", "rollout", "status", "deployment/panel-native-candidate", "--timeout=180s")
    (evidence / "native-candidate.json").write_text(json.dumps({"runtime": runtime, "panel": panel, "template_prefix": "native-", "deployment": "panel-native-candidate"}, indent=2) + "\n")
    print("native Herdr candidate staged. Forward localhost:18443 to deployment/panel-native-candidate:8443 for verification.")


if __name__ == "__main__":
    main()

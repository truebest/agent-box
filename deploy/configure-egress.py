"""Keep renewed actor certificates on new egress CONNECTs without restarting workers."""
import hashlib
import json
from pathlib import Path
import re
import subprocess as sp
from datetime import datetime, timezone


def configuration(text):
    pattern = r'(require_client_certificate: true\n([ \t]+)common_tls_context:\n\2  alpn_protocols: )\["h2", "http/1.1"\]'
    updated, count = re.subn(pattern, r'\1["http/1.1"]', text)
    if count == 0:
        assert re.search(pattern.replace(r'\["h2", "http/1.1"\]', r'\["http/1.1"\]'), text), "Actor CONNECT TLS listener changed"
    assert count <= 1, "Multiple actor CONNECT listeners"
    return updated


def main():
    root = Path(__file__).resolve().parents[1]
    command = ["kubectl", "-n", "ate-system"]
    current = json.loads(sp.check_output(command + ["get", "configmap", "atenet-egress", "-o", "json"]))
    old = current["data"]["envoy.yaml"]
    new = configuration(old)
    deployment = json.loads(sp.check_output(command + ["get", "deployment", "atenet-egress", "-o", "json"]))
    digest = hashlib.sha256(new.encode()).hexdigest()
    annotations = deployment["spec"]["template"]["metadata"].get("annotations", {})
    if new == old and annotations.get("agent-box-host/egress-config-sha256") == digest:
        print("Egress CONNECT already uses fresh TLS connections")
        return
    # shortcut: H/1 uses a TLS connection per tunnel; restore H/2 once atunnel retires pooled certificates on renewal.
    check = sp.run(command + ["exec", "-i", "deployment/atenet-egress", "-c", "envoy", "--", "/usr/local/bin/envoy", "--mode", "validate", "--config-yaml", new], text=True, capture_output=True)
    if check.returncode:
        raise RuntimeError("Envoy rejected the configuration: " + check.stderr[-1600:])
    backup = root / "archives" / ("before-egress-certificates-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ"))
    backup.mkdir(parents=True)
    for name, value in (("configmap.json", current), ("deployment.json", deployment)):
        (backup / name).write_text(json.dumps(value, indent=2) + "\n")
    patch = [{"op": "test", "path": "/data/envoy.yaml", "value": old}, {"op": "replace", "path": "/data/envoy.yaml", "value": new}]
    sp.run(command + ["patch", "configmap", "atenet-egress", "--type=json", "-p", json.dumps(patch)], check=True)
    sp.run(command + ["patch", "deployment", "atenet-egress", "--type=merge", "-p", json.dumps({"spec": {"template": {"metadata": {"annotations": {"agent-box-host/egress-config-sha256": digest}}}}})], check=True)
    sp.run(command + ["rollout", "status", "deployment/atenet-egress", "--timeout=180s"], check=True)
    print("Egress CONNECT certificate recovery applied; rollback: " + str(backup))


if __name__ == "__main__":
    main()

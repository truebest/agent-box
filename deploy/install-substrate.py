"""Install Substrate into the configured KIND cluster using prebuilt images."""
from pathlib import Path
import subprocess
import json
from configuration import load, require_context, require_user

config = load()
require_context(config)
require_user(config)
root = Path(__file__).resolve().parents[1]
claim = subprocess.check_output(["kubectl", "-n", "ate-system", "get", "pvc", "rustfs-data", "--ignore-not-found", "-o", "json"])
if claim.strip():
    if json.loads(claim)["spec"].get("storageClassName") != config["storage_class"]:
        raise RuntimeError("Existing RustFS volume uses another StorageClass")
else:
    subprocess.run(["kubectl", "create", "-f", "-"], check=True, input=json.dumps({
        "apiVersion": "v1", "kind": "PersistentVolumeClaim",
        "metadata": {"name": "rustfs-data", "namespace": "ate-system"},
        "spec": {"accessModes": ["ReadWriteOnce"], "storageClassName": config["storage_class"],
                 "resources": {"requests": {"storage": "1Ti"}}},
    }).encode())
subprocess.run([
    str(root / "vendor/substrate/bin/ate-setup"), "--config", str(root / "deploy/install.yaml"),
    "--kind-cluster-name", config["kind_cluster"], "--context", config["kube_context"],
    "--image-repo", config["registry_address"] + "/substrate",
    "--ateapi-postgres-storage-class", config["storage_class"], "deploy", "ate-system",
], cwd=root / "vendor/substrate", check=True)

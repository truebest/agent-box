"""Local installation settings shared by deployment commands."""
import ipaddress
import json
import os
from pathlib import Path
import re
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DEFAULTS = {
    "kind_cluster": "agent-box", "registry_name": "agent-box-registry",
    "registry_port": 5001, "registry_volume": "agent-box-registry", "registry_driver": "local",
    "volume_group": "workspaces", "thin_pool": "pool", "workspace_volume": "substrate-ate",
    "workspace_size": "256G", "workspace_mount": "/srv/substrate-ate",
    "storage_class": "standard", "listen_address": "127.0.0.1", "listen_port": 8443,
    "worker_cpu": 2, "worker_memory": "3Gi", "worker_replicas": 1,
}
REQUIRED = {"hostname", "user", "home", "repository", "panel_origin"}


def load(path=None):
    path = Path(path or os.environ.get("AGENT_BOX_CONFIG", ROOT / "deploy/install.local.json"))
    raw = json.loads(path.read_text())
    if not isinstance(raw, dict) or set(raw) - (DEFAULTS.keys() | REQUIRED) or REQUIRED - raw.keys():
        raise ValueError("Installation settings must contain the required fields and no unknown fields")
    cfg = DEFAULTS | raw
    for value in (str(ROOT), str(path.resolve())):
        if not re.fullmatch(r"/[a-zA-Z0-9_./-]+", value):
            raise ValueError("Installation paths must not contain spaces or shell characters")
    for key in ("hostname", "user", "kind_cluster", "registry_name", "registry_volume", "registry_driver",
                "volume_group", "thin_pool", "workspace_volume", "storage_class"):
        if not isinstance(cfg[key], str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", cfg[key]):
            raise ValueError("Invalid installation name: " + key)
    for key in ("home", "repository", "workspace_mount"):
        value = cfg[key]
        if not isinstance(value, str) or not re.fullmatch(r"/[a-zA-Z0-9_./-]+", value) or ".." in Path(value).parts:
            raise ValueError("Use an absolute path without spaces: " + key)
        cfg[key] = str(Path(value).resolve())
    mount = Path(cfg["workspace_mount"])
    protected = [Path(p) for p in ("/dev", "/etc", "/proc", "/sys", "/usr", "/run", cfg["home"], cfg["repository"])]
    if mount in (Path("/"), Path("/var"), Path("/home")) or any(mount == p or p in mount.parents for p in protected) or mount in Path(cfg["repository"]).parents:
        raise ValueError("Choose a dedicated workspace mount directory")
    for key, maximum in (("listen_port", 65535), ("registry_port", 65535), ("worker_cpu", 1024), ("worker_replicas", 128)):
        if type(cfg[key]) is not int or not 1 <= cfg[key] <= maximum:
            raise ValueError("Invalid positive integer: " + key)
    if cfg["listen_port"] < 1024 or cfg["listen_port"] == cfg["registry_port"]:
        raise ValueError("listen_port must be unprivileged and differ from registry_port")
    if not isinstance(cfg["workspace_size"], str) or not re.fullmatch(r"[1-9][0-9]*[MGT]", cfg["workspace_size"]):
        raise ValueError("workspace_size must use M, G or T")
    if not isinstance(cfg["worker_memory"], str) or not re.fullmatch(r"[1-9][0-9]*(Mi|Gi)", cfg["worker_memory"]):
        raise ValueError("worker_memory must use Mi or Gi")
    cfg["worker_memory_mib"] = int(cfg["worker_memory"][:-2]) * (1024 if cfg["worker_memory"].endswith("Gi") else 1)
    if cfg["worker_cpu"] < 2 or cfg["worker_memory_mib"] < 2112:
        raise ValueError("A Worker needs at least 2 CPUs and 2112 MiB for one sandbox")
    if not isinstance(cfg["listen_address"], str) or not isinstance(cfg["panel_origin"], str):
        raise ValueError("listen_address and panel_origin must be strings")
    ipaddress.ip_address(cfg["listen_address"])
    origin = urlsplit(cfg["panel_origin"])
    if (origin.scheme != "https" or not origin.hostname or origin.username or origin.password
            or origin.path not in ("", "/") or origin.query or origin.fragment
            or not re.fullmatch(r"[a-zA-Z0-9.-]+", origin.hostname)):
        raise ValueError("panel_origin must be an HTTPS origin")
    if origin.port == 0:
        raise ValueError("panel_origin must use a positive port")
    port = origin.port or 443
    cfg["panel_origin"] = "https://" + origin.hostname + (":" + str(port) if port != 443 else "")
    cfg["panel_hostname"] = origin.hostname
    cfg["panel_port"] = origin.port or 443
    cfg["kind_node"] = cfg["kind_cluster"] + "-control-plane"
    cfg["kube_context"] = "kind-" + cfg["kind_cluster"]
    cfg["registry_address"] = "localhost:" + str(cfg["registry_port"])
    cfg["registry_url"] = "http://127.0.0.1:" + str(cfg["registry_port"])
    cfg["config_path"] = str(path.resolve())
    return cfg


def require_context(cfg):
    import subprocess
    current = subprocess.check_output(["kubectl", "config", "current-context"], text=True).strip()
    if current != cfg["kube_context"]:
        raise RuntimeError("Select the configured Kubernetes context before applying changes")


def require_user(cfg):
    import pwd
    if pwd.getpwuid(os.geteuid()).pw_name != cfg["user"]:
        raise RuntimeError("Run this command as the configured installation user")

"""Install host services after deploying the panel."""
from pathlib import Path
import subprocess
from configuration import load

def service_units(cfg):
    return {
    "substrate-lifecycle.service": f"""[Unit]
Description=Save agent sandboxes before shutdown and keep them suspended at boot
Requires=docker.service substrate-ate-mount.service
Wants=network-online.target
After=network.target network-online.target docker.service substrate-ate-mount.service
Before=substrate-panel.service
[Service]
Type=oneshot
RemainAfterExit=yes
User={cfg["user"]}
Environment=AGENT_BOX_CONFIG={cfg["config_path"]}
Environment=KUBECONFIG={cfg["home"]}/.kube/config
ExecStart=/usr/bin/python3 {cfg["repository"]}/deploy/host-lifecycle.py boot
ExecStop=/usr/bin/python3 {cfg["repository"]}/deploy/host-lifecycle.py stop
TimeoutStartSec=10min
TimeoutStopSec=infinity
[Install]
WantedBy=multi-user.target
""",
    "substrate-panel.service": f"""[Unit]
Description=HTTPS forwarding to the Agent Box agent panel
Requires=docker.service substrate-lifecycle.service
After=docker.service substrate-ate-mount.service substrate-lifecycle.service
StartLimitIntervalSec=0
[Service]
User={cfg["user"]}
Environment=AGENT_BOX_CONFIG={cfg["config_path"]}
Environment=KUBECONFIG={cfg["home"]}/.kube/config
ExecStart=/usr/local/bin/kubectl --context={cfg["kube_context"]} -n pvm-agents port-forward --address={cfg["listen_address"]} svc/panel {cfg["listen_port"]}:8443
Restart=always
RestartSec=3
TimeoutStopSec=10
[Install]
WantedBy=multi-user.target
""",
    "substrate-auth.service": f"""[Unit]
Description=Refresh central ChatGPT OAuth and update the panel Secret
After=docker.service
[Service]
Type=oneshot
User={cfg["user"]}
Environment=AGENT_BOX_CONFIG={cfg["config_path"]}
Environment=KUBECONFIG={cfg["home"]}/.kube/config
ExecStart=/bin/bash {cfg["repository"]}/deploy/refresh-auth.sh
""",
    "substrate-auth.timer": f"""[Unit]
Description=Keep Agent Box ChatGPT OAuth current
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
""",
}
config = load()
if subprocess.check_output(["hostname"], text=True).strip() != config["hostname"]:
    raise SystemExit("This host does not match the installation configuration")
units = service_units(config)
for name, text in units.items():
    Path("/etc/systemd/system", name).write_text(text)
subprocess.run(["systemctl", "daemon-reload"], check=True)
subprocess.run(["systemctl", "stop", "substrate-panel.service"], check=True)
subprocess.run(["systemctl", "enable", "--now", "substrate-lifecycle.service", "substrate-panel.service"], check=True)
if Path(config["home"], ".config/agent-sandbox/codex-auth.json").exists():
    subprocess.run(["systemctl", "enable", "--now", "substrate-auth.timer"], check=True)
    subprocess.run(["systemctl", "start", "substrate-auth.service"], check=True)

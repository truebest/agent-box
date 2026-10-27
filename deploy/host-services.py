"""Run as root on agent-box-host after deploying the panel."""
from pathlib import Path
import subprocess

assert subprocess.check_output(["hostname"], text=True).strip() == "agent-box-host"
units = {
    "substrate-lifecycle.service": """[Unit]
Description=Save agent sandboxes before shutdown and keep them suspended at boot
Requires=docker.service substrate-ate-mount.service
Wants=network-online.target
After=network.target network-online.target docker.service substrate-ate-mount.service
Before=substrate-panel.service
[Service]
Type=oneshot
RemainAfterExit=yes
User=operator
Environment=KUBECONFIG=/home/operator/.kube/config
ExecStart=/usr/bin/python3 /home/operator/substrate-agent-box-host/deploy/host-lifecycle.py boot
ExecStop=/usr/bin/python3 /home/operator/substrate-agent-box-host/deploy/host-lifecycle.py stop
TimeoutStartSec=10min
TimeoutStopSec=infinity
[Install]
WantedBy=multi-user.target
""",
    "substrate-panel.service": """[Unit]
Description=HTTPS forwarding to the agent-box-host agent panel
Requires=docker.service substrate-lifecycle.service
After=docker.service substrate-ate-mount.service substrate-lifecycle.service
StartLimitIntervalSec=0
[Service]
User=operator
Environment=KUBECONFIG=/home/operator/.kube/config
ExecStart=/usr/local/bin/kubectl -n pvm-agents port-forward --address=192.0.2.10 svc/panel 8443:8443
Restart=always
RestartSec=3
TimeoutStopSec=10
[Install]
WantedBy=multi-user.target
""",
    "substrate-auth.service": """[Unit]
Description=Refresh central ChatGPT OAuth and update the panel Secret
After=docker.service
[Service]
Type=oneshot
User=operator
Environment=KUBECONFIG=/home/operator/.kube/config
ExecStart=/bin/bash /home/operator/substrate-agent-box-host/deploy/refresh-auth.sh
""",
    "substrate-auth.timer": """[Unit]
Description=Keep agent-box-host ChatGPT OAuth current
[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
""",
}
for name, text in units.items():
    Path("/etc/systemd/system", name).write_text(text)
subprocess.run(["systemctl", "daemon-reload"], check=True)
subprocess.run(["systemctl", "stop", "substrate-panel.service"], check=True)
subprocess.run(["systemctl", "enable", "--now", "substrate-lifecycle.service", "substrate-panel.service", "substrate-auth.timer"], check=True)
subprocess.run(["systemctl", "start", "substrate-auth.service"], check=True)

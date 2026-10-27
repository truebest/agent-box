# Deployment

Agent Box deployment scripts target Linux x86-64 with Docker, KIND/Kubernetes,
gVisor and LVM storage. Configure the host, registry, storage and credentials for
your installation before running them.

## Requirements

Use a dedicated Linux x86-64 host with systemd, Docker, Python 3.10 or newer, Git, OpenSSL,
LVM and XFS tools. For the default single-node setup with Worker profiles,
provide at least 8 CPU cores and 8 GiB of RAM. Image builds require internet access. Allow room for the
Kubernetes node image, runtime images, registry, database and snapshots.

The installation uses a single-node KIND cluster. Kubernetes runs Substrate,
PostgreSQL, RustFS, Worker Pods and the panel. Workers run gVisor sandboxes.
Workspace staging uses an XFS logical volume from an existing LVM thin pool.
PostgreSQL, RustFS and panel sessions use the configured Kubernetes StorageClass.
The registry uses a local Docker volume by default.

The included Substrate manifests enable ClusterTrustBundle,
ClusterTrustBundleProjection and PodCertificateRequest. Cloudflare Tunnel and
Access are optional. See [ingress setup](CLOUDFLARE.md).

## Installation

Clone the repository and build the pinned installation tools:

```sh
git clone https://github.com/truebest/agent-box.git
cd agent-box
sh deploy/build-tools.sh
sudo install -m 755 vendor/substrate/bin/kind vendor/substrate/bin/kubectl /usr/local/bin/
```

The other two tools, `ate-setup` and `kubectl-ate`, stay in
`vendor/substrate/bin/`. Run deployment commands from the repository root as a
user with Docker access. Use `sudo` only for the host preparation and service
installation commands shown below.

Create the local configuration:

```sh
cp deploy/install.example.json deploy/install.local.json
chmod 600 deploy/install.local.json
```

Edit the file for your host. It is excluded from Git and Docker build contexts.
Set `repository` to the absolute path of this checkout.
Deployment commands read it automatically. `AGENT_BOX_CONFIG` selects another
file when needed. Pass that selection explicitly through `sudo` for privileged
commands:

```sh
export AGENT_BOX_CONFIG=/secure/agent-box/install.json
sudo env AGENT_BOX_CONFIG="$AGENT_BOX_CONFIG" python3 deploy/prepare-host.py
sudo env AGENT_BOX_CONFIG="$AGENT_BOX_CONFIG" python3 deploy/host-services.py
```

| Settings | What to set |
| --- | --- |
| `hostname`, `user`, `home`, `repository` | Hostname, installation account and absolute checkout path |
| `panel_origin` | Browser-facing HTTPS origin, including its port |
| `listen_address`, `listen_port` | Local HTTPS listener, `127.0.0.1:8443` by default |
| `kind_cluster` | Name for a new KIND cluster |
| `registry_name`, `registry_port`, `registry_volume`, `registry_driver` | Local registry container, port and Docker volume |
| `volume_group`, `thin_pool` | Existing LVM thin pool on a dedicated data disk |
| `workspace_volume`, `workspace_size`, `workspace_mount` | Thin LV to create and its dedicated, empty mount directory |
| `storage_class` | Kubernetes StorageClass for PostgreSQL, RustFS and panel sessions |
| `worker_cpu`, `worker_memory`, `worker_replicas` | Initial Worker requests and limits, and pool size |

The default Worker is 2 CPUs and 3 GiB. Leave additional capacity for Kubernetes
and the control plane. The default sandbox limit is 2 CPUs and 2 GiB.

Provision the LVM thin pool before continuing. Inspect `sudo vgs` and `sudo lvs`
to confirm its name and available capacity. Host preparation creates and formats
a new workspace LV. An existing LV must already use XFS. It refuses a mount
occupied by another device or an unmounted directory containing files.

Prepare the volume, create Kubernetes, and install its mount service:

```sh
sudo python3 deploy/prepare-host.py
python3 deploy/create-cluster.py
sudo python3 deploy/prepare-host.py
python3 deploy/prepare-cluster.py
```

Cluster creation refuses to replace an existing cluster. The other deployment
commands check that the selected Kubernetes context matches the configuration.
The registry listens on loopback and the private KIND bridge. Kubernetes
reaches it through the bridge gateway, which keeps its address stable when the
registry container is recreated.

Build and publish images, install Substrate, then deploy Agent Box:

```sh
sh deploy/build-images.sh
python3 deploy/install-substrate.py
python3 deploy/deploy-agents.py
sudo python3 deploy/host-services.py
```

The included manifests already contain the integration changes.
`deploy/configure-release.py` applies those changes when importing a clean
upstream tree.

Bootstrap creates local panel credentials, a CA and a server certificate for
`panel_origin`. The panel password is in
`~/.config/substrate-panel/password`. Trust the CA from
`~/.config/substrate-panel/ca.crt` on your client and open the configured origin.
The sign-in name is `admin`. For remote access, configure a reachable
`listen_address` and `listen_port`, or an HTTPS ingress that forwards to the local
listener and preserves the canonical origin. The origin port can differ from the
local listener port.

`images.json` records the installed image digests and snapshot location. Keep it
with the local configuration and credential backups. Use
[Worker profiles](worker-profiles.md) to configure additional sandbox capacity.

## Credentials

Provision credentials in owner-only files and Kubernetes Secrets.

| Material | Location |
| --- | --- |
| Panel password, TLS certificate/key, CA certificate/key and bridge key | `~/.config/substrate-panel/` and the panel Secret |
| Central Codex OAuth source | `~/.config/agent-sandbox/codex-auth.json` |
| S3/R2 endpoint, bucket and region | `~/.config/substrate-r2/config.json` |
| S3/R2 access and secret keys | `~/.config/substrate-r2/credentials.json` and Secret `ate-system/substrate-r2` |
| Devin login and conversation state | `/workspace/.agent-state/.config/devin` and `.local/share/devin` |
| Optional Tunnel token | Secret `agent-box-cloudflare-token` |
| Deployment SSH key and trusted host keys | Deployment environment and local `ci/known_hosts` |

Empty workspaces and shells can start before provider authentication is configured.
Codex and Pi receive access-only credentials from the central OAuth source.
`substrate-auth.timer` and `deploy/refresh-auth.sh` refresh authentication.
The timer is enabled when a central OAuth source exists during service installation.
Run `sudo python3 deploy/host-services.py` after adding it to enable refresh.
Devin CLI signs in with its own account. See [Devin CLI](DEVIN_CLI.md).

## Snapshot storage

The snapshot backend uses the S3 API, including Amazon S3 and Cloudflare R2.
Bootstrap uses the bundled RustFS service and bucket `ate-snapshots`.
For external storage, configure an HTTPS endpoint, region, bucket and snapshot
prefix for your provider.

`deploy/configure-r2.py` configures Cloudflare R2. Its validation requires an R2
endpoint, the configured bucket and region `auto`. Adapt that validation and the
network policy when configuring another S3 provider. The configuration paths and
Secret use the name `substrate-r2`.

Configure external snapshot storage before bootstrapping Worker profiles.
The script requires an empty Actor list before changing storage. MEMORY
snapshots contain processes, credentials, conversations and files. Protect the
bucket and keep the images and runtime versions needed for restore.

## Panel configuration

| Setting | Purpose |
| --- | --- |
| `PANEL_ORIGIN` | Canonical HTTPS origin for login, writes and WebSockets |
| `PANEL_HOST` | Host label in the navigation tree |
| `PANEL_SESSION_DIR` | Persistent server-side session store |
| `CONSOLE_ENABLED=true` | Enables Herdr Web integration |
| `WORKER_PROFILES=true`, `WORKER_CATALOG` | Enables Worker profiles and selects their ConfigMap |
| `POD_NAME`, `POD_UID` | Panel Pod identity from the Kubernetes downward API, required by Worker profile management |
| `SANDBOX_TEMPLATE` | Runtime template for new sandboxes |
| `AGENT_IDLE_TIMEOUT` | Defaults to `15m`, or `0s` to disable automatic suspension |
| `AGENT_TEMPLATE_PREFIX` | Template namespace for an isolated test deployment |

Run one panel replica with `Recreate` and persistent session storage. Preserve
its password, bridge key, canonical origin and session directory during upgrades.
Expose the authenticated HTTPS panel and restrict access to runtime, database,
registry and Kubernetes administration ports.

Runtime requests (`session`, `prompt`, `exec`, `files` and `terminal`) carry the
selected sandbox's `metadata.uid` as a `uid` query parameter. Keep that UID with
the selection. A sandbox recreated under the same name requires a new selection.
The Python client pins the first UID observed for each name during its lifetime.

## Updates and recovery

Test image and configuration changes in an isolated deployment with disposable
sandboxes. For SSH deployment with `ci/deploy.sh`, set
`AGENT_BOX_DEPLOY_TARGET` to `user@host` and `AGENT_BOX_INSTALL_DIR` to the
configured checkout path. Set `AGENT_BOX_DEPLOY_CONFIG` when the remote
installation uses a configuration file outside `deploy/install.local.json`.
Release archives are stored under its
`archives/releases/` directory. Save the current configuration and image digests before updating.
`deploy/panel-image.py` verifies image archives and rolls back a failed panel
update. `deploy/refresh-native-runtime.py` creates runtime revisions for future
sandboxes while preserving existing templates and sandbox identities.

Keep registry images and templates referenced by suspended sandboxes. Resume
restores their saved processes and files. Restoring a crashed sandbox uses its
last completed snapshot and discards later changes.

The `substrate-lifecycle` service stops admission, saves MEMORY snapshots before
shutdown and restores host prerequisites at boot. Sandboxes remain suspended
until resumed. Allow enough shutdown time for the pool to save.

Back up PostgreSQL, configuration, credentials, the registry and host storage as
well as sandbox snapshots. Test restore and full-host recovery for your deployment.

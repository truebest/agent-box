# Deployment

Agent Box deployment scripts target Linux x86-64 with Docker, KIND/Kubernetes,
gVisor and LVM storage. Configure the host, registry, storage and credentials for
your installation before running them.

## Requirements

| Component | Purpose |
| --- | --- |
| Docker and KIND | Kubernetes containers and OCI images |
| Kubernetes | Substrate controllers, projected workload identities and Workers |
| Substrate v0.5.0 | Control plane, scheduling, routing and MEMORY snapshots |
| gVisor / runsc | Sandbox runtime |
| LVM, XFS and TopoLVM | Workspace volumes and snapshot staging |
| `workspace-lvm` Docker volume driver | Host volume integration used by `prepare-host.py` |
| OCI registry | Images required to create and restore sandboxes |
| PostgreSQL | Substrate control-plane data |
| RustFS | Local S3-compatible storage used by the bootstrap manifests |
| S3/R2 object storage | Sandbox snapshots |
| systemd | Host services, shutdown and boot recovery |

Choose Kubernetes feature gates and runtime versions compatible with the
included [Substrate source](../vendor/substrate/README.md). The manifests use
ClusterTrustBundle, ClusterTrustBundleProjection and PodCertificateRequest.
Cloudflare Tunnel and Access are optional. See [ingress setup](CLOUDFLARE.md).

## Installation settings

Review hostnames, operator paths, KIND context, registry, panel address, TLS SANs,
storage classes, node selectors, bucket and snapshot prefix in `deploy/`,
`ci/deploy.sh` and `agent.py`. Replace example values with your own configuration.

`deploy/prepare-host.py` configures host mounts, LVM, sysctls, Kubernetes features
and systemd. Install the volume driver it expects before running it.
`deploy/prepare-cluster.py` creates storage secrets and configures the registry.
Review these scripts before applying changes to a host.

Build images with `sh ci/check.sh` and publish them to your registry.
`deploy/build-images.sh` uses its configured local registry. Record the immutable
image digests in a local `images.json` for the deployment scripts.

The included Substrate manifests contain the required integration changes.
`deploy/configure-release.py` applies those changes to a clean upstream tree.
Use `deploy/deploy-agents.py` for bootstrap and configure
[Worker profiles](worker-profiles.md) for sandbox capacity.

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

Codex and Pi receive access-only credentials from the central OAuth source.
`substrate-auth.timer` and `deploy/refresh-auth.sh` refresh authentication.
Devin CLI signs in with its own account. See [Devin CLI](DEVIN_CLI.md).

## Snapshot storage

The snapshot backend uses the S3 API, including Amazon S3 and Cloudflare R2.
Configure an HTTPS endpoint, region, bucket and snapshot prefix for your provider.

`deploy/configure-r2.py` configures Cloudflare R2. Its validation requires an R2
endpoint, the configured bucket and region `auto`. Adapt that validation and the
network policy when configuring another S3 provider. The configuration paths and
Secret use the name `substrate-r2`.

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
sandboxes. Save the current configuration and image digests before updating.
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

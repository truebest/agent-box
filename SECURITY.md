# Security

The panel account has access to all sandboxes it manages. Share it only with
trusted users. Agents in one sandbox share its files, CPU, memory and native HOME.

Codex starts with `--sandbox danger-full-access --ask-for-approval never`.
gVisor and the configured network policy provide the outer sandbox boundary.
Herdr manages the agent processes. Devin CLI uses its native permission and
workspace-trust flow.

## Credentials and data

Browser sessions use opaque Secure, HttpOnly, SameSite=Strict cookies. The server
stores session hashes and expiry data. Login, writes and WebSockets validate the
configured Origin. Panel-to-runtime connections use mTLS and UID-scoped bridge
credentials.

Native credentials and conversation journals live in `/workspace/.agent-state`.
The Files interface can access this directory. Preserve it when reconnecting or
restoring a sandbox, and keep its contents out of repositories and logs.

MEMORY snapshots include processes, files, conversations and access tokens.
Restrict access to the snapshot bucket and backups. Codex and Pi receive access-only
credentials from a central source. Devin CLI authenticates with its own account.
Agents send prompts, code and context to the configured model provider.

Keep passwords, private keys, S3/R2 credentials, Tunnel tokens, kubeconfigs and
deployment keys outside Git. Use scoped credentials and owner-only files.
Avoid credentials in build arguments, image layers, URLs and diagnostic output.

## Network access and recovery

Expose the authenticated HTTPS panel. Keep runtime, terminal, registry, database
and Kubernetes administration ports on restricted networks. Verify TLS trust,
network policies and outbound access for your installation.

Keep completed snapshots and their matching images and templates. Back up
PostgreSQL, host configuration and the registry as well. Test restore and host
recovery, and allow enough time for normal shutdown to save the sandbox pool.

## Report a vulnerability

Use [GitHub's private vulnerability report](https://github.com/truebest/agent-box/security/advisories/new).
Keep credentials, browser sessions, conversations and snapshots out of reports.

Revoke or rotate an exposed credential at its provider. Remove it from the
repository and check the affected commits, artifacts and logs.

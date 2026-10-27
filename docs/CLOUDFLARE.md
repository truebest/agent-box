# Optional Cloudflare access

Cloudflare Tunnel can expose the panel without an inbound router port. Cloudflare
Access adds an identity-provider login before the existing Agent Box sign-in.
The panel password, exact Origin checks and sandbox authorization remain required.
Signing out of Agent Box does not sign out of the identity provider or Access.

## Configure an installation

1. Create a dedicated Tunnel and a self-hosted Access application for your panel
   hostname. Select the identity provider, allowed users/groups and MFA/session
   policy appropriate to your installation. Protect all paths, APIs and WebSockets.
2. Adapt `deploy/cloudflare-ingress.json`: public hostname, lifecycle-gated panel
   address, origin certificate name, Access team name and application audience.
   Keep `noTLSVerify` false and Access validation required.
3. Adapt `deploy/cloudflare-tunnel.yaml`: Tunnel label and the panel address in
   its egress policy. The cloudflared image is pinned to 2026.10.4 by digest.
4. Provision Secret `pvm-agents/agent-box-cloudflare-token` with data key `token`
   from a protected file or stdin. Mount the token file. Never put it in command
   arguments or committed YAML. Provision ConfigMap `agent-box-tunnel-ca` with
   the public CA certificate used to validate the panel origin.
5. Apply the connector manifest and set `PANEL_ORIGIN` on the panel to your exact
   public HTTPS origin. Configure a proxied CNAME to your Tunnel hostname only
   after Access protection is in place.

Set your account, zone, Tunnel and Access application IDs in the configuration.

The ingress JSON is the body for Cloudflare's Tunnel configuration API. Route to
the host's lifecycle-gated HTTPS listener, not directly to the panel Service.
Otherwise boot recovery and shutdown draining are bypassed. Verify the origin
certificate's SAN and mounted CA. The connector NetworkPolicy permits DNS,
panel HTTPS and Cloudflare connectivity. Actual
policy enforcement depends on the cluster networking implementation.

Changing `PANEL_ORIGIN` invalidates existing panel sessions. Long browser
operations send heartbeat responses, but interruption can still leave delivery
uncertain: check current state before retrying a Create, Resume or task.
Browser-only Access login does not automatically authorize the Python CLI. Use
its separately protected administrative route or explicitly provision an
appropriate Access integration.

## Verify and recover

- Verify connector readiness and Tunnel connectivity.
- In a signed-out browser, confirm root, API and WebSocket requests stop at Access.
- Sign in through the configured identity provider, then Agent Box. Open a
  disposable sandbox and reconnect without sending a duplicate prompt.
- Confirm sandbox UIDs, processes and snapshots remain unchanged by ingress updates.
- Retain the old panel environment and connector configuration privately. Rollback
  should affect only this installation's hostname, connector and origin setting.

Rotate the Tunnel token through Cloudflare, replace its Secret through a secure
channel and restart the connector. Never publish tokens, Access JWTs, identity
headers, browser cookies or internal configuration inventories.

Official references: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
and [Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/).

# Agent Box web interface

The management interface uses React, Vite, Tailwind and DaisyUI. It is based on
[Agent-Sandbox UI](https://github.com/agent-sandbox/agent-sandbox/tree/6f7b273ea80732b063d1d1a914b7138780fa83a0/ui),
commit `6f7b273ea80732b063d1d1a914b7138780fa83a0`. Its Apache-2.0 license is in
[public/LICENSE](public/LICENSE).

Agent Box adapts the application shell, themes, sandbox list, file manager and
xterm terminal to the Go/Substrate API. Superterminal embeds Herdr Web with the
overlay in `panel/console/`.

## Pages

- Sandboxes creates and manages sandbox environments and their lifecycle actions.
- Workers manages profiles, capacity and Worker instances.
- Superterminal provides the Host → Worker → Sandbox → Agents tree, chat and
  native terminals.
- Files browses `/workspace`, creates directories and uploads/downloads files.
- Terminal connects to ttyd. Run `herdr` in the shell to attach to persistent panes.
- Tasks sends a prompt to the sandbox's configured primary agent.

The creation dialog supports Codex, Pi, Devin CLI and No agent. It accepts a
model, a directory within `/workspace` and an optional initial prompt. Creation
progress is streamed as NDJSON from `POST /api/agents?stream=1`. An accepted
creation continues after browser disconnects. Check its state before repeating
an action whose delivery is uncertain.

## Authentication and routing

`AuthGate` checks `/api/auth/session` before mounting protected pages. The panel
uses opaque HttpOnly session cookies. Writes and WebSockets validate Origin.
Sign-out revokes the session and clears unsent chat and terminal drafts across
tabs. Theme and display preferences persist in the browser.

Sandbox requests use the selected name and UID. Recreating a name requires
selecting its new UID. Superterminal routes contain both values and store
conversation drafts by UID. The Go proxy connects to the sandbox bridge through
an authenticated mTLS CONNECT tunnel.

Runtime file and terminal requests include a `uid` query parameter. The file
manager rejects symlinks and limits uploads to 64 MiB. Confirmed deletion and
snapshot restore actions explain their effect before submission.

## Superterminal

The integration builds pinned Herdr Web sources and applies
`panel/console/patch.py`. The package includes its MIT license and dependency
notices. Herdr manages agent processes, conversations, input and terminal panes.

The navigation sidebar remains mounted while sandbox sessions change. Chat and
Terminal attach to the selected native session. Agent status shows working,
background activity, pending input, completion or readiness.

The System theme follows the panel's light/dark scheme. Native Light and Dark
settings apply across sandbox sessions in that browser.

## Build and test

Run from `panel/web`:

```sh
npm ci
npm test
npm run lint
npm run build
```

`panel/Dockerfile` builds the frontend, tests the Go API and embeds the generated
assets. It also builds and checks the console overlay. Browser integration tests
live in `tests/`. Run them against disposable sandboxes.

See the [user guide](../../docs/README.md) for UI workflows and
[deployment](../../docs/DEPLOYMENT.md) for installation settings.

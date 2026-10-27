# Third-party components and attribution

Original Agent Box contributions are licensed under [Apache-2.0](LICENSE).
Third-party code, assets and dependencies keep their own licenses. The tables
below list component sources, versions, licenses and dependency inventories.
Provider software and services use their own account and service terms.

## Included and modified source

| Component | Pinned source | License and retained notices | Agent Box changes |
| --- | --- | --- | --- |
| [Agent Substrate](https://github.com/agent-substrate/substrate) | v0.5.0, `e8d40c33f96f4b7a4984bfea7334a36ab5b45b7b` | [Apache-2.0](vendor/substrate/LICENSE). [vendored dependency licenses](vendor/substrate/_LICENSES/) and per-package notices in `vendor/substrate/vendor/` | Installation manifests, snapshot streaming/retry handling, lifecycle and Worker scheduling changes. Maintained build overlay in `storage/` |
| [Agent-Sandbox UI](https://github.com/agent-sandbox/agent-sandbox/tree/6f7b273ea80732b063d1d1a914b7138780fa83a0/ui) | `6f7b273ea80732b063d1d1a914b7138780fa83a0` | [Apache-2.0](panel/web/public/LICENSE) | Adapted React shell, routes, sign-in, sandbox/Worker management, files, terminal and task APIs in `panel/web/`. Reused UI assets |
| [Herdr Web](https://github.com/devswha/herdr-web-ui/tree/cb65ecb9d1d251b42a6875427b6c7d0958150796) | v0.4.8, `cb65ecb9d1d251b42a6875427b6c7d0958150796` | [MIT](panel/console/LICENSE), [upstream license](vendor/herdr-web-ui/LICENSE), [upstream third-party notices](vendor/herdr-web-ui/THIRD_PARTY_NOTICES.md) | Embedded navigation, UID-scoped sessions, workspace/file access, idle state and theme integration through `panel/console/patch.py` and overlays |

Console builds fetch the pinned Herdr Web commit, verify its Bun lockfile and
apply the overlay in `panel/console/`. Keep its MIT license and third-party notices with redistributed source
and bundles. The panel image includes these files in the bridge package.

## Native executables and packages downloaded during builds

| Component | Version | Role | Upstream license / terms |
| --- | --- | --- | --- |
| [Herdr](https://github.com/herdrdev/herdr/tree/v0.9.5) | 0.9.5 | Native agent and persistent shell process manager | Apache-2.0 |
| [OpenAI Codex](https://github.com/openai/codex) | npm `@openai/codex` 0.162.1 | Native Codex CLI | Apache-2.0. Provider access requires its own account/terms |
| [Pi](https://github.com/earendil-works/pi) | `@earendil-works/pi-coding-agent` and `pi-ai` 1.3.0 | Native Pi CLI and central OAuth refresh library | MIT |
| [Devin CLI](https://docs.devin.ai/cli) | 3000.11.205, Linux x86-64 bundle | Native Devin terminal agent | Cognition's applicable software/service terms |
| [ttyd](https://github.com/tsl0922/ttyd/tree/1.7.7) | 1.7.7 | Browser shell transport | MIT |

`runtime/Dockerfile` pins the native binary URLs and SHA-256 digests. npm packages
and their transitive versions/integrity hashes are in
[`runtime/package-lock.json`](runtime/package-lock.json). Include the applicable licenses and notices when distributing built images.

## Web dependencies and build tools

The panel uses React/React DOM 19.2.4, React Router 7.13.1, xterm.js 5.5.0 and
addon-fit 0.10.0, Vite 7.3.1, Tailwind CSS 4.2.1, DaisyUI 5.5.19, PostCSS,
Autoprefixer, ESLint and TypeScript 5.9.3. These main packages use MIT licenses,
except TypeScript's Apache-2.0 license. Consult each package's shipped license for
transitive dependencies and assets.

Herdr Web has its own React 18 application and Bun dependency tree, including
`@lydell/node-pty`, xterm, KaTeX, Mermaid, Lucide, QR and web-push packages.
Its notices include font licenses and non-MIT dependencies such as elkjs.
Use those package and asset licenses when redistributing the bundle.

| Inventory / input | Coverage |
| --- | --- |
| [panel/web/package-lock.json](panel/web/package-lock.json) | Panel production and development npm dependencies, exact versions/integrity |
| [runtime/package-lock.json](runtime/package-lock.json) | Native npm agent packages and OAuth library |
| [panel/console/upstream.bun.lock](panel/console/upstream.bun.lock) | Exact console dependency tree checked against pinned upstream |
| [vendor/substrate/go.mod](vendor/substrate/go.mod), [vendor/modules.txt](vendor/substrate/vendor/modules.txt) | Go module versions compiled into the panel and Substrate components |
| [Substrate dependency licenses](vendor/substrate/_LICENSES/) | Preserved third-party Go license/notice texts |
| [Herdr Web notices](vendor/herdr-web-ui/THIRD_PARTY_NOTICES.md) | Bundled frontend/terminal/fonts/diagram dependency attribution |

Build images use Node.js 24.22.0 for native agents and 22.22.1 for the panel/bridge,
Bun 1.4.2, Go 1.27, Python 3.12, Debian and Google Distroless images. Dockerfiles
record exact image references and digests where supplied. Base image packages
retain their own distribution licenses. Gitleaks 8.30.1 (MIT) is used for
CI secret checks. GitHub Actions checkout and setup-node (MIT) are
pinned by commit in the workflow. Browser integration scripts additionally need
Playwright (Apache-2.0), supplied by the test operator.

## Infrastructure and external services

These are deployment dependencies rather than Agent Box source licenses:

- [gVisor](https://github.com/google/gvisor) (Apache-2.0), Kubernetes and KIND
  (Apache-2.0) provide isolation and orchestration. Substrate's pinned
  sandbox-class configuration selects/checksums its runtime assets.
- Docker/Moby, containerd and the distribution registry provide image execution
  and storage. Their upstream software and distribution terms apply.
- PostgreSQL (PostgreSQL License) stores Substrate lifecycle state. RustFS
  (Apache-2.0) provides local object storage. Its manifest pins `1.0.0-beta.3`
  by digest.
- LVM2, XFS, systemd and TopoLVM support host storage and lifecycle services.
  The deployment scripts use the `workspace-lvm` Docker volume driver.
- S3-compatible object storage, such as Amazon S3 or Cloudflare R2, stores private
  MEMORY snapshots. Optional Cloudflare Tunnel and Access protect public ingress.
  Cloudflared 2026.10.4 is pinned in its manifest.
  Storage, Cloudflare, identity-provider and model-provider accounts, quotas, pricing and
  service terms are separate from this source release.

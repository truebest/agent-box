FROM node:22.22.1-bookworm-slim AS web
WORKDIR /web
COPY panel/web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY panel/web ./
COPY tests/runtime-path.cjs /tests/runtime-path.cjs
RUN npm test && npm run lint && npm run build

FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS console
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git python3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /herdr
RUN git init && git remote add origin https://github.com/devswha/herdr-web-ui.git && git fetch --depth 1 origin cb65ecb9d1d251b42a6875427b6c7d0958150796 && git checkout --detach FETCH_HEAD
COPY panel/console/patch.py panel/console/client.ts panel/console/navigation.tsx panel/console/navigation.css panel/console/entry.ts panel/console/workspace.ts panel/console/idle.ts panel/console/*.test.ts panel/console/upstream.bun.lock /overlay/
COPY --from=web /usr/local/bin/node /console-node
RUN cmp bun.lock /overlay/upstream.bun.lock && python3 /overlay/patch.py /herdr /overlay && bun install --frozen-lockfile
RUN bunx tsc --noEmit && HERDR_TEST_MODE=unit bun test ./src/embedded.test.ts ./server/workspace.test.ts ./server/idle.test.ts && bun --bun run build
RUN mkdir -p /bundle/bin /bundle/server /bundle/node_modules/@lydell && bun build --target=bun server/embedded.ts --outfile /bundle/server/index.js --external @lydell/node-pty && cp server/pty/pty-host.mjs /bundle/server/ && cp -a node_modules/@lydell/node-pty node_modules/@lydell/node-pty-linux-x64 /bundle/node_modules/@lydell/ && cp /usr/local/bin/bun /bundle/bun && cp /console-node /bundle/bin/node && cp LICENSE THIRD_PARTY_NOTICES.md /bundle/ && tar --sort=name --mtime=@0 --owner=1000 --group=1000 --numeric-owner -C /bundle -czf /bridge.tar.gz . && test "$(stat -c %s /bridge.tar.gz)" -lt 134217728 && sha256sum /bridge.tar.gz | cut -d ' ' -f1 > /bridge.sha256

FROM golang:1.27 AS build
WORKDIR /src
COPY vendor/substrate ./
COPY panel ./pvm-panel
COPY --from=web /web/dist ./pvm-panel/web/dist
COPY --from=console /herdr/dist ./pvm-panel/console/dist
RUN --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 go test -buildvcs=false -mod=vendor ./pvm-panel && CGO_ENABLED=0 go build -buildvcs=false -mod=vendor -ldflags='-s -w' -o /panel ./pvm-panel
FROM python:3.12-slim AS python-tests
WORKDIR /src
COPY runtime ./runtime
COPY deploy ./deploy
COPY tests ./tests
COPY ci ./ci
COPY agent.py ./
COPY panel/console/install.py ./panel/console/install.py
COPY vendor/substrate/manifests/ate-install/atenet-egress.yaml ./vendor/substrate/manifests/ate-install/atenet-egress.yaml
RUN python -m unittest discover -s tests -v

FROM gcr.io/distroless/static-debian13:latest@sha256:f2ea2709ac8db56323cbd7d014277f32cb572d9ea124b0076f7aafe5980678fe
COPY --from=build /panel /panel
COPY --from=console /bridge.tar.gz /bridge.sha256 /opt/console/
USER 65532:65532
ENTRYPOINT ["/panel"]

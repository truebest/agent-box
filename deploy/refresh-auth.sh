#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec 9>"$HOME/.config/agent-sandbox/substrate-refresh.lock"
flock -n 9 || exit 0
runtime_image=$(python3 -c 'import json; print(json.load(open("images.json"))["agents"]["pi"])')
docker run --rm --user "$(id -u):$(id -g)" --entrypoint node \
  -v "$HOME/.config/agent-sandbox:/auth" \
  -v "$PWD/deploy/refresh-auth.mjs:/refresh.mjs:ro" \
  "$runtime_image" /refresh.mjs "$@"
python3 deploy/sync-auth.py

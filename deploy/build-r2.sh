#!/bin/bash
set -euo pipefail
cd /home/operator/substrate-agent-box-host
for component in atelet objectstore-plugin; do
  docker build -f deploy/Substrate.Dockerfile --build-arg COMPONENT="$component" -t "localhost:5001/substrate/$component:r2-archive-v1" .
  docker push "localhost:5001/substrate/$component:r2-archive-v1"
done

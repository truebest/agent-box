#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
for component in podcertcontroller ateapi atecontroller atenet atelet objectstore-plugin ateom-gvisor; do
  docker build -f deploy/Substrate.Dockerfile --build-arg COMPONENT="$component" -t "localhost:5001/substrate/$component:v0.5.0" .
  docker push "localhost:5001/substrate/$component:v0.5.0"
done
docker build -f panel/Dockerfile -t localhost:5001/panel:herdr-0.9.5 .
docker push localhost:5001/panel:herdr-0.9.5
docker build -t localhost:5001/substrate/envoy-dataplane:v0.5.0 vendor/substrate/cmd/dataplane/envoy
docker push localhost:5001/substrate/envoy-dataplane:v0.5.0
docker build -t localhost:5001/agents/native:herdr-0.9.5 runtime
docker push localhost:5001/agents/native:herdr-0.9.5

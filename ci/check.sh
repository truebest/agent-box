#!/bin/sh
set -eu
revision=${SOURCE_REVISION:-}
if [ -z "$revision" ]; then
    revision=$(git rev-parse HEAD)
    changes=$(git status --porcelain)
    if [ -n "$changes" ]; then
        printf '%s\n' 'Run image verification from a clean Git checkout.' >&2
        exit 1
    fi
fi
case "$revision" in
  ''|*[!0-9a-f]*) printf '%s\n' 'A full Git commit SHA is required.' >&2; exit 1 ;;
esac
test "${#revision}" -eq 40
docker build -t "agent-box-host-runtime:$revision" runtime
docker build --target checks -f deploy/Substrate.Dockerfile .
docker build --target python-tests -t "agent-box-host-python-tests:$revision" -f panel/Dockerfile .
docker build --target build -t "agent-box-host-panel-check:$revision" -f panel/Dockerfile .
docker run --rm --network=none -e CGO_ENABLED=1 "agent-box-host-panel-check:$revision" go test -race -count=1 -buildvcs=false -mod=vendor ./pvm-panel
docker build -t "agent-box-host-panel:$revision" -f panel/Dockerfile .
mkdir -p artifacts
docker save -o artifacts/panel.tar "agent-box-host-panel:$revision"
gzip -f artifacts/panel.tar
docker image inspect --format '{{json .Id}}' "agent-box-host-panel:$revision" > artifacts/image-id.json
printf '%s\n' "$revision" > artifacts/revision.txt
(cd artifacts && sha256sum panel.tar.gz > SHA256SUMS)
docker save -o artifacts/runtime.tar "agent-box-host-runtime:$revision"
gzip -f artifacts/runtime.tar
docker image inspect --format '{{json .Id}}' "agent-box-host-runtime:$revision" > artifacts/runtime-image-id.json
(cd artifacts && sha256sum runtime.tar.gz > RUNTIME_SHA256SUMS)

for component in worker controller; do
    case "$component" in
        worker) binary=ateom-gvisor ;;
        controller) binary=atecontroller ;;
    esac
    docker build --build-arg "COMPONENT=$binary" -t "agent-box-host-$component:$revision" -f deploy/Substrate.Dockerfile .
    docker save -o "artifacts/$component.tar" "agent-box-host-$component:$revision"
    gzip -f "artifacts/$component.tar"
    docker image inspect --format '{{json .Id}}' "agent-box-host-$component:$revision" > "artifacts/$component-image-id.json"
    (cd artifacts && sha256sum "$component.tar.gz" > "$component-SHA256SUMS")
done

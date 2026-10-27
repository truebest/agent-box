#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker build -f deploy/Tools.Dockerfile --output type=local,dest=vendor/substrate/bin .

#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec python3 deploy/build-images.py

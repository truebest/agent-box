#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 - <<'PYTHON'
import sys
import subprocess
sys.path.insert(0, "deploy")
from configuration import load, require_context
config = load()
require_context(config)
for component in ("atelet", "objectstore-plugin"):
    image = config["registry_address"] + "/substrate/" + component + ":r2-archive-v1"
    subprocess.run(["docker", "build", "-f", "deploy/Substrate.Dockerfile", "--build-arg", "COMPONENT=" + component, "-t", image, "."], check=True)
    subprocess.run(["docker", "push", image], check=True)
PYTHON

"""Build and publish images to the configured local registry."""
from pathlib import Path
import subprocess
from configuration import load, require_context

config = load()
require_context(config)
root = Path(__file__).resolve().parents[1]
registry = config["registry_address"]


def build(dockerfile, repository, tag, context=".", arguments=()):
    image = registry + "/" + repository + ":" + tag
    subprocess.run(["docker", "build", "-f", dockerfile, *arguments, "-t", image, context], cwd=root, check=True)
    subprocess.run(["docker", "push", image], check=True)


for component in ("podcertcontroller", "ateapi", "atecontroller", "atenet", "atelet", "objectstore-plugin", "ateom-gvisor"):
    build("deploy/Substrate.Dockerfile", "substrate/" + component, "v0.5.0", arguments=("--build-arg", "COMPONENT=" + component))
build("panel/Dockerfile", "panel", "herdr-0.9.5")
build("vendor/substrate/cmd/dataplane/envoy/Dockerfile", "substrate/envoy-dataplane", "v0.5.0", "vendor/substrate/cmd/dataplane/envoy")
build("runtime/Dockerfile", "agents/native", "herdr-0.9.5", "runtime")

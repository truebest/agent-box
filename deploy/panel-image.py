"""Deploy verified CI runtime and panel images; preserve the previous configuration."""
import hashlib
import copy
import json
import os
from pathlib import Path
import re
import runpy
import subprocess as sp
import sys
import tarfile
import time
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parent))
from configuration import load, require_context


def configure_session_storage(deployment, claim="panel-sessions"):
    deployment["spec"]["strategy"] = {"type": "Recreate"}
    pod = deployment["spec"]["template"]["spec"]
    pod["volumes"] = [v for v in pod.get("volumes", []) if v["name"] != "panel-sessions"]
    pod["volumes"].append({"name": "panel-sessions", "persistentVolumeClaim": {"claimName": claim}})
    container = pod["containers"][0]
    container["volumeMounts"] = [m for m in container.get("volumeMounts", []) if m["name"] != "panel-sessions"]
    container["volumeMounts"].append({"name": "panel-sessions", "mountPath": "/var/lib/agent-box-auth"})


def ensure_session_claim(name="panel-sessions"):
    storage_class = load()["storage_class"]
    current = sp.check_output(["kubectl", "-n", "pvm-agents", "get", "pvc", name, "--ignore-not-found", "-o", "json"])
    if current.strip():
        spec = json.loads(current)["spec"]
        if spec.get("storageClassName") != storage_class or spec.get("accessModes") != ["ReadWriteOnce"]:
            raise RuntimeError("Unexpected panel session volume configuration")
        return
    claim = {"apiVersion": "v1", "kind": "PersistentVolumeClaim", "metadata": {"name": name, "namespace": "pvm-agents"},
             "spec": {"accessModes": ["ReadWriteOnce"], "storageClassName": storage_class, "resources": {"requests": {"storage": "1Gi"}}}}
    sp.run(["kubectl", "create", "-f", "-"], input=json.dumps(claim).encode(), check=True)


def artifact(directory, component="panel"):
    revision = (directory / "revision.txt").read_text().strip()
    image_id = json.loads((directory / ("image-id.json" if component == "panel" else component + "-image-id.json")).read_text())
    if not re.fullmatch(r"[0-9a-f]{40}", revision) or not isinstance(image_id, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise ValueError("Invalid CI image identity")
    archive = directory / (component + ".tar.gz")
    with archive.open("rb") as stream:
        expected = hashlib.file_digest(stream, "sha256").hexdigest() + "  " + archive.name
    if (directory / ("SHA256SUMS" if component == "panel" else "RUNTIME_SHA256SUMS" if component == "runtime" else component + "-SHA256SUMS")).read_text().strip() != expected:
        raise ValueError("CI image checksum mismatch")
    return revision, image_id, archive


def ensure_sandbox_template(image, name="sandbox-v1"):
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,48}[a-z0-9]", name):
        raise ValueError("Invalid sandbox template name")
    ate = str(Path(load()["repository"]) / "vendor/substrate/bin/kubectl-ate")
    command = [ate, "get", "actor-template"]
    catalog = sp.check_output(["kubectl", "-n", "pvm-agents", "get", "configmap", "worker-profiles", "--ignore-not-found", "-o", "json"])
    if catalog.strip():
        template = json.loads(json.loads(catalog)["data"]["catalog.json"])["base_template"]
    else:
        template = json.loads(sp.check_output(command + ["codex", "-a", "pvm-agents", "-o", "json"]))
    template["metadata"] = {"atespace": "pvm-agents", "name": name}
    template.pop("status", None)
    template["containers"][0]["image"] = image
    assert template["resources"] == {"limits": [{"name": "cpu", "quantity": "2"}, {"name": "memory", "quantity": "2Gi"}]}
    assert template["snapshotConfig"]["preferredFidelity"] == "SNAPSHOT_FIDELITY_MEMORY"
    existing = sp.run(command + [name, "-a", "pvm-agents", "-o", "json"], capture_output=True)
    if existing.returncode == 0:
        current = json.loads(existing.stdout)
        for field in ("containers", "resources", "volumes", "snapshotConfig", "sandboxConfig", "workerSelector"):
            if current.get(field) != template.get(field):
                raise RuntimeError("Immutable sandbox template differs; use another version")
    else:
        sp.run([ate, "create", "actor-template", "-f", "-"], input=json.dumps(template).encode(), check=True)
    return name


def publish_runtime(directory, revision):
    config = load()
    runtime_revision, image_id, archive = artifact(directory, "runtime")
    assert runtime_revision == revision
    sp.check_output(["docker", "load", "-i", str(archive)])
    source = "agent-box-host-runtime:" + revision
    verify_loaded_image(source, image_id)
    tag = config["registry_address"] + "/agents/native:ci-" + revision
    sp.check_output(["docker", "tag", source, tag])
    sp.check_output(["docker", "push", tag])
    request = urllib.request.Request(config["registry_url"] + "/v2/agents/native/manifests/ci-" + revision,
        headers={"Accept": "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"})
    with urllib.request.urlopen(request) as response:
        digest = response.headers["Docker-Content-Digest"]
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", digest)
    image = config["registry_address"] + "/agents/native@" + digest
    name = ensure_sandbox_template(image, "sandbox-v1-" + digest.removeprefix("sha256:")[:12])
    return {"template": name, "image": image}


def verify_loaded_image(source, image_id):
    # Engine image IDs differ by storage backend; compare the exported config digest.
    process = sp.Popen(["docker", "save", source], stdout=sp.PIPE)
    config = manifest = None
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            for member in archive:
                if member.name == "manifest.json":
                    manifest = json.load(archive.extractfile(member))
                elif member.name.rsplit("/", 1)[-1].removesuffix(".json") == image_id.removeprefix("sha256:"):
                    config = member.name
                    assert "sha256:" + hashlib.sha256(archive.extractfile(member).read()).hexdigest() == image_id
        assert process.wait() == 0
        assert manifest and len(manifest) == 1 and source in manifest[0]["RepoTags"]
        assert config and manifest[0]["Config"] == config
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill()
        process.wait()


def publish_workers(directory, revision, live):
    config = load()
    release = json.loads((live / "images.json").read_text())
    previous = sp.check_output(["kubectl", "-n", "ate-system", "get", "deployment", "ate-controller", "-o", "json"])
    (directory / "previous-controller.json").write_bytes(previous)
    for component, binary in (("worker", "ateom-gvisor"), ("controller", "atecontroller")):
        artifact_revision, image_id, archive = artifact(directory, component)
        if artifact_revision != revision:
            raise ValueError("Worker/controller artifact revision differs")
        sp.check_output(["docker", "load", "-i", str(archive)])
        source = "agent-box-host-" + component + ":" + revision
        verify_loaded_image(source, image_id)
        tag = config["registry_address"] + "/substrate/" + binary + ":ci-" + revision
        sp.check_output(["docker", "tag", source, tag])
        sp.check_output(["docker", "push", tag])
        request = urllib.request.Request(config["registry_url"] + "/v2/substrate/" + binary + "/manifests/ci-" + revision,
            headers={"Accept": "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"})
        with urllib.request.urlopen(request) as response:
            digest = response.headers["Docker-Content-Digest"]
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
            raise ValueError("Invalid registry digest")
        release[component] = config["registry_address"] + "/substrate/" + binary + "@" + digest
    sp.check_output(["kubectl", "apply", "--server-side", "--field-manager=ate-setup", "-f", str(directory / "ate.dev_workerpools.yaml")])
    sp.check_output(["kubectl", "apply", "-f", str(directory / "worker-profiles-rbac.yaml")])
    controller = json.loads(previous)
    name = controller["spec"]["template"]["spec"]["containers"][0]["name"]
    sp.check_output(["kubectl", "-n", "ate-system", "set", "image", "deployment/ate-controller", name + "=" + release["controller"]])
    sp.run(["kubectl", "-n", "ate-system", "rollout", "status", "deployment/ate-controller", "--timeout=180s"], check=True)
    # Keep the compatible controller on panel rollback; older controllers discard capacity fields.
    temporary = live / "images.json.tmp"
    temporary.write_text(json.dumps(release, indent=2) + "\n")
    os.replace(temporary, live / "images.json")


def refresh_worker_sources(live, sandbox):
    command = ["kubectl", "-n", "pvm-agents"]
    raw = sp.check_output(command + ["get", "configmap", "worker-profiles", "--ignore-not-found", "-o", "json"])
    if not raw.strip():
        return
    cm = json.loads(raw)
    catalog = json.loads(cm["data"]["catalog.json"])
    release = json.loads((live / "images.json").read_text())
    catalog["worker_image"] = release["worker"]
    if sandbox:
        ate = live / "vendor/substrate/bin/kubectl-ate"
        catalog["base_template"] = json.loads(sp.check_output([str(ate), "get", "actor-template", sandbox["template"], "-a", "pvm-agents", "-o", "json"]))
    cm["data"]["catalog.json"] = json.dumps(catalog)
    sp.run(command + ["replace", "-f", "-"], input=json.dumps(cm).encode(), check=True)


def main(directory):
    config = load()
    os.umask(0o077)
    revision, image_id, archive = artifact(directory)
    require_context(config)
    live = Path(config["repository"])
    run = sp.check_output
    run(["docker", "load", "-i", str(archive)])
    source = "agent-box-host-panel:" + revision
    verify_loaded_image(source, image_id)
    tag = config["registry_address"] + "/panel:ci-" + revision
    run(["docker", "tag", source, tag])
    run(["docker", "push", tag])
    request = urllib.request.Request(config["registry_url"] + "/v2/panel/manifests/ci-" + revision,
        headers={"Accept": "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"})
    with urllib.request.urlopen(request) as response:
        digest = response.headers["Docker-Content-Digest"]
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", digest)
    image = config["registry_address"] + "/panel@" + digest
    command = ["kubectl", "-n", "pvm-agents"]
    previous = json.loads(run(command + ["get", "deployment", "panel", "-o", "json"]))
    assert previous["spec"]["template"]["spec"]["containers"][0]["name"] == "panel"
    old_image = previous["spec"]["template"]["spec"]["containers"][0]["image"]
    (directory / "previous-panel.json").write_text(json.dumps(previous, indent=2) + "\n")
    (directory / "previous-images.json").write_bytes((live / "images.json").read_bytes())
    if (directory / "controller.tar.gz").exists():
        publish_workers(directory, revision, live)
    desired = copy.deepcopy(previous)
    configure_session_storage(desired)
    ensure_session_claim()
    sandbox = publish_runtime(directory, revision) if (directory / "runtime.tar.gz").exists() else None
    if sandbox:
        container = desired["spec"]["template"]["spec"]["containers"][0]
        container["env"] = [entry for entry in container.get("env", []) if entry["name"] != "SANDBOX_TEMPLATE"]
        container["env"].append({"name": "SANDBOX_TEMPLATE", "value": sandbox["template"]})

    lifecycle_previous = None
    configuration_previous = None
    if (directory / "controller.tar.gz").exists():
        catalog = run(command + ["get", "configmap", "worker-profiles", "--ignore-not-found", "-o", "json"])
        if catalog.strip():
            container = desired["spec"]["template"]["spec"]["containers"][0]
            container["env"] = [entry for entry in container.get("env", []) if entry["name"] != "WORKER_PROFILES"]
            container["env"].append({"name": "WORKER_PROFILES", "value": "true"})
            container["env"] = [entry for entry in container["env"] if entry["name"] not in ("POD_NAME", "POD_UID")]
            container["env"] += [{"name": "POD_NAME", "valueFrom": {"fieldRef": {"fieldPath": "metadata.name"}}},
                                 {"name": "POD_UID", "valueFrom": {"fieldRef": {"fieldPath": "metadata.uid"}}}]
            lifecycle = live / "deploy/host-lifecycle.py"
            lifecycle_previous = lifecycle.read_bytes()
            (directory / "previous-host-lifecycle.py").write_bytes(lifecycle_previous)
            configuration_module = live / "deploy/configuration.py"
            if configuration_module.exists():
                configuration_previous = configuration_module.read_bytes()
                (directory / "previous-configuration.py").write_bytes(configuration_previous)
            pending_configuration = configuration_module.with_suffix(".py.tmp")
            pending_configuration.write_bytes((directory / "configuration.py").read_bytes())
            os.replace(pending_configuration, configuration_module)
            lifecycle.write_bytes((directory / "host-lifecycle.py").read_bytes())

    def service(action):
        run(["docker", "run", "--rm", "--privileged", "--pid=host", "-v", "/:/host", "python:3.12",
            "nsenter", "-t", "1", "-m", "-u", "-i", "-n", "-p", "--", "systemctl", action, "substrate-panel.service"])

    def replace(expected, replacement, configuration):
        pod = copy.deepcopy(configuration["spec"]["template"]["spec"])
        pod["containers"][0]["image"] = replacement
        patch = [{"op": "test", "path": "/spec/template/spec/containers/0/image", "value": expected},
                 {"op": "add", "path": "/spec/strategy", "value": configuration["spec"].get("strategy", {"type": "RollingUpdate"})},
                 {"op": "replace", "path": "/spec/template/spec", "value": pod}]
        run(command + ["patch", "deployment", "panel", "--type=json", "-p", json.dumps(patch)])
        sp.run(command + ["rollout", "status", "deployment/panel", "--timeout=180s"], check=True)

    def healthy():
        forward = sp.Popen(command + ["port-forward", "--address=127.0.0.1", "deployment/panel", "19443:8443"], stdout=sp.DEVNULL, stderr=sp.DEVNULL)
        try:
            probe = runpy.run_path(str(live / "deploy/host-lifecycle.py"))["request"]
            deadline = time.monotonic() + 30
            while True:
                try:
                    probe("GET", "/api/console")
                    return
                except RuntimeError:
                    assert forward.poll() is None and time.monotonic() < deadline
                    time.sleep(0.2)
        finally:
            forward.terminate()
            forward.wait(timeout=10)

    service("stop")
    try:
        try:
            replace(old_image, image, desired)
            healthy()
            if (directory / "controller.tar.gz").exists():
                refresh_worker_sources(live, sandbox)
            release = json.loads((live / "images.json").read_text())
            release["panel"] = image
            if sandbox:
                release["sandbox"] = sandbox
            temporary = live / "images.json.tmp"
            temporary.write_text(json.dumps(release, indent=2) + "\n")
            os.replace(temporary, live / "images.json")
        except BaseException:
            if lifecycle_previous is not None:
                lifecycle.write_bytes(lifecycle_previous)
                if configuration_previous is None:
                    configuration_module.unlink()
                else:
                    configuration_module.write_bytes(configuration_previous)
            replace(image, old_image, previous)
            raise
    finally:
        service("start")
    print(json.dumps({"image": image, "previous_image": old_image, "revision": revision, "backup": str(directory)}))


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())

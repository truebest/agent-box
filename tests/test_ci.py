import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import tarfile
import unittest
from unittest.mock import MagicMock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("panel_image", ROOT / "deploy/panel-image.py")
panel_image = importlib.util.module_from_spec(spec)
spec.loader.exec_module(panel_image)


class CI(unittest.TestCase):
    def test_deploy_key_is_private_scoped_and_removed_on_success_or_failure(self):
        for fail in (False, True):
            with self.subTest(fail=fail), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                (root / "artifacts").mkdir()
                (root / "bin").mkdir()
                revision = "a" * 40
                (root / "artifacts/revision.txt").write_text(revision)
                data = b"image fixture"
                (root / "artifacts/panel.tar.gz").write_bytes(data)
                (root / "artifacts/SHA256SUMS").write_text(hashlib.sha256(data).hexdigest() + "  panel.tar.gz\n")
                (root / "artifacts/RUNTIME_SHA256SUMS").write_text(hashlib.sha256(data).hexdigest() + "  runtime.tar.gz\n")
                (root / "artifacts/runtime.tar.gz").write_bytes(data)
                for component in ("worker", "controller"):
                    (root / ("artifacts/" + component + ".tar.gz")).write_bytes(data)
                    (root / ("artifacts/" + component + "-SHA256SUMS")).write_text(hashlib.sha256(data).hexdigest() + "  " + component + ".tar.gz\n")
                script = """#!/usr/bin/env python3
import json, os, pathlib, stat, sys
args = sys.argv[1:]
key = pathlib.Path(args[args.index('-i') + 1])
assert key.read_bytes() == b'test-only-key'
assert stat.S_IMODE(key.stat().st_mode) == 0o600
assert stat.S_IMODE(key.parent.stat().st_mode) == 0o700
assert 'AGENT_BOX_DEPLOY_SSH_KEY_B64' not in os.environ
assert 'StrictHostKeyChecking=yes' in args
assert 'UserKnownHostsFile=ci/known_hosts' in args
with open(os.environ['DEPLOY_TRACE'], 'a') as output:
    output.write(json.dumps(str(key)) + '\\n')
sys.exit(1 if os.environ['DEPLOY_FAIL'] == '1' else 0)
"""
                for name in ("ssh", "scp"):
                    executable = root / "bin" / name
                    executable.write_text(script)
                    executable.chmod(0o755)
                trace = root / "trace.jsonl"
                env = dict(os.environ, SOURCE_BRANCH="main", SOURCE_REVISION=revision, BUILD_NUMBER="5",
                           AGENT_BOX_DEPLOY_SSH_KEY_B64=base64.b64encode(b"test-only-key").decode(),
                           PATH=str(root / "bin") + os.pathsep + os.environ["PATH"], DEPLOY_TRACE=str(trace), DEPLOY_FAIL="1" if fail else "0")
                result = subprocess.run(["sh", str(ROOT / "ci/deploy.sh")], cwd=root, env=env, capture_output=True)
                self.assertEqual(result.returncode, 1 if fail else 0, result.stderr)
                keys = [Path(json.loads(line)) for line in trace.read_text().splitlines()]
                self.assertEqual(len(keys), 1 if fail else 3)
                self.assertTrue(all(not key.parent.exists() for key in keys))

    def test_loaded_image_checks_the_tag_and_config_digest_across_storage_backends(self):
        config = b'{"rootfs":{"diff_ids":[]}}'
        digest = hashlib.sha256(config).hexdigest()
        source = "agent-box-host-panel:" + "a" * 40
        for path in (digest + ".json", "blobs/sha256/" + digest):
            for correct_tag in (True, False):
                with self.subTest(path=path, correct_tag=correct_tag):
                    stream = io.BytesIO()
                    manifest = [{"Config": path, "RepoTags": [source if correct_tag else "another-image:latest"]}]
                    with tarfile.open(fileobj=stream, mode="w") as archive:
                        for name, data in ((path, config), ("manifest.json", json.dumps(manifest).encode())):
                            member = tarfile.TarInfo(name)
                            member.size = len(data)
                            archive.addfile(member, io.BytesIO(data))
                    stream.seek(0)
                    process = MagicMock(stdout=stream)
                    process.wait.return_value = 0
                    process.poll.return_value = 0
                    with patch.object(panel_image.sp, "Popen", return_value=process):
                        if correct_tag:
                            panel_image.verify_loaded_image(source, "sha256:" + digest)
                        else:
                            with self.assertRaises(AssertionError):
                                panel_image.verify_loaded_image(source, "sha256:" + digest)

    def test_invalid_commit_is_rejected_before_running_docker(self):
        for revision in ("", "main", "a" * 39, "a" * 40 + ";false"):
            with self.subTest(revision=revision):
                result = subprocess.run(["/bin/sh", str(ROOT / "ci/check.sh")], env={"SOURCE_REVISION": revision, "PATH": "/missing"}, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(b"docker", result.stderr)

    def test_source_revision_is_accepted_without_provider_metadata(self):
        result = subprocess.run(["/bin/sh", str(ROOT / "ci/check.sh")],
                                env={"SOURCE_REVISION": "a" * 40, "PATH": "/missing"}, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"docker", result.stderr)

    def test_check_uses_the_current_checkout_revision(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            revision = "a" * 40
            git = directory / "git"
            git.write_text('#!/bin/sh\ncase "$*" in\n'
                           '  "rev-parse HEAD") printf "%s\\n" ' + revision + ' ;;\n'
                           '  "status --porcelain") printf "%s" "${CHECK_DIRTY:-}" ;;\n'
                           '  *) exit 1 ;;\nesac\n')
            git.chmod(0o755)
            docker = directory / "docker"
            docker.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\nexit 42\n')
            docker.chmod(0o755)
            env = dict(os.environ, PATH=str(directory) + os.pathsep + os.environ["PATH"])
            for name in ("SOURCE_REVISION", "SOURCE_REVISION"):
                env.pop(name, None)
            for dirty in (False, True):
                with self.subTest(dirty=dirty):
                    env["CHECK_DIRTY"] = " M README.md" if dirty else ""
                    result = subprocess.run(["/bin/sh", str(ROOT / "ci/check.sh")], cwd=directory,
                                            env=env, capture_output=True)
                    self.assertEqual(result.returncode, 1 if dirty else 42, result.stderr)
                    if dirty:
                        self.assertIn(b"clean Git checkout", result.stderr)
                        self.assertEqual(result.stdout, b"")
                    else:
                        self.assertIn(revision.encode(), result.stdout)

    def test_deployment_checks_revision_image_and_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "revision.txt").write_text("a" * 40)
            (directory / "image-id.json").write_text(json.dumps("sha256:" + "b" * 64))
            archive = directory / "panel.tar.gz"
            archive.write_bytes(b"image fixture")
            (directory / "SHA256SUMS").write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + "  panel.tar.gz\n")
            self.assertEqual(panel_image.artifact(directory), ("a" * 40, "sha256:" + "b" * 64, archive))
            archive.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "checksum"):
                panel_image.artifact(directory)
            (directory / "revision.txt").write_text("main;false")
            with self.assertRaisesRegex(ValueError, "identity"):
                panel_image.artifact(directory)

    def test_failed_rollout_or_health_restores_image_and_reopens_public_forward(self):
        for failure, profiles_enabled in (("rollout", False), ("health", False), ("rollout", True), ("health", True)):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                (directory / "runtime.tar.gz").touch()
                live = directory / "live"
                live.mkdir()
                (live / "images.json").write_text('{"panel":"old-image"}\n')
                if profiles_enabled:
                    (directory / "controller.tar.gz").touch()
                    (live / "deploy").mkdir()
                    (live / "deploy/host-lifecycle.py").write_text("old lifecycle")
                    (directory / "host-lifecycle.py").write_text("new lifecycle")
                previous = {"spec": {"template": {"spec": {"containers": [{"name": "panel", "image": "old-image"}], "volumes": [{"name": "original"}]}}}}
                commands = []

                def run(command):
                    commands.append(command)
                    if command[:6] == ["kubectl", "-n", "pvm-agents", "get", "deployment", "panel"]:
                        return json.dumps(previous).encode()
                    if profiles_enabled and "configmap" in command:
                        return b'{"metadata":{"name":"worker-profiles"}}'
                    return b""

                response = MagicMock()
                response.__enter__.return_value.headers = {"Docker-Content-Digest": "sha256:" + "c" * 64}
                process = MagicMock()
                process.poll.return_value = None
                rollouts = [subprocess.CalledProcessError(1, "rollout"), None] if failure == "rollout" else [None, None]
                with patch.object(panel_image, "Path", return_value=live), \
                        patch.object(panel_image, "artifact", return_value=("a" * 40, "sha256:" + "b" * 64, directory / "panel.tar.gz")), \
                        patch.object(panel_image, "verify_loaded_image"), \
                        patch.object(panel_image, "ensure_session_claim"), \
                        patch.object(panel_image, "publish_workers"), \
                        patch.object(panel_image, "refresh_worker_sources"), \
                        patch.object(panel_image, "publish_runtime", return_value={"template": "sandbox-v1-123456abcdef", "image": "new-runtime"}), \
                        patch.object(panel_image.sp, "check_output", side_effect=run), \
                        patch.object(panel_image.sp, "run", side_effect=rollouts), \
                        patch.object(panel_image.sp, "Popen", return_value=process), \
                        patch.object(panel_image.urllib.request, "urlopen", return_value=response), \
                        patch.object(panel_image.runpy, "run_path", return_value={"request": MagicMock(side_effect=RuntimeError("unhealthy"))}), \
                        patch.object(panel_image.time, "monotonic", side_effect=[0, 31]):
                    with self.assertRaises((subprocess.CalledProcessError, AssertionError)):
                        panel_image.main(directory)
                changes = [json.loads(command[-1]) for command in commands if "--type=json" in command]
                self.assertEqual(len(changes), 2)
                self.assertEqual(changes[0][0]["value"], "old-image")
                self.assertEqual(changes[0][1]["value"], {"type": "Recreate"})
                self.assertEqual(changes[0][2]["value"]["containers"][0]["image"], "localhost:5001/panel@sha256:" + "c" * 64)
                self.assertIn({"name": "SANDBOX_TEMPLATE", "value": "sandbox-v1-123456abcdef"}, changes[0][2]["value"]["containers"][0]["env"])
                self.assertEqual(changes[1][2]["value"], previous["spec"]["template"]["spec"])
                self.assertEqual([command[-2] for command in commands if "nsenter" in command], ["stop", "start"])
                self.assertEqual(json.loads((live / "images.json").read_text()), {"panel": "old-image"})
                self.assertEqual(json.loads((directory / "previous-panel.json").read_text()), previous)
                if profiles_enabled:
                    self.assertEqual((live / "deploy/host-lifecycle.py").read_text(), "old lifecycle")

    def test_catalog_sources_refresh_without_rewriting_versions(self):
        catalog = {"worker_image": "old-worker", "base_template": {"containers": [{"image": "old-runtime"}]},
                   "profiles": [{"id": "standard", "revisions": [{"worker_image": "old-worker", "template_spec": {"image": "old-runtime"}}]}],
                   "bindings": {"legacy": {"profile_id": "standard", "revision": 1}}, "instances": [{"name": "running"}]}
        cm = {"metadata": {"resourceVersion": "17"}, "data": {"catalog.json": json.dumps(catalog)}}
        with tempfile.TemporaryDirectory() as temporary:
            live = Path(temporary)
            (live / "images.json").write_text(json.dumps({"worker": "verified-worker"}))
            with patch.object(panel_image.sp, "check_output", side_effect=[json.dumps(cm).encode(), b'{"containers":[{"image":"verified-runtime"}]}']), \
                    patch.object(panel_image.sp, "run") as run:
                panel_image.refresh_worker_sources(live, {"template": "verified-template"})
        updated = json.loads(run.call_args.kwargs["input"])
        self.assertEqual(updated["metadata"]["resourceVersion"], "17")
        result = json.loads(updated["data"]["catalog.json"])
        for key in ("profiles", "bindings", "instances"):
            self.assertEqual(result[key], catalog[key])
        self.assertEqual(result["worker_image"], "verified-worker")
        self.assertEqual(result["base_template"]["containers"][0]["image"], "verified-runtime")

    def test_runtime_archive_is_verified_independently(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "revision.txt").write_text("a" * 40)
            (directory / "runtime-image-id.json").write_text(json.dumps("sha256:" + "b" * 64))
            archive = directory / "runtime.tar.gz"
            archive.write_bytes(b"runtime fixture")
            (directory / "RUNTIME_SHA256SUMS").write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + "  runtime.tar.gz\n")
            self.assertEqual(panel_image.artifact(directory, "runtime")[2], archive)
            archive.write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "checksum"):
                panel_image.artifact(directory, "runtime")

    def test_sandbox_template_is_immutable_and_preserves_memory_and_limits(self):
        template = {"metadata": {"name": "codex"}, "containers": [{"image": "old-runtime"}],
                    "resources": {"limits": [{"name": "cpu", "quantity": "2"}, {"name": "memory", "quantity": "2Gi"}]},
                    "snapshotConfig": {"preferredFidelity": "SNAPSHOT_FIDELITY_MEMORY"}}
        current = json.loads(json.dumps(template))
        current["containers"][0]["image"] = "new-runtime"
        with patch.object(panel_image.sp, "check_output", side_effect=lambda args: b"" if args[0] == "kubectl" else json.dumps(template).encode()), \
                patch.object(panel_image.sp, "run", return_value=MagicMock(returncode=0, stdout=json.dumps(current).encode())) as run:
            panel_image.ensure_sandbox_template("new-runtime", "sandbox-v1-123456abcdef")
            self.assertEqual(run.call_count, 1)
            with self.assertRaisesRegex(RuntimeError, "Immutable"):
                panel_image.ensure_sandbox_template("another-runtime", "sandbox-v1-123456abcdef")
            self.assertEqual(run.call_count, 2)

    def test_sandbox_template_uses_catalog_after_legacy_templates_are_deleted(self):
        template = {"metadata": {"name": "sandbox-v1-current", "uid": "old-uid"}, "status": {},
                    "containers": [{"image": "old-runtime"}],
                    "resources": {"limits": [{"name": "cpu", "quantity": "2"}, {"name": "memory", "quantity": "2Gi"}]},
                    "snapshotConfig": {"preferredFidelity": "SNAPSHOT_FIDELITY_MEMORY", "storageLocation": "s3://snapshots/"},
                    "workerSelector": {"matchLabels": {"workload": "pvm-agents"}}}
        catalog = {"data": {"catalog.json": json.dumps({"base_template": template})}}
        def lookup(args):
            self.assertEqual(args[:6], ["kubectl", "-n", "pvm-agents", "get", "configmap", "worker-profiles"])
            return json.dumps(catalog).encode()
        with patch.object(panel_image.sp, "check_output", side_effect=lookup), \
                patch.object(panel_image.sp, "run", side_effect=[MagicMock(returncode=1), MagicMock(returncode=0)]) as run:
            panel_image.ensure_sandbox_template("new-runtime", "sandbox-v1-next")
        created = json.loads(run.call_args.kwargs["input"])
        self.assertEqual(created["metadata"], {"atespace": "pvm-agents", "name": "sandbox-v1-next"})
        self.assertNotIn("status", created)
        self.assertEqual(created["containers"][0]["image"], "new-runtime")
        for key in ("resources", "snapshotConfig", "workerSelector"):
            self.assertEqual(created[key], template[key])

    def test_runtime_publish_accepts_the_oci_manifest_exported_by_ci(self):
        revision, digest = "a" * 40, "sha256:" + "b" * 64
        def registry(request):
            if "application/vnd.oci.image.manifest.v1+json" not in request.get_header("Accept"):
                raise panel_image.urllib.error.HTTPError(request.full_url, 404, "OCI manifest not accepted", {}, None)
            response = MagicMock()
            response.__enter__.return_value.headers = {"Docker-Content-Digest": digest}
            return response
        with patch.object(panel_image, "artifact", return_value=(revision, digest, Path("runtime.tar.gz"))), \
                patch.object(panel_image, "verify_loaded_image"), \
                patch.object(panel_image.sp, "check_output"), \
                patch.object(panel_image.urllib.request, "urlopen", side_effect=registry), \
                patch.object(panel_image, "ensure_sandbox_template", side_effect=lambda image, name: name):
            result = panel_image.publish_runtime(Path("artifacts"), revision)
        self.assertEqual(result, {"image": "localhost:5001/agents/native@" + digest, "template": "sandbox-v1-" + "b" * 12})

    def test_session_storage_is_idempotent_and_preserves_existing_configuration(self):
        deployment = {"spec": {"template": {"spec": {"volumes": [{"name": "auth"}],
            "containers": [{"env": [{"name": "CONSOLE_ENABLED", "value": "true"}], "volumeMounts": [{"name": "auth", "mountPath": "/run/auth"}]}]}}}}
        for _ in range(2):
            panel_image.configure_session_storage(deployment, "candidate-sessions")
        pod = deployment["spec"]["template"]["spec"]
        self.assertEqual(deployment["spec"]["strategy"], {"type": "Recreate"})
        self.assertEqual(pod["volumes"], [{"name": "auth"}, {"name": "panel-sessions", "persistentVolumeClaim": {"claimName": "candidate-sessions"}}])
        self.assertEqual(len(pod["containers"][0]["volumeMounts"]), 2)
        self.assertEqual(pod["containers"][0]["env"], [{"name": "CONSOLE_ENABLED", "value": "true"}])

    def test_session_claim_creation_and_drift_guard(self):
        with patch.object(panel_image.sp, "check_output", return_value=b""), patch.object(panel_image.sp, "run") as run:
            panel_image.ensure_session_claim("candidate-sessions")
            claim = json.loads(run.call_args.kwargs["input"])
            self.assertEqual(claim["metadata"]["name"], "candidate-sessions")
            self.assertEqual(claim["spec"]["resources"]["requests"]["storage"], "1Gi")
        for storage, modes, accepted in (("agent-thin", ["ReadWriteOnce"], True), ("another-class", ["ReadWriteOnce"], False)):
            current = json.dumps({"spec": {"storageClassName": storage, "accessModes": modes}}).encode()
            with patch.object(panel_image.sp, "check_output", return_value=current), patch.object(panel_image.sp, "run") as run:
                if accepted:
                    panel_image.ensure_session_claim()
                else:
                    with self.assertRaises(RuntimeError):
                        panel_image.ensure_session_claim()
                run.assert_not_called()

"""Repeated deployment must never reset autoscaled Worker replicas."""
import ast
import contextlib
import json
import importlib.util
from pathlib import Path
import runpy
import types
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]


class WorkerDeployTests(unittest.TestCase):
    def test_legacy_installer_requires_confirmed_catalog_absence(self):
        source = ast.parse((ROOT / "deploy/deploy-agents.py").read_text())
        guard = next(node for node in source.body if isinstance(node, ast.If))
        check = compile(ast.Module(body=[guard], type_ignores=[]), "catalog_guard", "exec")
        lookup = Mock(return_value=b"")
        namespace = {"sp": types.SimpleNamespace(check_output=lookup)}
        exec(check, namespace)
        self.assertIn("--ignore-not-found", lookup.call_args.args[0])
        lookup.return_value = b"configmap/worker-profiles\n"
        with self.assertRaises(SystemExit):
            exec(check, namespace)
        lookup.side_effect = RuntimeError("Kubernetes unavailable")
        with self.assertRaisesRegex(RuntimeError, "Kubernetes unavailable"):
            exec(check, namespace)

    def test_existing_template_resource_drift_is_not_silently_ignored(self):
        source = ast.parse((ROOT / "deploy/deploy-agents.py").read_text())
        resources = next(node for node in source.body if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "sandbox_resources" for t in node.targets))
        guard = next(node for node in source.body if isinstance(node, ast.For) and isinstance(node.target, ast.Tuple))
        for exists, image, cpu, memory, reject in (
            (True, "runtime", "2", "2Gi", False),
            (True, "runtime", "4", "2Gi", True),
            (True, "runtime", "2", "1Gi", True),
            (True, "old-runtime", "2", "2Gi", True),
            (False, "runtime", "4", "2Gi", False),
        ):
            with self.subTest(exists=exists, image=image, cpu=cpu, memory=memory):
                current = {"containers": [{"image": image}], "resources": {"limits": [{"name": "cpu", "quantity": cpu}, {"name": "memory", "quantity": memory}]}}
                response = types.SimpleNamespace(returncode=0 if exists else 1, stdout=json.dumps(current))
                namespace = {"images": {"codex": "runtime"}, "ate": "ate", "json": json, "sp": types.SimpleNamespace(run=Mock(return_value=response))}
                check = compile(ast.Module(body=[resources, guard], type_ignores=[]), "template_profile", "exec")
                if reject:
                    with self.assertRaisesRegex(RuntimeError, "resource profile"):
                        exec(check, namespace)
                else:
                    exec(check, namespace)

    def test_native_staging_accepts_current_inventory_and_never_deletes_it(self):
        spec = importlib.util.spec_from_file_location("stage_native", ROOT / "deploy/stage-native.py")
        stage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(stage)
        deployment = {"metadata": {}, "spec": {"selector": {}, "template": {"metadata": {}, "spec": {
            "volumes": [], "containers": [{"env": [], "volumeMounts": []}],
        }}}}
        for profiled, actors in ((False, []), (False, [{"metadata": {"name": "user-work", "uid": "current-user-uid"}}]),
                                (True, [{"metadata": {"name": "user-work", "uid": "current-user-uid"}}])):
            calls = []
            def run(*args, data=None):
                calls.append((args, data))
                if args[1:3] == ("get", "actors"):
                    return json.dumps({"actors": actors}).encode()
                if args[1:3] == ("get", "actor-template"):
                    return b'{"metadata":{},"containers":[{"image":"production-runtime"}]}'
                if "deployment" in args:
                    return json.dumps(deployment).encode()
                return b""
            with tempfile.TemporaryDirectory() as temporary, patch.object(stage, "ROOT", Path(temporary)), \
                    patch.object(stage, "digest", side_effect=["runtime@sha256:test", "panel@sha256:test"]), \
                    patch.object(stage, "ensure_session_claim") as sessions, \
                    patch.object(stage, "stage_worker_candidate", return_value=profiled) as candidate, \
                    patch.dict(stage.storage, {"ensure_sandbox_template": Mock(return_value="native-sandbox-v1")}), \
                    patch.object(stage, "run", side_effect=run), patch.object(stage.sp, "run", return_value=types.SimpleNamespace(returncode=1)):
                stage.main()
                self.assertEqual(len(calls), 4 if profiled else 8)
                candidate.assert_called_once()
                if profiled:
                    stage.storage["ensure_sandbox_template"].assert_not_called()
                sessions.assert_called_once_with("panel-native-candidate-sessions")
                self.assertTrue(all("delete" not in args for args, _ in calls))
                templates = [data for args, data in calls if args[1:3] == ("create", "actor-template")]
                self.assertEqual([t["metadata"]["name"] for t in templates], [] if profiled else ["native-codex", "native-pi"])
                self.assertEqual(json.loads((Path(temporary) / "evidence/native-staging-inventory.json").read_text()),
                                 [{"name": a["metadata"]["name"], "uid": a["metadata"]["uid"]} for a in actors])

    def test_existing_and_new_pool(self):
        source = ast.parse((ROOT / "deploy/deploy-agents.py").read_text())
        helper = next(node for node in source.body if isinstance(node, ast.FunctionDef) and node.name == "deploy_worker_pool")
        for exists in (False, True):
            with self.subTest(exists=exists):
                run = Mock()
                namespace = {"sp": types.SimpleNamespace(run=Mock(return_value=types.SimpleNamespace(returncode=0 if exists else 1))), "run": run}
                exec(compile(ast.Module(body=[helper], type_ignores=[]), "deploy_worker_pool", "exec"), namespace)
                result = namespace["deploy_worker_pool"]((ROOT / "deploy/agents.yaml").read_text())
                calls = run.call_args_list
                self.assertEqual(len(calls), 1 if exists else 2)
                if not exists:
                    self.assertEqual(calls[0].args[1], "create")
                    self.assertIn("replicas: 3", calls[0].kwargs["input"])
                apply = calls[-1]
                self.assertIn("--server-side", apply.args)
                self.assertIn("--field-manager=pvm-worker-config", apply.args)
                self.assertNotIn("replicas:", apply.kwargs["input"])
                self.assertNotIn("kind: WorkerPool", result)
                self.assertIn("kind: Deployment", result)
                self.assertIn("name: panel-worker-scaler", result)

    def test_candidate_does_not_inherit_chat_database_secret(self):
        deployment = {"metadata": {}, "spec": {"selector": {}, "template": {"metadata": {}, "spec": {
            "volumes": [{"name": name} for name in ("panel", "auth", "identity", "servicedns", "ate-token", "kubernetes", "console-database")],
            "containers": [{"env": [], "volumeMounts": [{"name": name, "mountPath": "/run/" + name} for name in ("panel", "auth", "identity", "servicedns", "ate-token", "kubernetes", "console-database")]}],
        }}}}
        staged = []
        class Applied(Exception):
            pass
        def apply(*args, **kwargs):
            if args[0] == ['kubectl', 'create', '-f', '-']:
                self.assertEqual(json.loads(kwargs['input'])['kind'], 'PersistentVolumeClaim')
                return
            self.assertEqual(args[0], ['kubectl', 'apply', '-f', '-'])
            staged.append(json.loads(kwargs['input']))
            raise Applied
        response = types.SimpleNamespace(headers={"Docker-Content-Digest": "sha256:candidate"})
        with patch("urllib.request.urlopen", return_value=contextlib.nullcontext(response)), \
                patch("subprocess.check_output", side_effect=lambda args, **kwargs: b'' if 'pvc' in args or 'configmap' in args else json.dumps(deployment).encode()), \
                patch("subprocess.run", side_effect=apply), self.assertRaises(Applied):
            runpy.run_path(str(ROOT / "deploy/stage-console.py"))
        spec = staged[0]["spec"]["template"]["spec"]
        required = {"panel", "auth", "identity", "servicedns", "ate-token", "kubernetes", "panel-sessions"}
        self.assertEqual({volume["name"] for volume in spec["volumes"]}, required)
        self.assertEqual({mount["name"] for mount in spec["containers"][0]["volumeMounts"]}, required)
        self.assertEqual(staged[0]["metadata"]["name"], "panel-console-candidate")


if __name__ == "__main__":
    unittest.main()

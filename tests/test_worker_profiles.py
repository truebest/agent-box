import copy
import json
import tempfile
import types
from unittest.mock import patch
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('worker_profiles', ROOT / 'deploy/worker-profiles.py')
profiles = importlib.util.module_from_spec(spec)
spec.loader.exec_module(profiles)


class WorkerProfiles(unittest.TestCase):
    def test_catalog_preserves_images_snapshots_and_isolates_candidate_placement(self):
        base = {'metadata': {'name': 'old', 'uid': 'original-template'},
                'containers': [{'name': 'app', 'image': 'runtime@sha256:old'}],
                'resources': {'limits': [{'name': 'cpu', 'quantity': '2'}, {'name': 'memory', 'quantity': '2Gi'}]},
                'workerSelector': {'matchLabels': {'workload': 'pvm-agents'}},
                'sandboxConfig': {'configName': 'gvisor-default', 'sandboxClass': 'gvisor'},
                'snapshotConfig': {'preferredFidelity': 'SNAPSHOT_FIDELITY_MEMORY', 'onSuspend': {'durable': True}}}
        before = copy.deepcopy(base)
        for candidate in (False, True):
            result = profiles.catalog(base, [base], 'host', 'localhost:5001/substrate/ateom-gvisor@sha256:' + 'a' * 64, 'candidate-test' if candidate else None)
            revision = result['profiles'][0]['revisions'][0]
            self.assertEqual(revision['template_spec']['containers'], base['containers'])
            self.assertEqual(revision['template_spec']['snapshotConfig'], base['snapshotConfig'])
            self.assertEqual(revision['template_spec']['resources'], base['resources'])
            self.assertEqual(revision['legacy'], not candidate)
            self.assertEqual(revision['memory_mib'], 4 * 2048 + 64)
            self.assertEqual(revision['reserved_memory_mib'], 64)
            self.assertEqual(revision['cpu_milli'], 4 * 2000)
            self.assertEqual(revision['reserved_cpu_milli'], 0)
            self.assertEqual('old' in result['bindings'], not candidate)
            self.assertNotIn('workload', revision['template_spec']['workerSelector']['matchLabels'])
            self.assertEqual(result['mode'], 'active' if candidate else 'quiescing')
        self.assertEqual(before, base)
        base['resources']['limits'][0]['quantity'] = '4'
        with self.assertRaises(ValueError):
            profiles.catalog(base, [], 'host', 'localhost:5001/substrate/ateom-gvisor@sha256:' + 'a' * 64)

    def test_inventory_identity_includes_the_uid(self):
        self.assertNotEqual(profiles.identity([{'metadata': {'name': 'same', 'uid': 'before'}}]),
                            profiles.identity([{'metadata': {'name': 'same', 'uid': 'after'}}]))

    def test_cutover_retry_keeps_the_initial_running_set(self):
        location = "s3://fixture/agent-box-host/"
        def actor(name, state):
            return {"metadata": {"name": name, "uid": name + "-uid"}, "status": {"state": "ACTOR_STATE_" + state,
                "lastAssignedGeneration": 1, "snapshots": [{"uuid": name + "-" + state, "generation": 1,
                    "fidelity": "SNAPSHOT_FIDELITY_MEMORY", "durableSnapshot": {"status": "SNAPSHOT_STORAGE_STATUS_COMPLETED", "object": {"snapshotUri": location + name}}}]}}
        state = {name: actor(name, "RUNNING") for name in ("one", "two")}
        failures, resumed = [True], []
        class API:
            def request(self, method, path, body=None):
                if path == "/api/worker-management":
                    return {"mode": "quiescing", "version": "1"}
                name = path.split("/")[3]
                if path.endswith("/suspend"):
                    if name == "two" and failures:
                        failures.pop()
                        raise RuntimeError("upload interrupted")
                    state[name] = actor(name, "SUSPENDED")
                else:
                    assert path.endswith("/resume?uid=" + name + "-uid")
                    resumed.append(name)
                    state[name] = actor(name, "RUNNING")
                return copy.deepcopy(state[name])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "deploy").mkdir()
            (root / "deploy/host-lifecycle.py").write_bytes((ROOT / "deploy/host-lifecycle.py").read_bytes())
            (root / "images.json").write_text(json.dumps({"snapshotStore": {"location": location}}))
            backup = root / "backup"
            backup.mkdir()
            (backup / "actors.json").write_text(json.dumps(list(state.values())))
            (backup / "workerpools.json").write_text(json.dumps({"items": [{"metadata": {"name": "agents", "uid": "pool-uid"}}]}))
            args = types.SimpleNamespace(backup=backup, url="https://test")
            with patch.object(profiles, "ROOT", root), patch.object(profiles, "Client", return_value=API()), \
                    patch.object(profiles, "actors", side_effect=lambda: copy.deepcopy(list(state.values()))), \
                    patch.object(profiles, "kubectl", return_value=b""):
                with self.assertRaisesRegex(RuntimeError, "upload interrupted"):
                    profiles.cutover(args)
                self.assertEqual(state["one"]["status"]["state"], "ACTOR_STATE_SUSPENDED")
                profiles.cutover(args)
            self.assertEqual(resumed, ["one", "two"])


    def test_candidate_staging_uses_isolated_catalogs_and_preserves_existing_versions(self):
        base = {"metadata": {"name": "base"}, "containers": [{"image": "production-runtime"}],
                "resources": {"limits": [{"name": "cpu", "quantity": "2"}, {"name": "memory", "quantity": "2Gi"}]},
                "workerSelector": {"matchLabels": {"workload": "pvm-agents"}},
                "sandboxConfig": {"configName": "gvisor-default", "sandboxClass": "gvisor"},
                "snapshotConfig": {"preferredFidelity": "SNAPSHOT_FIDELITY_MEMORY"}}
        production = profiles.catalog(base, [base], "host", "localhost:5001/substrate/ateom-gvisor@sha256:" + "a" * 64)
        saved = copy.deepcopy(production)
        existing, created = {}, []
        def kube(*args, body=None):
            if args[0] == "create":
                created.append(body)
                existing[body["metadata"]["name"]] = body
                return b""
            name = args[4]
            value = {"data": {"catalog.json": json.dumps(production)}} if name == "worker-profiles" else existing.get(name)
            return json.dumps(value).encode() if value else b""
        defaults = []
        for name in ("panel-native-candidate", "panel-console-candidate"):
            deployment = {"metadata": {"name": name}, "spec": {"template": {"spec": {"containers": [{"env": [{"name": "WORKER_CATALOG", "value": "worker-profiles"}]}]}}}}
            with patch.object(profiles, "kubectl", side_effect=kube):
                self.assertTrue(profiles.stage_candidate(deployment, "candidate-runtime"))
                self.assertTrue(profiles.stage_candidate(deployment, "candidate-runtime"))
            env = {v["name"]: v for v in deployment["spec"]["template"]["spec"]["containers"][0]["env"]}
            self.assertEqual(env["WORKER_CATALOG"]["value"], "worker-profiles-" + name)
            self.assertEqual(env["POD_UID"]["valueFrom"]["fieldRef"]["fieldPath"], "metadata.uid")
            value = json.loads(existing["worker-profiles-" + name]["data"]["catalog.json"])
            revision = value["profiles"][0]["revisions"][0]
            self.assertFalse(revision["legacy"])
            self.assertNotIn("workload", revision["template_spec"]["workerSelector"]["matchLabels"])
            self.assertNotIn("base", value["bindings"])
            self.assertEqual(revision["template_spec"]["containers"][0]["image"], "candidate-runtime")
            defaults.append(value["default_id"])
            with patch.object(profiles, "kubectl", side_effect=kube), self.assertRaisesRegex(RuntimeError, "Candidate catalog differs"):
                profiles.stage_candidate(deployment, "different-runtime")
        self.assertEqual(production, saved)
        self.assertEqual(len(set(defaults)), 2)
        self.assertEqual(len(created), 2)


if __name__ == '__main__':
    unittest.main()

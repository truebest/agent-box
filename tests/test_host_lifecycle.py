"""Shutdown must keep Docker alive until every sandbox has a durable checkpoint."""
import ast
from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import threading
import types
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("host_lifecycle", ROOT / "deploy/host-lifecycle.py")
lifecycle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lifecycle)
lifecycle.load = lambda: {"panel_origin": "https://192.0.2.10:8443", "kube_context": "kind-configured"}
LOCATION = "s3://fixture-bucket/agent-box-host/"


def actor(name, state="SUSPENDED", snapshot="old"):
    value = {"metadata": {"name": name, "uid": name + "-uid"},
             "status": {"state": "ACTOR_STATE_" + state}}
    if snapshot:
        value["status"].update(lastAssignedGeneration=1, snapshots=[{
            "uuid": snapshot, "generation": 1, "fidelity": "SNAPSHOT_FIDELITY_MEMORY",
            "durableSnapshot": {"status": "SNAPSHOT_STORAGE_STATUS_COMPLETED",
                               "object": {"snapshotUri": LOCATION + name + "/" + snapshot}}}])
    return value


class Pool:
    def __init__(self, values):
        self.values = {item["metadata"]["name"]: deepcopy(item) for item in values}
        self.calls = []
        self.lock = threading.Lock()

    def request(self, method, path):
        with self.lock:
            self.calls.append((method, path))
            if method == "GET":
                return {"actors": deepcopy(list(self.values.values()))}
            name = path.split("/")[3]
            if path != "/api/agents/" + name + "/suspend":
                raise AssertionError("Shutdown attempted a mutation other than Suspend")
            self.values[name] = actor(name, snapshot="fresh")
            return deepcopy(self.values[name])


class HostLifecycleTests(unittest.TestCase):
    def test_forward_pins_the_configured_context(self):
        process = Mock()
        with patch.object(lifecycle.subprocess, "Popen", return_value=process) as start:
            with lifecycle.forward_panel():
                pass
        self.assertEqual(start.call_args.args[0][:3], ["kubectl", "--context", "kind-configured"])
        process.terminate.assert_called_once_with()

    def test_empty_protobuf_inventory_omits_the_actors_field(self):
        api = Mock(return_value={})
        self.assertEqual(lifecycle.drain_once(api, LOCATION), [])
        self.assertEqual(api.call_count, 2)
        self.assertTrue(all(call.args == ("GET", "/api/agents") for call in api.call_args_list))

    def test_saves_running_and_finishes_in_progress_without_waking_suspended(self):
        pending = actor("pending", "SUSPENDING", "fresh")
        pending["status"]["snapshots"][0]["durableSnapshot"]["status"] = "SNAPSHOT_STORAGE_STATUS_PENDING"
        pool = Pool([actor("running", "RUNNING"), pending, actor("saved"), actor("empty", snapshot=None)])
        records = lifecycle.drain_once(pool.request, LOCATION)
        self.assertEqual({r["name"] for r in records}, {"running", "pending", "saved", "empty"})
        self.assertEqual({path for method, path in pool.calls if method == "POST"},
                         {"/api/agents/running/suspend", "/api/agents/pending/suspend"})
        self.assertEqual({r["snapshot"] for r in records}, {"fresh", "old", None})

    def test_boot_does_not_resume_anything(self):
        pool = Pool([actor("one"), actor("two")])
        first = lifecycle.drain_once(pool.request, LOCATION)
        self.assertEqual(first, lifecycle.drain_once(pool.request, LOCATION))
        self.assertTrue(all(method == "GET" for method, _ in pool.calls))

    def test_saves_healthy_sandboxes_even_when_another_needs_recovery(self):
        pool = Pool([actor("broken", "CRASHED"), actor("running", "RUNNING")])
        with self.assertRaises(lifecycle.RecoveryRequired):
            lifecycle.drain_once(pool.request, LOCATION)
        self.assertEqual(pool.values["running"]["status"]["state"], "ACTOR_STATE_SUSPENDED")

    def test_unsafe_snapshot_or_crash_cannot_finish_shutdown(self):
        cases = []
        crashed = actor("broken", "CRASHED")
        cases.append(crashed)
        for change in ["pending", "filesystem", "wrong-store", "missing", "assigned"]:
            value = actor(change)
            if change == "pending":
                value["status"]["snapshots"][0]["durableSnapshot"]["status"] = "SNAPSHOT_STORAGE_STATUS_PENDING"
            elif change == "filesystem":
                value["status"]["snapshots"][0]["fidelity"] = "SNAPSHOT_FIDELITY_FILESYSTEM"
            elif change == "wrong-store":
                value["status"]["snapshots"][0]["durableSnapshot"]["object"]["snapshotUri"] = "s3://other/old"
            elif change == "missing":
                value["status"]["snapshots"] = []
            else:
                value["status"]["workerAssignment"] = {"worker": {"name": "worker-one"}}
            cases.append(value)
        for value in cases:
            with self.subTest(value=value["metadata"]["name"]):
                with self.assertRaises(lifecycle.RecoveryRequired):
                    lifecycle.drain_once(Pool([value]).request, LOCATION)

    def test_transitions_wait_and_failed_save_cannot_report_success(self):
        self.assertIsNone(lifecycle.drain_once(Pool([actor("starting", "RESUMING")]).request, LOCATION))
        before = actor("running", "RUNNING")
        for reply in [actor("running"), actor("replacement", snapshot="fresh")]:
            with self.assertRaises(lifecycle.RecoveryRequired):
                lifecycle.suspend(before, lambda *_: reply, LOCATION)
        with self.assertRaisesRegex(RuntimeError, "snapshot upload failed"):
            lifecycle.suspend(before, Mock(side_effect=RuntimeError("snapshot upload failed")), LOCATION)

    def test_private_connection_keeps_tls_name_and_credentials_out_of_arguments(self):
        with patch.object(lifecycle, "Client", return_value=types.SimpleNamespace(authorization="Basic PRIVATE")), \
                patch.object(lifecycle.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout='{"actors":[]}')) as run:
            self.assertEqual(lifecycle.request("GET", "/api/agents"), {"actors": []})
        command = run.call_args.args[0]
        self.assertIn("--cacert", command)
        self.assertIn("192.0.2.10:8443:127.0.0.1:19443", command)
        self.assertIn("--disable", command)
        self.assertIn("--noproxy", command)
        self.assertNotIn("--insecure", command)
        self.assertNotIn("PRIVATE", " ".join(command))
        self.assertIn("Authorization: Basic PRIVATE", run.call_args.kwargs["input"])

    def test_pilot_private_identity_preserves_tls_verification(self):
        with patch.object(lifecycle, "Client", return_value=types.SimpleNamespace(authorization="Basic PRIVATE")), \
                patch.object(lifecycle.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout='{}')) as run:
            lifecycle.request("GET", "/api/worker-management", port=19444, identity="devin-pilot")
        command = run.call_args.args[0]
        self.assertIn("panel-devin-pilot.pvm-agents.svc:8443:127.0.0.1:19444", command)
        self.assertTrue(any("devin-agent-box-pilot/ca.crt" in value for value in command))
        self.assertNotIn("--insecure", command)
        self.assertNotIn("PRIVATE", " ".join(command))
        with self.assertRaises(lifecycle.RecoveryRequired):
            lifecycle.request("GET", "/api/worker-management", identity="unrecognized")

    def test_only_persistent_candidate_is_reactivated_after_boot(self):
        catalogs = {"items": [{"metadata": {"name": name, "annotations": annotations},
                              "data": {"catalog.json": json.dumps({"mode": "quiescing", "owner_pod": name, "owner_uid": name+"-uid"})}}
                     for name, annotations in (("pilot", {"agent-box/persistent":"true", "agent-box/lifecycle-identity":"devin-pilot"}),
                                               ("ordinary-candidate", {}))]}
        def lookup(command):
            if "configmaps" in command: return json.dumps(catalogs).encode()
            self.assertIn("pilot", command)
            return b'{"metadata":{"uid":"pilot-uid"},"status":{"phase":"Running"}}'
        with patch.object(lifecycle.subprocess, "check_output", side_effect=lookup), \
                patch.object(lifecycle, "forward_panel") as forward, \
                patch.object(lifecycle, "request", side_effect=[{"mode":"quiescing","version":"19"}, {}]) as request:
            lifecycle.candidate_management("active", persistent_only=True)
        forward.assert_called_once_with("pod/pilot", lifecycle.PRIVATE_PORT+1)
        self.assertEqual(request.call_args.args, ("PUT", "/api/worker-management", {"mode":"active","version":"19"}))
        self.assertEqual(request.call_args.kwargs, {"port":lifecycle.PRIVATE_PORT+1,"identity":"devin-pilot"})

    def test_configuration_errors_are_retried_during_stop(self):
        class EndTest(BaseException):
            pass
        with patch.object(lifecycle.Path, "read_text", side_effect=ValueError("invalid configuration")), \
                patch.object(lifecycle.time, "sleep", side_effect=EndTest) as sleep:
            with self.assertRaises(EndTest):
                lifecycle.main("stop")
            sleep.assert_called_once_with(5)

    def test_boot_refreshes_worker_pods_only_after_the_pool_is_saved(self):
        records = [{"uid": "saved-uid", "snapshot": "complete"}]
        for mode in ("boot", "stop"):
            with self.subTest(mode=mode), \
                    patch.object(lifecycle.Path, "read_text", return_value=json.dumps({"snapshotStore": {"location": LOCATION}})), \
                    patch.object(lifecycle, "forward_panel") as forward, \
                    patch.object(lifecycle, "drain_once", side_effect=[None, records, records]) as drain, \
                    patch.object(lifecycle, "management_mode"), \
                    patch.object(lifecycle, "refresh_worker_pods") as run, \
                    patch.object(lifecycle.time, "sleep"), patch.object(lifecycle.os, "sync"):
                forward.return_value.__enter__.return_value.poll.return_value = None
                run.side_effect = lambda *_args, **_kwargs: self.assertEqual(drain.call_count, 3)
                lifecycle.main(mode)
                self.assertEqual(run.call_count, 1 if mode == "boot" else 0)

    def test_management_mode_is_optional_only_without_a_catalog(self):
        with patch.object(lifecycle.subprocess, "check_output", return_value=b""), patch.object(lifecycle, "request") as request:
            lifecycle.management_mode("quiescing")
            request.assert_not_called()
        with patch.object(lifecycle.subprocess, "check_output", return_value=b"configmap/worker-profiles"), \
                patch.object(lifecycle, "quiesce_candidates") as candidates, \
                patch.object(lifecycle, "request", side_effect=[{"mode": "active", "version": "17"}, {}]) as request:
            lifecycle.management_mode("quiescing")
            candidates.assert_called_once()
            self.assertEqual(request.call_args.args, ("PUT", "/api/worker-management", {"mode": "quiescing", "version": "17"}))

    def test_boot_refreshes_every_managed_pool_and_ignores_other_deployments(self):
        pools = {"items": [{"metadata": {"name": name, "labels": labels}, "spec": {"replicas": replicas}}
                          for name, labels, replicas in (("agents", {}, 4), ("wp-one", {"agent-box/managed": "true"}, 1),
                                                       ("wp-two", {"agent-box/managed": "true"}, 1), ("other", {}, 1),
                                                       ("zero", {"agent-box/managed": "true"}, 0))]}
        with patch.object(lifecycle.subprocess, "check_output", return_value=json.dumps(pools).encode()), \
                patch.object(lifecycle.subprocess, "run") as run:
            lifecycle.refresh_worker_pods()
        self.assertEqual(run.call_count, 6)
        self.assertEqual({argument for call in run.call_args_list for argument in call.args[0] if argument.startswith("deployment/")}, {"deployment/agents", "deployment/wp-one", "deployment/wp-two"})

    def test_candidates_use_api_barriers_or_cas_for_stopped_owners(self):
        catalogs = {"items": [{"metadata": {"name": name, "resourceVersion": "17"},
                               "data": {"catalog.json": json.dumps({"mode": "active", "owner_pod": name, "owner_uid": name + "-uid"})}}
                              for name in ("worker-profiles", "live", "stopped")]}
        def lookup(command):
            if "configmaps" in command:
                return json.dumps(catalogs).encode()
            self.assertIn("--ignore-not-found", command)
            if "live" in command:
                return b'{"metadata":{"uid":"live-uid"},"status":{"phase":"Running"}}'
            return b""
        with patch.object(lifecycle.subprocess, "check_output", side_effect=lookup), \
                patch.object(lifecycle.subprocess, "run") as replace, \
                patch.object(lifecycle, "forward_panel") as forward, \
                patch.object(lifecycle, "request", side_effect=[RuntimeError("forward starting"), {"mode": "active", "version": "20"}, {}]) as request, \
                patch.object(lifecycle.time, "sleep"):
            forward.return_value.__enter__.return_value.poll.return_value = None
            lifecycle.quiesce_candidates()
        forward.assert_called_once_with("pod/live", lifecycle.PRIVATE_PORT + 1)
        self.assertEqual(request.call_args.args, ("PUT", "/api/worker-management", {"mode": "quiescing", "version": "20"}))
        self.assertEqual(request.call_args.kwargs, {"port": lifecycle.PRIVATE_PORT + 1})
        saved = json.loads(replace.call_args.kwargs["input"])
        self.assertEqual(saved["metadata"], {"name": "stopped", "resourceVersion": "17"})
        self.assertEqual(json.loads(saved["data"]["catalog.json"])["mode"], "quiescing")
        with patch.object(lifecycle.subprocess, "check_output", side_effect=lookup), \
                patch.object(lifecycle, "forward_panel"), \
                patch.object(lifecycle, "request", side_effect=[{"mode": "active", "version": "20"}, RuntimeError("barrier failed")]):
            with self.assertRaisesRegex(RuntimeError, "barrier failed"):
                lifecycle.quiesce_candidates()

    def test_unit_orders_public_access_storage_and_docker_around_the_guard(self):
        tree = ast.parse((ROOT / "deploy/host-services.py").read_text())
        namespace = {}
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "service_units")
        exec(compile(ast.Module(body=[function], type_ignores=[]), "host-services.py", "exec"), namespace)
        units = namespace["service_units"]({"kube_context": "kind-configured", "user": "ubuntu", "home": "/home/ubuntu", "repository": "/opt/agent-box", "config_path": "/opt/agent-box/deploy/install.local.json", "listen_address": "127.0.0.1", "listen_port": 9443})
        self.assertIn("--address=127.0.0.1 svc/panel 9443:8443", units["substrate-panel.service"])
        self.assertIn("--context=kind-configured", units["substrate-panel.service"])
        self.assertIn("User=ubuntu", units["substrate-lifecycle.service"])
        guard, panel = units["substrate-lifecycle.service"], units["substrate-panel.service"]
        self.assertIn("TimeoutStopSec=infinity", guard)
        self.assertIn("RemainAfterExit=yes", guard)
        self.assertIn("After=network.target network-online.target docker.service substrate-ate-mount.service", guard)
        self.assertIn("Before=substrate-panel.service", guard)
        self.assertIn("host-lifecycle.py boot", guard)
        self.assertIn("host-lifecycle.py stop", guard)
        self.assertIn("Requires=docker.service substrate-lifecycle.service", panel)
        self.assertIn("After=docker.service substrate-ate-mount.service substrate-lifecycle.service", panel)

    def test_kind_restart_reapplies_proxy_settings_in_the_mount_service(self):
        tree = ast.parse((ROOT / "deploy/prepare-host.py").read_text())
        namespace = {}
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "mount_script")
        exec(compile(ast.Module(body=[function], type_ignores=[]), "prepare-host.py", "exec"), namespace)
        script = namespace["mount_script"]({"workspace_mount": "/srv/workspace", "volume_group": "workspaces", "workspace_volume": "substrate-ate", "kind_node": "test-control-plane"})
        startup = script.split("while test", 1)[0]
        self.assertIn('docker exec test-control-plane sysctl net.ipv4.conf.all.proxy_arp=1', startup)
        self.assertIn('docker exec test-control-plane sysctl -e net.ipv6.conf.all.proxy_ndp=1', startup)


if __name__ == "__main__":
    unittest.main()

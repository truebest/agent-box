import importlib.util
import os
from pathlib import Path
import tempfile
import sys
import tracemalloc
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("helper", Path(__file__).parents[1] / "runtime/helper.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class Paths(unittest.TestCase):
    def test_workspace_and_symlink_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            helper.WORKSPACE = Path(directory)
            (helper.WORKSPACE / "project").mkdir()
            (helper.WORKSPACE / "escape").symlink_to("/tmp", target_is_directory=True)
            (helper.WORKSPACE / "inside").symlink_to("project", target_is_directory=True)
            with helper.directory_fd("/workspace/project") as fd:
                self.assertTrue(os.path.isdir(f"/proc/self/fd/{fd}"))
            for path in ("/etc", "/workspace/../tmp", "/workspace/project/../../tmp", "/workspace/escape/test", "/workspace/inside/test"):
                with self.assertRaises((ValueError, OSError), msg=path):
                    with helper.parent_fd(path):
                        pass

    def test_symlinks_rejected_even_if_runtime_ignores_nofollow(self):
        with tempfile.TemporaryDirectory() as directory:
            helper.WORKSPACE = Path(directory)
            (helper.WORKSPACE / "escape").symlink_to("/tmp", target_is_directory=True)
            original = os.open
            def broken_open(path, flags, *args, **kwargs):
                return original(path, flags & ~os.O_NOFOLLOW, *args, **kwargs)
            with patch.object(helper.os, "open", broken_open):
                with self.assertRaises(ValueError):
                    with helper.parent_fd("/workspace/escape/file"):
                        pass

    def test_inode_change_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "original").mkdir()
            (root / "different").mkdir()
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            original = os.open
            def swapped_open(path, flags, *args, **kwargs):
                return original("different", flags, *args, **kwargs)
            try:
                with patch.object(helper.os, "open", swapped_open):
                    with self.assertRaises(ValueError):
                        helper.open_checked(fd, "original", os.O_RDONLY | os.O_DIRECTORY)
            finally:
                os.close(fd)


class Sessions(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.home = patch.object(helper.Path, 'home', return_value=self.root)
        self.home.start()
        self.workspace = patch.object(helper, 'WORKSPACE', self.root)
        self.workspace.start()
        for name in ('.codex', '.pi/agent'):
            (self.root / name).mkdir(parents=True)

    def tearDown(self):
        self.workspace.stop()
        self.home.stop()
        self.temporary.cleanup()

    def test_cold_restore_changes_permissions_as_workspace_owner(self):
        import ast
        from unittest.mock import Mock
        main = next(node for node in ast.parse(Path(helper.__file__).read_text()).body if isinstance(node, ast.FunctionDef) and node.name == "main")
        bootstrap = next(node for node in main.body if isinstance(node, ast.If))
        identity = {"uid": 0}
        system = Mock()
        system.geteuid.return_value = 0
        system.setuid.side_effect = lambda uid: identity.update(uid=uid)
        def chmod(path, mode):
            if path == helper.WORKSPACE and identity["uid"] != 1000:
                raise PermissionError("Restored workspace is owned by UID 1000")
        system.chmod.side_effect = chmod
        libc = Mock()
        libc.CDLL.return_value.prctl.return_value = 0
        exec(compile(ast.Module(body=[bootstrap], type_ignores=[]), "bootstrap", "exec"), {"os": system, "ctypes": libc, "WORKSPACE": helper.WORKSPACE})
        self.assertEqual(identity["uid"], 1000)
        system.chmod.assert_any_call(helper.WORKSPACE, 0o700)

    def test_atomic_native_access_only_auth(self):
        import base64
        import json
        import stat
        import time
        token = 'e30.' + base64.urlsafe_b64encode(json.dumps({'exp': int(time.time()) + 3600}).encode()).decode().rstrip('=') + '.sig'
        auth = {'tokens': {'access_token': token, 'account_id': 'account', 'refresh_token': ''}, 'extra': 'discard'}
        helper.write_auth(auth)
        for relative in ('.codex/auth.json', '.pi/agent/auth.json'):
            target = self.root / relative
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertNotIn('discard', target.read_text())
        pi = json.loads((self.root / '.pi/agent/auth.json').read_text())['openai-codex']
        self.assertEqual(pi['access'], token)
        self.assertEqual(pi['refresh'], '')
        auth['tokens']['refresh_token'] = 'never-deliver'
        with self.assertRaises(ValueError):
            helper.write_auth(auth)
        self.assertNotIn('never-deliver', (self.root / '.codex/auth.json').read_text())

    def test_existing_session_is_not_started_again(self):
        import json
        saved = {"kind": "pi", "model": "gpt-6.1-sol", "cwd": "/workspace", "pane_id": "w1:p1"}
        (self.root / "session.json").write_text(json.dumps(saved))
        with patch.object(helper, "session_status", return_value={**saved, "ready": True}), patch.object(helper, "herdr") as herdr:
            self.assertTrue(helper.initialize_session({"kind": "pi"})["ready"])
            herdr.assert_not_called()
            with self.assertRaisesRegex(helper.SessionError, "already exists"):
                helper.initialize_session({"kind": "pi", "model": "different"})
            self.assertTrue(helper.submit_prompt({"prompt": "$(literal)"})["accepted"])
            herdr.assert_called_once_with("agent", "prompt", "w1:p1", "$(literal)")

    def test_empty_session_never_starts_an_agent_or_workspace(self):
        import json
        with patch.object(helper, 'session_status', return_value={'kind': 'none', 'server': True, 'ready': False}), patch.object(helper, 'herdr') as herdr:
            self.assertFalse(helper.initialize_session({'kind': 'none'})['ready'])
            self.assertEqual(json.loads((self.root / 'session.json').read_text()), {'kind': 'none'})
            helper.initialize_session({'kind': 'none'})
            with self.assertRaisesRegex(helper.SessionError, 'No primary agent'):
                helper.submit_prompt({'prompt': 'hello'})
            herdr.assert_not_called()

    def test_new_directory_is_created_without_following_symlinks(self):
        helper.create_directory('/workspace/new/project')
        self.assertTrue((self.root / 'new/project').is_dir())
        (self.root / 'escape').symlink_to('/tmp', target_is_directory=True)
        for path in ('/etc/new', '/workspace/../tmp', '/workspace/escape/new'):
            with self.assertRaises((ValueError, OSError)):
                helper.create_directory(path)

    def test_empty_idle_runtime_is_quiet_but_unknown_processes_are_not(self):
        with patch.object(helper, 'herdr', return_value={'panes': []}), patch.object(helper, 'process_table', return_value={}):
            self.assertTrue(helper.idle_state()['quiet'])
        with patch.object(helper, 'herdr', return_value={'panes': []}), patch.object(helper, 'process_table', return_value={(123, 99): b'sleep\x00100\x00'}):
            self.assertFalse(helper.idle_state()['quiet'])

    def test_devin_first_login_does_not_require_chatgpt_credentials(self):
        state = {"kind": "devin", "started": True, "ready": False, "error": "Complete Devin CLI sign-in"}
        with patch.object(helper, "session_status", return_value=state), \
                patch.object(helper, "process_table", return_value={}), \
                patch.object(helper, "herdr", side_effect=[{"workspaces": []}, {"root_pane": {"pane_id": "w1:p1"}}, {}]) as herdr:
            self.assertTrue(helper.initialize_session({"kind": "devin"})["started"])
            args = herdr.call_args.args
            self.assertIn("devin", args)
            self.assertNotIn("--model", args)
            self.assertNotIn("--provider", args)
            self.assertNotIn("--sandbox", args)
        with patch.object(helper, "session_status", return_value=state), patch.object(helper, "herdr") as herdr:
            self.assertTrue(helper.initialize_session({"kind": "devin"})["started"])
            herdr.assert_not_called()
            with self.assertRaisesRegex(helper.SessionError, "Complete Devin CLI sign-in"):
                helper.submit_prompt({"prompt": "Do not send to the login menu"})
            herdr.assert_not_called()

    def test_devin_blocked_launch_is_retained_without_restarting(self):
        state = {"kind": "devin", "started": True, "ready": False, "error": "Complete Devin CLI setup"}
        with patch.object(helper, "session_status", return_value=state), \
                patch.object(helper, "process_table", return_value={}), \
                patch.object(helper, "herdr", side_effect=[{"workspaces": []}, {"root_pane": {"pane_id": "w1:p1"}}, helper.SessionError("Herdr agent_not_ready")]) as herdr:
            self.assertTrue(helper.initialize_session({"kind": "devin"})["started"])
            self.assertEqual(herdr.call_count, 3)
        pane = {"pane_id": "w1:p1", "agent": "devin", "agent_status": "blocked", "launch_pending": True}
        with patch.object(helper, "herdr", side_effect=[{"panes": [pane]}, {"agents": [pane]}]):
            actual = helper.session_status()
            self.assertTrue(actual["started"])
            self.assertFalse(actual["ready"])
            self.assertIn("setup", actual["error"])
        with patch.object(helper, "session_status", return_value=actual), patch.object(helper, "herdr") as herdr:
            self.assertTrue(helper.initialize_session({"kind": "devin"})["started"])
            herdr.assert_not_called()
            with self.assertRaises(helper.SessionError):
                helper.submit_prompt({"prompt": "never send into workspace trust"})
            herdr.assert_not_called()

    def test_pi_initialization_uses_native_continue(self):
        from types import SimpleNamespace
        (self.root / ".codex/auth.json").write_text("{}")
        with patch.object(helper, "session_status", return_value={"ready": True}), \
                patch.object(helper, "process_table", return_value={}), \
                patch.object(helper.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="openai-codex gpt-6.1-sol")), \
                patch.object(helper, "herdr", side_effect=[{"workspaces": []}, {"root_pane": {"pane_id": "w1:p1"}}, {}]) as herdr:
            helper.initialize_session({"kind": "pi"})
            self.assertIn("--continue", herdr.call_args.args)
            self.assertIn("pi", herdr.call_args.args)

    def test_suspend_gate_blocks_input_without_replaying_it(self):
        with patch.object(helper, "frozen", True), patch.object(helper, "herdr") as herdr:
            with self.assertRaisesRegex(helper.SessionError, "being suspended"):
                helper.initialize_session({"kind": "pi"})
            with self.assertRaisesRegex(helper.SessionError, "being suspended"):
                helper.submit_prompt({"prompt": "hello"})
            herdr.assert_not_called()

    def test_idle_rejects_working_blocked_shell_and_background_processes(self):
        pane = {"pane_id": "w1:p1", "agent": "pi", "agent_status": "idle"}
        baseline = {(1, "10"): b"runtime\0"}
        with patch.object(helper, "process_baseline", baseline), patch.object(helper, "process_table", return_value=baseline), \
                patch.object(helper, "herdr", return_value={"panes": [pane]}):
            self.assertTrue(helper.idle_state()["quiet"])
            with patch.dict(pane, {"agent": "devin"}):
                self.assertTrue(helper.idle_state()["quiet"])
            for change in ({"agent_status": "working"}, {"agent_status": "blocked"}, {"agent": None}, {"background_tasks": 1}, {"launch_pending": True}):
                with patch.dict(pane, change):
                    self.assertFalse(helper.idle_state()["quiet"])
            with patch.object(helper, "process_table", return_value={**baseline, (2, "20"): b"sleep\0"}):
                self.assertFalse(helper.idle_state()["quiet"])

    def test_idle_exposes_control_locks_for_process_ownership_checks(self):
        with patch.object(helper, "herdr", return_value={"panes": []}), patch.object(helper, "process_table", return_value={}):
            for lock in (helper.task_lock, helper.session_lock):
                with lock:
                    state = helper.idle_state()
                    self.assertTrue(state["control_busy"])
                    self.assertFalse(state["quiet"])
            self.assertFalse(helper.idle_state()["control_busy"])

    def test_uncertain_delivery_is_an_error(self):
        import subprocess
        with patch.object(helper.subprocess, 'run', side_effect=subprocess.TimeoutExpired('herdr', 15)) as run:
            with self.assertRaisesRegex(helper.SessionError, 'uncertain'):
                helper.herdr('agent', 'prompt', 'w1:p1', 'hello')
            self.assertEqual(run.call_count, 1)

    def test_control_post_drains_body_before_reusing_connection(self):
        import http.client
        import json
        import threading
        server = helper.ThreadingHTTPServer(("127.0.0.1", 0), helper.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        connection = http.client.HTTPConnection(*server.server_address)
        try:
            with patch.object(helper, "idle_state", return_value={"quiet": False, "signature": "test"}):
                connection.request("POST", "/runtime/thaw", body="{}", headers={"Content-Type": "application/json"})
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertFalse(response.will_close)
                response.read()
                connection.request("GET", "/runtime/idle")
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.load(response), {"quiet": False, "signature": "test"})
        finally:
            connection.close()
            server.shutdown()
            server.server_close()
            thread.join(3)

    def test_incomplete_upload_preserves_destination_and_closes_connection(self):
        import socket
        import http.client
        import threading
        target = self.root / 'saved.txt'
        target.write_bytes(b'original')
        server = helper.ThreadingHTTPServer(("127.0.0.1", 0), helper.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with socket.create_connection(server.server_address, timeout=3) as connection:
                connection.sendall(b'PUT /files?path=/workspace/saved.txt HTTP/1.1\r\nHost: test\r\nContent-Length: 100\r\n\r\npartial')
                connection.shutdown(socket.SHUT_WR)
                response = http.client.HTTPResponse(connection)
                response.begin()
                self.assertEqual(response.status, 400)
                self.assertTrue(response.will_close)
                response.read()
            self.assertEqual(target.read_bytes(), b'original')
            self.assertEqual(list(self.root.glob('.upload-*')), [])
            for body in (b'complete', b''):
                connection = http.client.HTTPConnection(*server.server_address, timeout=3)
                try:
                    connection.request('PUT', '/files?path=/workspace/saved.txt', body=body)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    response.read()
                    self.assertEqual(target.read_bytes(), body)
                finally:
                    connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(3)

    def test_command_retains_output_tail_with_bounded_memory(self):
        (self.root / 'marker').write_bytes(b'cwd-ok')
        script = "import os,sys; [os.write(1, b'x'*65536) for _ in range(1024)]; os.write(2, open('marker','rb').read()); sys.exit(7)"
        with helper.directory_fd('/workspace') as fd:
            tracemalloc.start()
            try:
                result = helper.run_command([sys.executable, '-c', script], fd, 10)
                _, peak = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()
        self.assertEqual(result.returncode, 7)
        self.assertEqual(len(result.stdout), 1048576)
        self.assertTrue(result.stdout.endswith(b'cwd-ok'))
        self.assertLess(peak, 4 * 1048576)

    def test_command_timeout_cleans_up_descendants_holding_stdout(self):
        import subprocess
        import time
        script = "import os,time; child=os.fork(); time.sleep(60) if child == 0 else None"
        started = time.monotonic()
        with helper.directory_fd('/workspace') as fd:
            with self.assertRaises(subprocess.TimeoutExpired):
                helper.run_command([sys.executable, '-c', script], fd, 0.2)
        self.assertLess(time.monotonic() - started, 3)


if __name__ == "__main__":
    unittest.main()

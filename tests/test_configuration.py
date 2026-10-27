import importlib.util
import json
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deploy"))
spec = importlib.util.spec_from_file_location("installation_config", ROOT / "deploy/configuration.py")
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class InstallationSettings(unittest.TestCase):
    def load(self, **changes):
        value = {"repository": str(ROOT), "hostname": "test-host", "user": "ubuntu", "home": "/home/ubuntu", "panel_origin": "https://panel.example.com:9443"} | changes
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "install.json"
            path.write_text(json.dumps(value))
            return config.load(path)

    def test_defaults_and_custom_installation(self):
        cfg = self.load()
        self.assertEqual((cfg["registry_driver"], cfg["worker_replicas"], cfg["panel_port"]), ("local", 1, 9443))
        cfg = self.load(kind_cluster="test", registry_port=5100, panel_origin="https://127.0.0.1:8443/", workspace_mount="/srv/test")
        self.assertEqual((cfg["kind_node"], cfg["kube_context"], cfg["registry_address"]), ("test-control-plane", "kind-test", "localhost:5100"))
        self.assertEqual(cfg["panel_origin"], "https://127.0.0.1:8443")
        self.assertEqual(cfg["repository"], str(ROOT))

    def test_rejects_unsafe_paths_names_and_origins(self):
        cases = [dict(workspace_mount=value) for value in ("/", "/dev/data", "/var", "/home/ubuntu", str(ROOT), "/srv/../etc", "/srv/a b")]
        cases += [dict(panel_origin=value) for value in ("http://panel.example.com", "https://user:pass@panel.example.com", "https://panel.example.com/path", "https://panel.example.com?x=1", "https://panel.example.com:70000", "https://panel.example.com:0")]
        cases += [{"registry_port": True}, {"worker_cpu": 0}, {"worker_cpu": 1}, {"worker_memory": "2Gi"}, {"worker_memory": "unlimited"}, {"kind_cluster": "test;whoami"}, {"unknown": 1}]
        for values in cases:
            with self.subTest(values=values), self.assertRaises(ValueError):
                self.load(**values)

    def test_refuses_a_different_kubernetes_context(self):
        cfg = self.load()
        with patch("subprocess.check_output", return_value="kind-another\n"), self.assertRaises(RuntimeError):
            config.require_context(cfg)
        with patch("subprocess.check_output", return_value=cfg["kube_context"] + "\n"):
            config.require_context(cfg)

    def test_example_is_valid_and_local_file_is_ignored(self):
        cfg = config.load(ROOT / "deploy/install.example.json")
        self.assertEqual(cfg["panel_hostname"], "panel.example.com")
        for name in (".gitignore", ".dockerignore"):
            self.assertIn("/deploy/install.local.json", (ROOT / name).read_text().splitlines())

    def test_registry_creation_uses_container_lookup_when_volume_has_same_name(self):
        import runpy
        import types
        cfg = self.load()
        def run(command, **kwargs):
            if command[:3] == ['docker', 'volume', 'inspect']:
                return types.SimpleNamespace(returncode=0, stdout=b'[{"Driver":"local"}]')
            if command[:3] == ['docker', 'container', 'inspect']:
                return types.SimpleNamespace(returncode=1)
            return types.SimpleNamespace(returncode=0)
        with patch('configuration.load', return_value=cfg), patch('configuration.require_context'), \
                patch('subprocess.check_output', side_effect=['namespace', 'secret/substrate-storage', '[{"IPAM":{"Config":[{"Gateway":"fc00::1"},{"Gateway":"172.18.0.1"}]}}]']), \
                patch('subprocess.run', side_effect=run) as command:
            runpy.run_path(str(ROOT / 'deploy/prepare-cluster.py'))
        self.assertTrue(any(call.args[0][:3] == ('docker', 'run', '-d') for call in command.call_args_list))
        manifest = next(json.loads(call.kwargs['input']) for call in command.call_args_list if call.kwargs.get('input', '').startswith('{'))
        self.assertEqual(manifest['items'][1]['endpoints'][0]['addresses'], ['172.18.0.1'])
        self.assertEqual(manifest['items'][1]['ports'][0]['port'], cfg['registry_port'])

    def test_origin_and_local_listener_use_independent_ports(self):
        cfg = self.load(panel_origin="https://panel.example.com", listen_port=9443)
        self.assertEqual((cfg["panel_port"], cfg["listen_port"]), (443, 9443))
        with self.assertRaises(ValueError):
            self.load(listen_port=443)

    def test_substrate_bootstrap_assigns_the_configured_class_to_rustfs(self):
        import runpy
        cfg = self.load(storage_class="custom-storage")
        with patch('configuration.load', return_value=cfg), patch('configuration.require_context'), \
                patch('configuration.require_user'), patch('subprocess.check_output', return_value=b''), \
                patch('subprocess.run') as command:
            runpy.run_path(str(ROOT / 'deploy/install-substrate.py'))
        claim = json.loads(command.call_args_list[0].kwargs['input'])
        self.assertEqual(claim['spec']['storageClassName'], 'custom-storage')
        self.assertIn('custom-storage', command.call_args.args[0])
        with patch('configuration.load', return_value=cfg), patch('configuration.require_context'), \
                patch('configuration.require_user'), patch('subprocess.check_output', return_value=b'{"spec":{"storageClassName":"other"}}'), \
                patch('subprocess.run') as command, self.assertRaises(RuntimeError):
            runpy.run_path(str(ROOT / 'deploy/install-substrate.py'))
        command.assert_not_called()

    def test_bootstrap_auth_secret_keeps_the_refresh_field_manager(self):
        import ast
        import base64
        from unittest.mock import Mock
        tree = ast.parse((ROOT / 'deploy/deploy-agents.py').read_text())
        function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'secret')
        run = Mock()
        namespace = {'run': run, 'json': json, 'base64': base64}
        exec(compile(ast.Module(body=[function], type_ignores=[]), 'secret', 'exec'), namespace)
        namespace['secret']('chatgpt-auth', {'auth.json': b'{}'})
        self.assertIn('--field-manager=agent-box-host', run.call_args.args)
        namespace['secret']('panel', {'password': b'example'})
        self.assertIn('--field-manager=agent-box-install', run.call_args.args)

    def test_absent_oauth_source_preserves_an_existing_secret(self):
        import ast
        import types
        from unittest.mock import Mock
        tree = ast.parse((ROOT / 'deploy/deploy-agents.py').read_text())
        guard = next(node for node in tree.body if isinstance(node, ast.If) and isinstance(node.test, ast.Call)
                     and isinstance(node.test.func, ast.Attribute) and isinstance(node.test.func.value, ast.Name)
                     and node.test.func.value.id == 'source_auth')
        for existing in (b'secret/chatgpt-auth', b''):
            secret = Mock()
            namespace = {'source_auth': Mock(exists=Mock(return_value=False)), 'secret': secret,
                         'sp': types.SimpleNamespace(check_output=Mock(return_value=existing))}
            exec(compile(ast.Module(body=[guard], type_ignores=[]), 'auth bootstrap', 'exec'), namespace)
            if existing:
                secret.assert_not_called()
            else:
                secret.assert_called_once_with('chatgpt-auth', {'auth.json': b'{}'})

    def test_reinstall_preserves_recorded_deployment_images(self):
        import ast
        from unittest.mock import Mock
        tree = ast.parse((ROOT / 'deploy/deploy-agents.py').read_text())
        fields = {'native', 'worker', 'panel', 'sandbox'}
        assignments = [node for node in tree.body if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name) and target.id in fields for target in node.targets)]
        release = {'sandbox': {'image': 'registry/native@sha256:recorded', 'template': 'sandbox-recorded'},
                   'worker': 'registry/worker@sha256:recorded', 'panel': 'registry/panel@sha256:recorded'}
        digest = Mock(side_effect=AssertionError('Recorded images must not be replaced'))
        namespace = {'release': release, 'digest': digest}
        exec(compile(ast.Module(body=assignments, type_ignores=[]), 'recorded images', 'exec'), namespace)
        for name in ('worker', 'panel', 'sandbox'):
            self.assertEqual(namespace[name], release[name])
        self.assertEqual(namespace['native'], release['sandbox']['image'])
        digest.assert_not_called()

    def test_browser_origin_is_canonical(self):
        for origin in ('https://Panel.Example.Com:443/', 'HTTPS://PANEL.EXAMPLE.COM'):
            self.assertEqual(self.load(panel_origin=origin)['panel_origin'], 'https://panel.example.com')
        self.assertEqual(self.load(panel_origin='https://Panel.Example.Com:8443')['panel_origin'],
                         'https://panel.example.com:8443')

    def test_oauth_refresh_pins_the_configured_cluster(self):
        import runpy
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            source = home / '.config/agent-sandbox/codex-auth.json'
            source.parent.mkdir(parents=True)
            source.write_text('{}')
            with patch('pathlib.Path.home', return_value=home), patch('configuration.load', return_value={'kube_context': 'kind-configured'}), \
                    patch('subprocess.run') as command:
                runpy.run_path(str(ROOT / 'deploy/sync-auth.py'))
            self.assertEqual(command.call_args.args[0][:3], ['kubectl', '--context', 'kind-configured'])

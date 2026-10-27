import importlib.util
from pathlib import Path
import unittest

root = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("configure_egress", root / "deploy/configure-egress.py")
egress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(egress)


class Certificates(unittest.TestCase):
    def test_only_actor_connect_alpn_changes_and_reapplication_is_idempotent(self):
        original = (root / "vendor/substrate/manifests/ate-install/atenet-egress.yaml").read_text()
        changed = egress.configuration(original)
        self.assertEqual(changed.count('alpn_protocols: ["h2", "http/1.1"]'), original.count('alpn_protocols: ["h2", "http/1.1"]') - 1)
        self.assertEqual(changed.count('alpn_protocols: ["http/1.1"]'), 1)
        self.assertEqual(egress.configuration(changed), changed)
        self.assertEqual(changed.replace('alpn_protocols: ["http/1.1"]', 'alpn_protocols: ["h2", "http/1.1"]', 1), original)

    def test_listener_drift_is_refused(self):
        with self.assertRaises(AssertionError):
            egress.configuration('alpn_protocols: ["h2", "http/1.1"]')


if __name__ == "__main__":
    unittest.main()

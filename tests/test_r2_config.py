import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("configure_r2", Path(__file__).resolve().parents[1] / "deploy/configure-r2.py")
r2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r2)


class R2ConfigTests(unittest.TestCase):
    def test_settings_and_secret_references(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            config = {"endpoint": "https://" + "a" * 32 + ".r2.cloudflarestorage.com", "bucket": "agent-box-snapshots", "region": "auto"}
            (path / "config.json").write_text(json.dumps(config))
            credentials = path / "credentials.json"
            credentials.write_text(json.dumps({"access_key_id": "example-id", "secret_access_key": "example-secret"}))
            credentials.chmod(0o600)
            loaded, keys = r2.settings(path)
            self.assertEqual(loaded, config)
            env = {v["name"]: v for v in r2.storage_env(loaded)}
            self.assertEqual(env["AWS_REGION"]["value"], "auto")
            self.assertEqual(env["AWS_SECRET_ACCESS_KEY"]["valueFrom"]["secretKeyRef"]["name"], "substrate-r2")
            self.assertNotIn(keys["secret_access_key"], json.dumps(env))
            credentials.chmod(0o644)
            with self.assertRaises(ValueError):
                r2.settings(path)
            credentials.chmod(0o600)
            for endpoint in ("http://example.com", config["endpoint"] + "/agent-box-snapshots", "https://user:password@example.com"):
                (path / "config.json").write_text(json.dumps({**config, "endpoint": endpoint}))
                with self.assertRaises(ValueError):
                    r2.settings(path)
            (path / "config.json").write_text(json.dumps(config))
            credentials.unlink()
            os.symlink(path / "config.json", credentials)
            with self.assertRaises(OSError):
                r2.settings(path)


if __name__ == "__main__":
    unittest.main()

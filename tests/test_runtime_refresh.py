import importlib.util
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy"))

spec = importlib.util.spec_from_file_location("refresh_runtime", Path(__file__).parents[1] / "deploy/refresh-native-runtime.py")
refresh = importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)


class RuntimeRefresh(unittest.TestCase):
    def test_legacy_pool_without_catalog_is_a_noop(self):
        with patch.object(refresh.subprocess, "check_output", return_value=b""):
            self.assertIsNone(refresh.catalog())
        release = MagicMock()
        resolved = release.resolve.return_value
        resolved.parent = Path("/opt/agent-box/archives/releases")
        (resolved / "revision.txt").read_text.return_value = "a" * 40
        with patch.object(refresh, "load", return_value={"repository": "/opt/agent-box"}), \
                patch.object(refresh, "require_context"), \
                patch.object(refresh, "catalog", return_value=None), \
                patch.object(refresh, "published") as published, \
                patch.object(refresh, "identities") as identities, \
                patch("builtins.print"):
            refresh.main(release)
            published.assert_not_called()
            identities.assert_not_called()

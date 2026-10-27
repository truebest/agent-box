import importlib.util
import io
from pathlib import Path
import hashlib
import tarfile
import tempfile
import unittest
import os
import shutil
import subprocess
import sys
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("console_install", Path(__file__).parents[1] / "panel/console/install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class ConsolePackage(unittest.TestCase):
    def bundle(self, path, name, kind=tarfile.REGTYPE):
        with tarfile.open(path, "w:gz") as archive:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.linkname = "/etc/passwd" if kind == tarfile.SYMTYPE else ""
            member.size = 2 if kind == tarfile.REGTYPE else 0
            archive.addfile(member, io.BytesIO(b"ok") if member.size else None)
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def test_install_is_verified_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            archive = base / "bundle.tar.gz"
            digest = self.bundle(archive, "server/index.js")
            root = base / digest
            self.assertTrue(installer.install(root, digest, archive))
            self.assertEqual((root / "server/index.js").read_text(), "ok")
            self.assertFalse(archive.exists())
            self.assertTrue(installer.install(root, digest, archive))
            (root / "package.sha256").write_text("changed")
            with self.assertRaises(RuntimeError):
                installer.install(root, digest, archive)

    def test_package_escape_and_symlinks_are_rejected(self):
        for name, kind in (("../escape", tarfile.REGTYPE), ("/absolute", tarfile.REGTYPE), ("server/link", tarfile.SYMTYPE)):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                base = Path(directory)
                archive = base / "bundle.tar.gz"
                digest = self.bundle(archive, name, kind)
                with self.assertRaises(RuntimeError):
                    installer.install(base / digest, digest, archive)
                self.assertFalse((base / digest).exists())

    def test_checksum_and_existing_directory_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            archive = base / "bundle.tar.gz"
            digest = self.bundle(archive, "ok")
            with self.assertRaises(RuntimeError):
                installer.install(base / digest, "0" * 64, archive)
            link = base / "symlink"
            link.symlink_to(base, target_is_directory=True)
            with self.assertRaises(RuntimeError):
                installer.checked_directory(link)

    def test_package_parts_and_missing_part(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            digest = "a" * 64
            archive = installer.assemble(base, digest, 2)
            self.assertFalse(archive.exists())
            (base / (digest + ".0.part")).write_bytes(b"ok")
            archive = installer.assemble(base, digest, 2)
            self.assertEqual(archive.read_bytes(), b"ok")
            self.assertFalse((base / (digest + ".0.part")).exists())
            archive.unlink()
            (base / (digest + ".0.part")).write_bytes(b"wrong size")
            archive = installer.assemble(base, digest, 2)
            self.assertFalse(archive.exists())
            self.assertFalse((base / (digest + ".0.part")).exists())
            self.assertFalse(installer.install(base / digest, digest, archive))
            (base / (digest + ".0.part")).write_bytes(b"ok")
            self.assertEqual(installer.assemble(base, digest, 2).read_bytes(), b"ok")

    def test_older_python_does_not_receive_filter_argument(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            archive = base / "bundle.tar.gz"
            digest = self.bundle(archive, "file")
            original = tarfile.TarFile.extractall
            def legacy_extract(instance, path):
                return original(instance, path)
            with patch.object(installer.sys, "version_info", (3, 11)), patch.object(tarfile.TarFile, "extractall", legacy_extract):
                self.assertTrue(installer.install(base / digest, digest, archive))

    def test_upgrade_stops_only_the_authenticated_bridge_process(self):
        digest, token = "a" * 64, "test-bridge-token"
        health = {"ok": True, "web_ui": {"boot_id": digest}}
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory); root = base / digest
            (root / "server").mkdir(parents=True)
            shutil.copyfile(sys.executable, root / "bun"); (root / "bun").chmod(0o700)
            (root / "server/index.js").write_text("import time\ntime.sleep(60)\n")
            (root / "package.sha256").write_text(digest)
            env = dict(os.environ, HERDR_WEB_TOKEN=token, HERDR_WEB_BOOT_ID=digest)
            process = subprocess.Popen([str(root / "bun"), str(root / "server/index.js")], env=env)
            try:
                (base / "bridge.pid").write_text(str(process.pid))
                with self.assertRaisesRegex(RuntimeError, "identity"):
                    installer.stop_previous_bridge(base, health, "another-token")
                self.assertIsNone(process.poll(), "An unverified process was stopped")
                installer.stop_previous_bridge(base, health, token)
                self.assertEqual(process.wait(timeout=5), -15)
            finally:
                if process.poll() is None: process.terminate(); process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()

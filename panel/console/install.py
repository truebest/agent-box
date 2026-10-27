"""Run via the sandbox's UID-1000 /exec; install only the verified bridge package."""
import fcntl
import hashlib
import json
import os
import select
import signal
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request


def checked_directory(path):
    current = Path("/")
    for part in path.parts[1:]:
        current /= part
        if not current.exists():
            current.mkdir(mode=0o700)
        if not stat.S_ISDIR(current.lstat().st_mode):
            raise RuntimeError("Console directory must not contain symlinks")


def install(root, digest, archive):
    if root.exists():
        if not stat.S_ISDIR(root.lstat().st_mode) or (root / "package.sha256").read_text().strip() != digest:
            raise RuntimeError("Invalid console package directory")
        return True
    if not archive.exists():
        return False
    if not stat.S_ISREG(archive.lstat().st_mode):
        raise RuntimeError("Console package must be a regular file")
    with archive.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != digest:
        raise RuntimeError("Console package checksum mismatch")
    temporary = root.with_suffix(".installing")
    if temporary.exists():
        raise RuntimeError("Incomplete console installation; inspect before retrying")
    temporary.mkdir(mode=0o700)
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            for member in bundle.getmembers():
                if member.name.startswith("/") or ".." in Path(member.name).parts or not (member.isdir() or member.isfile()):
                    raise RuntimeError("Unsafe console package entry")
                if member.isfile() and member.size > 200 * 1024 * 1024:
                    raise RuntimeError("Console package entry too large")
            options = {"filter": "data"} if sys.version_info >= (3, 12) else {}
            bundle.extractall(temporary, **options)
        (temporary / "package.sha256").write_text(digest + "\n")
        temporary.rename(root)
        archive.unlink()
    except BaseException:
        shutil.rmtree(temporary)
        raise
    return True


def assemble(base, digest, size):
    archive = base / (digest + ".tar.gz")
    if archive.exists():
        return archive
    count = (size + 32 * 1024 * 1024 - 1) // (32 * 1024 * 1024)
    parts = [base / f"{digest}.{i}.part" for i in range(count)]
    if not all(part.exists() for part in parts):
        return archive
    for part in parts:
        if not stat.S_ISREG(part.lstat().st_mode):
            raise RuntimeError("Console package parts must be regular files")
    with archive.open("xb") as output:
        for part in parts:
            with part.open("rb") as source:
                shutil.copyfileobj(source, output)
    if archive.stat().st_size != size:
        archive.unlink()
        for part in parts:
            part.unlink()
        return archive
    for part in parts:
        part.unlink()
    return archive


def stop_previous_bridge(base, health, token):
    old = health.get("web_ui", {}).get("boot_id", "")
    if health.get("ok") is not True or len(old) != 64 or any(c not in "0123456789abcdef" for c in old):
        raise RuntimeError("Console listener identity is unavailable")
    root = base / old
    checked_directory(root)
    if (root / "package.sha256").read_text().strip() != old or not stat.S_ISREG((base / "bridge.pid").lstat().st_mode):
        raise RuntimeError("Previous console package identity does not match")
    pid = int((base / "bridge.pid").read_text())
    if pid <= 1:
        raise RuntimeError("Invalid console bridge process")
    descriptor = os.pidfd_open(pid)
    try:
        process = Path("/proc") / str(pid)
        argv = (process / "cmdline").read_bytes().rstrip(b"\0").split(b"\0")
        environment = dict(entry.split(b"=", 1) for entry in (process / "environ").read_bytes().split(b"\0") if b"=" in entry)
        if (process.stat().st_uid != os.getuid() or argv != [os.fsencode(root / "bun"), os.fsencode(root / "server/index.js")]
                or environment.get(b"HERDR_WEB_BOOT_ID") != old.encode() or environment.get(b"HERDR_WEB_TOKEN") != token.encode()):
            raise RuntimeError("Console bridge process identity does not match")
        signal.pidfd_send_signal(descriptor, signal.SIGTERM)
        if not select.select([descriptor], [], [], 10)[0]:
            raise RuntimeError("Previous console bridge did not stop")
    finally:
        os.close(descriptor)


def main():
    digest, token, size = sys.argv[1:]
    size = int(size)
    if os.getuid() != 1000 or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise RuntimeError("Invalid console installation identity")
    if not 0 < size <= 128 * 1024 * 1024:
        raise RuntimeError("Invalid console package size")
    base = Path("/workspace/.agent-state/herdr-web-ui")
    checked_directory(base)
    with (base / "install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        root = base / digest
        archive = base / (digest + ".tar.gz") if root.exists() else assemble(base, digest, size)
        if not install(root, digest, archive):
            print(json.dumps({"install_required": True}))
            return
        checked_directory(base / "uploads")
        env = dict(os.environ, HERDR_WEB_TOKEN=token, HERDR_WEB_BOOT_ID=digest, HERDR_SOCKET="/workspace/.agent-state/herdr.sock",
                   HERDR_SOCKET_PATH="/workspace/.agent-state/herdr.sock", HERDR_WEB_STATE_DIR=str(base / "state"),
                   HERDR_WEB_PASTE_DIR=str(base / "uploads"),
                   PATH=str(root / "bin") + ":" + os.environ["PATH"])
        request = urllib.request.Request("http://127.0.0.1:7317/api/health", headers={"Authorization": "Bearer " + token})

        def health():
            try:
                with urllib.request.urlopen(request, timeout=3) as response:
                    return json.load(response)
            except (OSError, urllib.error.URLError):
                return {}

        current = health()
        def ready():
            current = health()
            return current.get("ok") is True and current.get("web_ui", {}).get("boot_id") == digest

        if not current.get("ok") or current.get("web_ui", {}).get("boot_id") != digest:
            if current.get("ok") is True:
                stop_previous_bridge(base, current, token)
            with socket.socket() as probe:
                if probe.connect_ex(("127.0.0.1", 7317)) == 0:
                    raise RuntimeError("Console port is occupied by an unverified bridge")
            with (base / "bridge.log").open("ab", buffering=0) as log:
                process = subprocess.Popen([str(root / "bun"), str(root / "server/index.js")], cwd=root,
                                           env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            (base / "bridge.pid").write_text(str(process.pid) + "\n")
            deadline = time.monotonic() + 30
            while not ready():
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("Console bridge failed; inspect herdr-web-ui/bridge.log")
                time.sleep(0.1)
        print(json.dumps({"ready": True}))


if __name__ == "__main__":
    main()

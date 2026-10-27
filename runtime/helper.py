"""Actor HTTP endpoint; reachable only through the authenticated Substrate router."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import base64
import ctypes
import json
import hashlib
import os
from pathlib import Path
import select
import signal
import socket
import stat
import subprocess
import tempfile
import threading
import time
from urllib.parse import parse_qs, urlsplit

WORKSPACE = Path("/workspace")
task_lock = threading.Lock()
session_lock = threading.Lock()
frozen = False
process_baseline = {}
runtime_ready = False
auth_lock = threading.Lock()


class SessionError(Exception):
    pass



def open_checked(parent, name, flags):
    expected = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISLNK(expected.st_mode):
        raise ValueError("Symlinks are not accepted")
    fd = os.open(name, flags | os.O_NOFOLLOW, dir_fd=parent)
    actual = os.fstat(fd)
    # The pinned gVisor ignores O_NOFOLLOW on some tmpfs paths.
    if (expected.st_dev, expected.st_ino) != (actual.st_dev, actual.st_ino):
        os.close(fd)
        raise ValueError("Path changed while opening")
    return fd


@contextmanager
def parent_fd(path):
    parts = path.removeprefix("/workspace").lstrip("/").split("/")
    if path != "/workspace" and not path.startswith("/workspace/"):
        raise ValueError("Path must be in /workspace")
    if any(p in ("..", ".") or "\x00" in p for p in parts):
        raise ValueError("Invalid path")
    fd = os.open(WORKSPACE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            if part:
                child = open_checked(fd, part, os.O_RDONLY | os.O_DIRECTORY)
                os.close(fd)
                fd = child
        yield fd, parts[-1]
    finally:
        os.close(fd)


@contextmanager
def directory_fd(path):
    with parent_fd(path) as (parent, name):
        fd = open_checked(parent, name or ".", os.O_RDONLY | os.O_DIRECTORY)
        try:
            yield fd
        finally:
            os.close(fd)


def create_directory(path):
    if not isinstance(path, str) or (path != "/workspace" and not path.startswith("/workspace/")):
        raise ValueError("Path must be in /workspace")
    parts = path.removeprefix("/workspace").strip("/").split("/")
    if any(part in ("..", ".") or "\x00" in part for part in parts):
        raise ValueError("Invalid path")
    fd = os.open(WORKSPACE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in filter(None, parts):
            try:
                os.mkdir(part, mode=0o700, dir_fd=fd)
            except FileExistsError:
                pass
            child = open_checked(fd, part, os.O_RDONLY | os.O_DIRECTORY)
            os.close(fd)
            fd = child
    finally:
        os.close(fd)


def run_command(argv, fd, timeout):
    with subprocess.Popen(argv, cwd=f"/proc/self/fd/{fd}", pass_fds=(fd,),
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True) as process:
        deadline = time.monotonic() + timeout
        output = bytearray()
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
                    raise subprocess.TimeoutExpired(argv, timeout)
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                output.extend(chunk)
                del output[:-1048576]
            code = process.wait(timeout=max(0, deadline - time.monotonic()))
            return subprocess.CompletedProcess(argv, code, bytes(output))
        except BaseException:
            # Descendants may keep stdout open after the direct child exits.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            raise


def atomic_json(target, value):
    fd, temporary = tempfile.mkstemp(prefix=".update-", dir=target.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_auth(auth):
    tokens = auth.get("tokens", {}) if isinstance(auth, dict) else {}
    if not isinstance(tokens, dict):
        raise ValueError("ChatGPT credentials required")
    access = tokens.get("access_token")
    if not isinstance(access, str) or not access or tokens.get("refresh_token"):
        raise ValueError("ChatGPT credentials required")
    try:
        claims = json.loads(base64.urlsafe_b64decode(access.split(".")[1] + "=="))
        expires = int(claims["exp"]) * 1000
    except (ValueError, KeyError, IndexError, TypeError):
        raise ValueError("Invalid access token") from None
    if expires <= time.time() * 1000:
        raise ValueError("Expired access token")
    # Codex parses this JWT for claims; the central access token carries them.
    safe_tokens = {"id_token": access, "access_token": access, "refresh_token": "", "account_id": tokens.get("account_id")}
    with auth_lock:
        atomic_json(Path.home() / ".codex/auth.json", {"auth_mode": "chatgpt", "tokens": safe_tokens,
                    "last_refresh": auth.get("last_refresh")})
        atomic_json(Path.home() / ".pi/agent/auth.json", {"openai-codex": {
            "type": "oauth", "access": access, "refresh": "", "expires": expires,
            "accountId": tokens.get("account_id")}})


def herdr(*args, timeout=15):
    try:
        result = subprocess.run(["herdr", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise SessionError("Herdr connection failed. Delivery may be uncertain; inspect Terminal before submitting again.") from None
    try:
        response = json.loads(result.stdout)
    except ValueError:
        raise SessionError("Herdr unavailable. Open Terminal and run herdr.") from None
    if result.returncode or "error" in response:
        code = response.get("error", {}).get("code", "herdr_error")
        raise SessionError(f"Herdr {code}. Open Terminal and run herdr; do not retry an uncertain submission.")
    return response["result"]


def trust_codex_integration():
    directory = Path.home() / ".codex"
    command = f"bash '{directory}/herdr-agent-state.sh' session"
    hooks = json.loads((directory / "hooks.json").read_text())["hooks"]["SessionStart"]
    for group_index, group in enumerate(hooks):
        for handler_index, hook in enumerate(group["hooks"]):
            if group.get("matcher") is not None or hook != {"command": command, "timeout": 10, "type": "command"}:
                continue
            # Codex 0.162.1 hashes normalized TOML as sorted compact JSON.
            identity = {"event_name": "session_start", "hooks": [{**hook, "async": False}]}
            digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            key = f"{directory}/hooks.json:session_start:{group_index}:{handler_index}"
            section = f"[hooks.state.{json.dumps(key)}]"
            config = directory / "config.toml"
            if section not in config.read_text():
                with config.open("a") as stream:
                    stream.write(f'\n{section}\ntrusted_hash = "sha256:{digest}"\n')


def session_status():
    config = Path.home() / "session.json"
    settings = json.loads(config.read_text()) if config.exists() else {}
    panes = herdr("pane", "list")["panes"]
    pane = next((p for p in panes if p["pane_id"] == settings.get("pane_id")), None)
    agents = herdr("agent", "list")["agents"]
    runner = next((a for a in agents if a["pane_id"] == settings.get("pane_id")), None)
    conversation_ready = bool(runner and runner.get("agent_session"))
    if runner and settings.get("kind") == "codex" and not conversation_ready:
        # Codex emits SessionStart on its first turn; reject login and trust dialogs before that.
        screen = subprocess.run(["herdr", "pane", "read", settings["pane_id"]],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10)
        conversation_ready = screen.returncode == 0 and "› Ask Codex to do anything" in screen.stdout.decode(errors="replace")
    started = bool(runner and runner.get("agent") == settings.get("kind")
                   and (not runner.get("launch_pending", False)
                        or settings.get("kind") == "devin" and runner.get("agent_status") == "blocked"))
    setup = settings.get("kind") == "devin" and started and (not conversation_ready or runner.get("agent_status") == "blocked")
    return {**settings, "server": True, "pane": pane is not None, "runner": runner, "agents": agents,
            "started": started,
            **({"error": "Complete Devin CLI sign-in or setup in Superterminal before sending a task."} if setup else {}),
            "ready": runner is not None and runner.get("agent") == settings.get("kind")
                     and conversation_ready and not runner.get("launch_pending", False)
                     and runner.get("agent_status") in ("idle", "working", "done")}


def initialize_session(data):
    if not isinstance(data, dict):
        raise ValueError("Expected a session object")
    kind = data.get("kind", "codex")
    if kind == "none":
        if data.get("model") or data.get("cwd"):
            raise ValueError("Agent settings require an agent")
        with session_lock:
            require_running()
            config = Path.home() / "session.json"
            if config.exists() and json.loads(config.read_text()).get("kind") != "none":
                raise SessionError("A primary agent already exists")
            if not config.exists():
                atomic_json(config, {"kind": "none"})
            return session_status()
    model, cwd = data.get("model", "" if kind == "devin" else "gpt-6.1-sol"), data.get("cwd", "/workspace")
    if kind not in ("pi", "codex", "devin") or not isinstance(model, str) or (not model and kind != "devin") or len(model) > 128 or any(c.isspace() or ord(c) < 32 for c in model):
        raise ValueError("Invalid runner or model")
    if not isinstance(cwd, str):
        raise ValueError("Invalid directory")
    with session_lock:
        require_running()
        config = Path.home() / "session.json"
        if config.exists():
            saved = json.loads(config.read_text())
            if (saved["kind"], saved["model"], saved["cwd"]) != (kind, model, cwd):
                raise SessionError("Session already exists. Change model or directory in the native runner interface in Terminal.")
            state = session_status()
            if not state["ready"] and not (kind == "devin" and state.get("started")):
                raise SessionError("Runner is not ready. Open Terminal and run herdr.")
            return state
        if kind != "devin" and not (Path.home() / ".codex/auth.json").exists():
            raise SessionError("Deliver OAuth before starting the runner")
        if kind == "pi":
            catalog = subprocess.run(["pi", "--offline", "--list-models", model], stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, timeout=30)
            if catalog.returncode or not any(line.split()[:2] == ["openai-codex", model] for line in catalog.stdout.splitlines()):
                raise ValueError("Pi model is not available in the pinned openai-codex catalog")
        if herdr("workspace", "list")["workspaces"]:
            raise SessionError("An uninitialized workspace exists. Open Terminal and run herdr.")
        create_directory(cwd)
        # The server opens this held directory, so a concurrent rename cannot redirect cwd.
        with directory_fd(cwd) as fd:
            created = herdr("workspace", "create", "--cwd", f"/proc/{os.getpid()}/fd/{fd}", "--label", "main")
        pane_id = created["root_pane"]["pane_id"]
        atomic_json(config, {"kind": kind, "model": model, "cwd": cwd, "pane_id": pane_id})
        args = ["--provider", "openai-codex", "--model", model, "--thinking", "low", "--offline", "--continue"] if kind == "pi" else [
            "--model", model, "--cd", cwd, "--sandbox", "danger-full-access", "--ask-for-approval", "never"]
        if kind == "devin":
            args = ["--model", model] if model else []
        launch_error = None
        try:
            herdr("agent", "start", "main", "--kind", kind, "--pane", pane_id, "--timeout", "60000", "--", *args, timeout=70)
        except SessionError as error:
            if kind != "devin":
                raise
            # Herdr returns agent_not_ready for a live CLI awaiting workspace trust.
            # Only accept it after the native runner proves ownership below.
            launch_error = error
        for _ in range(50):
            state = session_status()
            if state["ready"] or kind == "devin" and state.get("started"):
                process_baseline.update(process_table())
                return state
            time.sleep(0.1)
        if launch_error is not None:
            raise launch_error
        raise SessionError("Runner failed to become ready. Open Terminal and run herdr.")


def submit_prompt(data):
    if not isinstance(data, dict):
        raise ValueError("Expected a prompt object")
    prompt = data.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt.encode()) > 65536 or any(ord(c) < 32 and c not in "\n\t" for c in prompt):
        raise ValueError("Prompt must contain 1–65536 bytes of text")
    with session_lock:
        require_running()
        state = session_status()
        if state.get("kind") == "none":
            raise SessionError("No primary agent was configured. Open Superterminal to add an agent and send it a task")
        if not state["ready"]:
            raise SessionError(state.get("error") or "Runner is blocked or unavailable. Open Terminal and run herdr.")
        herdr("agent", "prompt", state["pane_id"], prompt)
    return {"accepted": True, "message": "Sent to the agent terminal. Follow the conversation in Terminal → herdr."}


def require_running():
    if frozen:
        raise SessionError("Sandbox is being suspended; resume it before sending input")


def process_table():
    found = {}
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            fields = (path / "stat").read_text().rsplit(")", 1)[1].split()
            if fields[0] != "Z":
                found[(int(path.name), fields[19])] = (path / "cmdline").read_bytes()
        except FileNotFoundError:
            continue
    return found


def idle_state():
    panes = herdr("pane", "list")["panes"]
    control_busy = task_lock.locked() or session_lock.locked()
    quiet = not control_busy
    for pane in panes:
        if (pane.get("agent") not in ("codex", "pi", "devin") or pane.get("agent_status") not in ("idle", "done")
                or pane.get("background_tasks") or pane.get("background_wait") or pane.get("launch_pending")):
            quiet = False
    unknown = []
    for identity, command in process_table().items():
        if process_baseline.get(identity) == command:
            continue
        argv = command.decode(errors="replace").strip("\0").split("\0")
        bridge = len(argv) >= 2 and argv[1].startswith(str(Path.home() / "herdr-web-ui") + "/") and (
            len(argv) == 2 and argv[1].endswith("/server/index.js") and Path(argv[0]).name == "bun" or
            len(argv) >= 7 and argv[1].endswith("/server/pty-host.mjs") and Path(argv[0]).name == "node"
            and Path(argv[4]).name == "herdr" and argv[5:7] == ["terminal", "attach"])
        attachment = len(argv) >= 4 and Path(argv[0]).name == "herdr" and argv[1:3] == ["terminal", "attach"]
        if not (bridge or attachment):
            unknown.append(identity)
    return {"quiet": quiet and not unknown, "control_busy": control_busy, "signature": json.dumps([sorted(panes, key=lambda p: p["pane_id"]), sorted(unknown)], sort_keys=True)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, value, status=200):
        raw = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        if self.headers.get("Content-Length", "0") != "0" and not getattr(self, "body_consumed", False):
            self.close_connection = True
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(raw)

    def body(self, maximum=1024 * 1024):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 <= length <= maximum:
            raise ValueError("Request too large")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ValueError("Incomplete request body")
        self.body_consumed = True
        return raw

    def object_body(self):
        data = json.loads(self.body())
        if not isinstance(data, dict):
            raise ValueError("Expected an object")
        return data

    def handle_request(self):
        global frozen
        parsed = urlsplit(self.path)
        if parsed.path == "/readyz":
            return self.reply({"ready": runtime_ready}, 200 if runtime_ready else 503)
        if parsed.path.startswith("/terminal"):
            return self.terminal()
        if parsed.path == "/auth" and self.command == "POST":
            write_auth(self.object_body())
            return self.reply({"updated": True})
        if parsed.path in ("/runtime/freeze", "/runtime/thaw") and self.command == "POST":
            self.object_body()
            with session_lock:
                frozen = parsed.path.endswith("/freeze")
            return self.reply({"frozen": frozen})
        if parsed.path == "/runtime/idle" and self.command == "GET":
            return self.reply(idle_state())
        if parsed.path == "/session" and self.command == "GET":
            return self.reply(session_status())
        if parsed.path == "/session" and self.command == "POST":
            return self.reply(initialize_session(self.object_body()))
        if parsed.path == "/prompt" and self.command == "POST":
            return self.reply(submit_prompt(self.object_body()), 202)
        if parsed.path == "/exec" and self.command == "POST":
            require_running()
            data = self.object_body()
            argv = data["argv"]
            if not isinstance(argv, list) or not argv or any(not isinstance(a, str) for a in argv):
                raise ValueError("argv must be a nonempty array of strings")
            if not task_lock.acquire(blocking=False):
                return self.reply({"error": "An agent command is already running"}, 409)
            try:
                with directory_fd(data.get("cwd", "/workspace")) as fd:
                    result = run_command(argv, fd, min(max(int(data.get("timeout", 600)), 1), 3600))
                return self.reply({"exit_code": result.returncode, "output": result.stdout.decode(errors="replace")})
            finally:
                task_lock.release()
        if parsed.path != "/files":
            return self.reply({"error": "Unknown endpoint"}, 404)
        path = parse_qs(parsed.query).get("path", ["/workspace"])[0]
        with parent_fd(path) as (fd, name):
            if self.command == "GET":
                handle = open_checked(fd, name or ".", os.O_RDONLY | os.O_NONBLOCK)
                try:
                    mode = os.fstat(handle).st_mode
                    if stat.S_ISDIR(mode):
                        entries = [{"name": entry, "directory": stat.S_ISDIR(os.stat(entry, dir_fd=handle, follow_symlinks=False).st_mode)}
                                   for entry in sorted(os.listdir(handle))]
                        return self.reply({"entries": entries})
                    if not stat.S_ISREG(mode):
                        raise ValueError("Only regular files can be downloaded")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(os.fstat(handle).st_size))
                    self.send_header("Content-Disposition", "attachment")
                    self.end_headers()
                    with os.fdopen(os.dup(handle), "rb") as stream:
                        import shutil
                        shutil.copyfileobj(stream, self.wfile)
                    return
                finally:
                    os.close(handle)
            if not name:
                raise ValueError("Workspace root cannot be changed")
            if self.command == "PUT":
                raw = self.body(64 * 1024 * 1024)
                import uuid
                temporary = ".upload-" + uuid.uuid4().hex
                handle = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                try:
                    with os.fdopen(handle, "wb") as stream:
                        stream.write(raw)
                        stream.flush()
                        os.fsync(stream.fileno())
                    # rename replaces a final symlink itself without following it.
                    os.rename(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
                finally:
                    try:
                        os.unlink(temporary, dir_fd=fd)
                    except FileNotFoundError:
                        pass
            elif self.command == "POST":
                os.mkdir(name, mode=0o700, dir_fd=fd)
            elif self.command == "DELETE":
                try:
                    os.unlink(name, dir_fd=fd)
                except IsADirectoryError:
                    os.rmdir(name, dir_fd=fd)
            else:
                return self.reply({"error": "Method not allowed"}, 405)
        self.reply({"ok": True})

    def terminal(self):
        with socket.create_connection(("127.0.0.1", 8081), timeout=10) as upstream:
            upstream.sendall(f"{self.command} {self.path} HTTP/1.1\r\n".encode())
            for key, value in self.headers.items():
                if key.lower() not in ("authorization", "cookie"):
                    upstream.sendall(f"{key}: {value}\r\n".encode())
            upstream.sendall(b"\r\n")
            self.wfile.flush()
            upstream.settimeout(None)
            self.connection.settimeout(None)
            while True:
                ready, _, _ = select.select([upstream, self.connection], [], [], 60)
                if not ready:
                    continue
                for source in ready:
                    chunk = source.recv(65536)
                    if not chunk:
                        self.close_connection = True
                        return
                    (self.connection if source is upstream else upstream).sendall(chunk)

    def dispatch(self):
        self.body_consumed = False
        try:
            self.handle_request()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except SessionError as error:
            self.reply({"error": str(error)}, 409)
        except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired):
            self.reply({"error": "Invalid request, inaccessible path, or command timeout"}, 400)

    do_GET = do_POST = do_PUT = do_DELETE = dispatch


def main():
    global runtime_ready
    server = ThreadingHTTPServer(("0.0.0.0", 80), Handler)
    os.environ["HOME"] = str(WORKSPACE / ".agent-state")
    if os.geteuid() == 0:
        os.chmod("/", 0o755)
        os.chown(WORKSPACE, 1000, 1000)
        os.setgid(1000)
        os.setuid(1000)
        os.chmod(WORKSPACE, 0o700)
        # Herdr needs to open held cwd descriptors through this process's procfs.
        if ctypes.CDLL(None, use_errno=True).prctl(4, 1, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "Cannot expose cwd descriptors to the same UID")
    os.chdir(WORKSPACE)
    state = Path.home()
    state.mkdir(mode=0o700, exist_ok=True)
    os.environ["HERDR_SOCKET_PATH"] = str(state / "herdr.sock")
    # gVisor omits tpgid in procfs; Herdr provides this explicit detection mode.
    os.environ["HERDR_PROCESS_DETECTION"] = "child-groups"
    os.environ["SHELL"] = "/bin/bash"
    os.environ["HISTFILE"] = str(state / ".bash_history")
    os.environ["TERM"] = "xterm-256color"
    for relative in (".codex", ".pi/agent", ".local/share/devin", ".config/devin", ".config/herdr"):
        (state / relative).mkdir(parents=True, exist_ok=True)
    config = Path.home() / ".codex/config.toml"
    if not config.exists():
        config.write_text('model = "gpt-6.1-sol"\nmodel_provider = "chatgpt-sse"\ncli_auth_credentials_store = "file"\ncheck_for_update_on_startup = false\n[features]\ndaemon_auto_start = false\n[projects."/workspace"]\ntrust_level = "trusted"\n[model_providers.chatgpt-sse]\nname = "ChatGPT SSE"\nbase_url = "https://chatgpt.com/backend-api/codex"\nwire_api = "responses"\nrequires_openai_auth = true\nsupports_websockets = false\n')
    (state / ".config/herdr/config.toml").write_text('onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n[experimental]\npane_history = false\n')
    atomic_json(state / ".pi/agent/settings.json", {"transport": "sse"})
    for kind in ("codex", "pi", "devin"):
        subprocess.run(["herdr", "integration", "install", kind], check=True, stdout=subprocess.DEVNULL)
    trust_codex_integration()
    log = open(state / "herdr.log", "ab", buffering=0)
    process = subprocess.Popen(["herdr", "server"], stdout=log, stderr=log)
    for _ in range(100):
        try:
            herdr("workspace", "list")
            break
        except SessionError:
            if process.poll() is not None:
                raise RuntimeError("Herdr server failed; inspect .agent-state/herdr.log")
            time.sleep(0.1)
    else:
        raise RuntimeError("Herdr server startup timed out")
    subprocess.Popen(["ttyd", "-i", "127.0.0.1", "-p", "8081", "-W", "-b", "/terminal", "/bin/bash"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    process_baseline.update(process_table())
    runtime_ready = True
    server.serve_forever()


if __name__ == "__main__":
    main()

"""Manage agent-box-host agents through the HTTPS Substrate panel."""
import argparse
import base64
import json
import os
from pathlib import Path, PurePosixPath
import re
import ssl
import sys
import urllib.error
import urllib.request
from urllib.parse import parse_qs, quote, urlsplit, urlunsplit


class Client:
    def __init__(self, url, ca, password_file):
        if not url.startswith("https://"):
            raise ValueError("HTTPS is required")
        self.url = url.rstrip("/")
        self.actor_uids = {}
        self.context = ssl.create_default_context(cafile=ca)
        password = Path(password_file).read_text().strip()
        self.authorization = "Basic " + base64.b64encode(("admin:" + password).encode()).decode()
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        self.opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=self.context), NoRedirect)

    def runtime_path(self, path):
        parsed = urlsplit(path)
        runtime = re.fullmatch(r"/api/agents/([^/]+)/(?:session|prompt|exec|files|terminal(?:/.*)?)", parsed.path)
        if runtime and "uid" not in parse_qs(parsed.query, keep_blank_values=True):
            name = runtime[1]
            if name not in self.actor_uids:
                self.request("GET", "/api/agents/" + name)
            uid = self.actor_uids.get(name)
            if not uid:
                raise ValueError("Sandbox UID is unavailable")
            path = urlunsplit(("", "", parsed.path, parsed.query + ("&" if parsed.query else "") + "uid=" + quote(uid, safe=""), ""))
        return path

    def request(self, method, path, data=None):
        path = self.runtime_path(path)
        request = urllib.request.Request(self.url + path, method=method,
                                         data=None if data is None else json.dumps(data).encode(),
                                         headers={"Authorization": self.authorization, "Content-Type": "application/json"})
        with self.opener.open(request, timeout=660) as response:
            result = json.load(response)
        if isinstance(result, dict):
            for actor in result.get("actors", [result]):
                metadata = actor.get("metadata", {})
                if metadata.get("name") and metadata.get("uid"):
                    self.actor_uids.setdefault(quote(metadata["name"], safe=""), metadata["uid"])
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name")
    parser.add_argument("--kind", choices=("codex", "pi", "devin"))
    parser.add_argument("--model")
    parser.add_argument("--cwd")
    parser.add_argument("--prompt")
    operations = parser.add_mutually_exclusive_group()
    operations.add_argument("--delete", action="store_true")
    operations.add_argument("--suspend", action="store_true")
    operations.add_argument("--resume", action="store_true")
    operations.add_argument("--revert", action="store_true", help="Restore the last checkpoint after a crash; discard later changes")
    parser.add_argument("--url", default=os.getenv("AGENT_URL", "https://192.0.2.10:8443"))
    parser.add_argument("--ca", default=os.getenv("AGENT_CA", str(Path.home() / ".config/substrate-panel/ca.crt")))
    parser.add_argument("--password-file", default=os.getenv("AGENT_PASSWORD_FILE", str(Path.home() / ".config/substrate-panel/password")))
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,48}[a-z0-9]", args.name):
        parser.error("Use 2–50 lowercase letters, digits or hyphens, beginning with a letter")
    cwd = PurePosixPath(args.cwd or "/workspace")
    if not cwd.is_absolute() or cwd.parts[:2] != ("/", "workspace") or ".." in cwd.parts:
        parser.error("--cwd must be inside /workspace")
    client = Client(args.url, args.ca, args.password_file)
    path = "/api/agents/" + args.name
    if args.delete:
        print(json.dumps(client.request("DELETE", path)))
        return 0
    if args.suspend or args.resume or args.revert:
        operation = "suspend" if args.suspend else "revert" if args.revert else "resume"
        print(json.dumps(client.request("POST", path + "/" + operation)))
        return 0
    created = False
    try:
        actor = client.request("GET", path)
    except urllib.error.HTTPError as error:
        if error.code != 404:
            raise
        error.close()
        actor = client.request("POST", "/api/agents", {"name": args.name, "kind": args.kind or "codex",
                               "model": args.model if args.model is not None else "" if args.kind == "devin" else "gpt-6.1-sol", "cwd": args.cwd or "/workspace"})
        created = True
    if actor.get("status", {}).get("state") != "ACTOR_STATE_RUNNING":
        actor = client.request("POST", path + "/resume")
    session = client.request("GET", path + "/session")
    if not session.get("ready") and not (session.get("kind") == "devin" and session.get("started") and args.prompt is None):
        raise ValueError(session.get("error") or "Runner is unavailable. Open Terminal and inspect Herdr before restarting it.")
    if args.kind and session["kind"] != args.kind:
        raise ValueError("The existing agent has a different kind")
    if not created and ((args.model is not None and args.model != session.get("model")) or
                        (args.cwd is not None and args.cwd != session.get("cwd"))):
        raise ValueError("Session already exists. Change the model in Superterminal, or add an agent for another directory.")
    print(f"Agent {args.name}: session {'ready' if session.get('ready') else 'started; complete setup in Superterminal'}, kind={session['kind']}", flush=True)
    if args.prompt is not None:
        try:
            result = client.request("POST", path + "/prompt", {"prompt": args.prompt})
        except urllib.error.HTTPError:
            raise
        except OSError:
            raise OSError("Prompt delivery is uncertain. Read agent state and history in Superterminal before sending it again.") from None
        print(result["message"])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except urllib.error.HTTPError as error:
        print(f"Backend HTTP {error.code}: {error.read(4096).decode(errors='replace')}", file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

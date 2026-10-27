import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * install.sh's last step, the GitHub star: the whole script, run as `curl … | sh` runs it, on a
 * PATH that holds only what it needs. herdr, node and gh are stand-ins, so nothing is installed,
 * no herdr is touched, and no star is read or given.
 */

const ROOT = join(import.meta.dir, "..");
const MENTION = "a GitHub star helps other herdr users find it";
const QUESTION = "star it now with the GitHub account gh is signed in to? [y/N]";
const CTRL_C = "\x03";
/** what the stand-in gh answers: the status line `gh api --include` prints, what it says on stderr, and its exit code */
type Gh = "starred" | "not" | "refuses" | "denied" | "upstream" | "signed-out" | "hangs" | "stubborn" | "lingering";
const STAND_INS: Record<string, string> = {
  herdr: `case "$*" in
  --version) echo "herdr 0.9.3" ;;
  "plugin list") [ ! -e "$SCRATCH/installed" ] || echo "devswha.herdr-web-ui 0.0.0" ;;
  "plugin list --json") printf '{"result":{"plugins":[{"plugin_id":"devswha.herdr-web-ui","plugin_root":"%s"}]}}\\n' "$SCRATCH/plugin" ;;
  "plugin install "*) : > "$SCRATCH/installed"; echo "Installed devswha.herdr-web-ui" ;;
  "status server --json") echo '{"running":false}' ;;
  *) echo "unexpected herdr $*" >&2; exit 1 ;;
esac`,
  node: `echo v22.0.0`,
  gh: `echo "$*" >> "$SCRATCH/gh.calls"
mode=$(cat "$SCRATCH/gh.mode")
[ "$mode" != hangs ] || exec sleep 60
[ "$mode" != stubborn ] || { trap '' TERM; exec sleep 60; }
# a child that keeps gh's output open after gh itself has answered and gone
[ "$mode" != lingering ] || { sleep 60 & }
case "$*" in
  *"--method PUT"*) [ "$mode" != refuses ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }; exit 0 ;;
esac
case "$mode" in
  starred) printf 'HTTP/2.0 204 No Content\\n\\n' ;;
  not | refuses | lingering) printf 'HTTP/2.0 404 Not Found\\n\\n{"message":"Not Found"}\\n'; echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  denied) printf 'HTTP/2.0 403 Forbidden\\n\\n'; echo "gh: Resource not accessible by personal access token (HTTP 403)" >&2; exit 1 ;;
  upstream) printf 'HTTP/2.0 500 Internal Server Error\\n\\n'; echo "gh: upstream answered HTTP 404 (HTTP 500)" >&2; exit 1 ;;
  signed-out) echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4 ;;
esac`,
};

/**
 * One PC per test, since the tests run side by side: a home directory, and a PATH that holds only
 * what install.sh runs, so that a gh the real PC has is not on it.
 */
class Pc {
  readonly scratch = mkdtempSync(join(tmpdir(), "herdr-install-star-"));

  /** `perl: false`: a PC without perl, which the question needs to empty the typed-ahead input */
  constructor(gh?: Gh, options: { perl?: boolean } = {}) {
    pcs.push(this.scratch);
    const bin = join(this.scratch, "bin");
    mkdirSync(bin);
    mkdirSync(join(this.scratch, "plugin", "scripts"), { recursive: true });
    writeFileSync(join(this.scratch, "plugin", "scripts", "plugin.ts"), `if (process.argv[2] === "phone") console.log("the phone step");\n`);
    for (const tool of ["sh", "bash", "cat", "uname", "ldd", "grep", "curl", "git", "tar", "awk", "sed", "mktemp", "rm", "sleep", "perl"]) {
      if (tool === "perl" && options.perl === false) continue;
      const real = Bun.which(tool);
      if (real) symlinkSync(real, join(bin, tool));
    }
    symlinkSync(process.execPath, join(bin, "bun"));
    for (const name of gh ? ["herdr", "node", "gh"] : ["herdr", "node"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${STAND_INS[name]!}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    if (gh) writeFileSync(join(this.scratch, "gh.mode"), gh);
  }

  /** the plugin is there already: this run is a rerun */
  installed(): this { writeFileSync(join(this.scratch, "installed"), ""); return this; }
  ghCalls(): string[] {
    const log = join(this.scratch, "gh.calls");
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  }
  stars(): number { return this.ghCalls().filter((call) => call.includes("--method PUT")).length; }
  private environment(extra: Record<string, string> = {}): Record<string, string> {
    return { PATH: join(this.scratch, "bin"), HOME: this.scratch, SCRATCH: this.scratch, SHELL: "/bin/sh", TERM: "xterm", HERDR_WEB_UI_REF: "v0.0.0", ...extra };
  }

  /** as a script or an agent runs it: the script on stdin, and no terminal */
  async unattended(extra?: Record<string, string>): Promise<{ out: string; exitCode: number }> {
    const child = Bun.spawn(["sh"], { cwd: this.scratch, env: this.environment(extra), stdin: Bun.file(join(ROOT, "install.sh")), stdout: "pipe", stderr: "pipe" });
    const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out: out + err, exitCode };
  }

  /**
   * At a terminal (script(1) gives one), the script on stdin as under `curl … | sh`. `typed` goes
   * to the terminal once the question is on it; without `typed` nobody is there. `typedAhead` is
   * typed as the install starts, long before the question. The wrapping shell survives Ctrl-C as
   * the user's own shell does, and reports the installer's exit code.
   */
  async atTerminal(typed: string | null, extra?: Record<string, string>, typedAhead?: string, background = false): Promise<{ out: string; exitCode: number; asked: boolean; askedAt: number | null }> {
    // a background job of a shell with job control: its own process group, not the terminal's foreground
    const install = background ? `bash -c 'set -m; (cat "${join(ROOT, "install.sh")}" | sh) & wait %1'` : `cat "${join(ROOT, "install.sh")}" | sh`;
    const command = `trap : INT; ${install}; echo "exit=$?"`;
    const child = Bun.spawn([Bun.which("script")!, "-qec", command, "/dev/null"], { cwd: this.scratch, env: this.environment(extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let out = "";
    let answered = false;
    let askedAt: number | null = null;
    let again: ReturnType<typeof setInterval> | undefined;
    const type = (text: string) => { child.stdin.write(text); child.stdin.flush(); };
    if (typedAhead) type(typedAhead);
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      out += decoder.decode(chunk, { stream: true });
      if (askedAt === null && out.includes(QUESTION)) askedAt = Date.now();
      if (answered || typed === null || !out.includes(QUESTION)) continue;
      answered = true;
      type(typed);
      // The question is on the terminal a moment before the installer reads the answer. Typed text
      // waits in the terminal for that; Ctrl-C is a signal and does not, so it is pressed until it lands.
      if (typed === CTRL_C) again = setInterval(() => type(CTRL_C), 100);
    }
    clearInterval(again);
    await child.exited;
    child.stdin.end();
    return { out, exitCode: Number(/exit=(\d+)/.exec(out)?.[1] ?? -1), asked: out.includes(QUESTION), askedAt };
  }
}
const pcs: string[] = [];
afterAll(() => { for (const scratch of pcs) rmSync(scratch, { recursive: true, force: true }); });

// install.sh is the Linux and macOS installer: Windows has install.ps1 and scripts/windows-install.test.ps1
describe.skipIf(platform() === "win32")("install.sh without a terminal", () => {
  it.concurrent("mentions the star with a link when the PC has no gh", async () => {
    const { out, exitCode } = await new Pc().unattended();
    expect(exitCode).toBe(0);
    expect(out).toContain("Installed devswha.herdr-web-ui");
    expect(out).toContain(MENTION);
    expect(out).not.toContain(QUESTION);
    // the last thing said, so that a question after it can be left without losing a line
    expect(out.trimEnd().split("\n").at(-1)).toContain(MENTION);
  });

  it.concurrent("says nothing to an account that already starred", async () => {
    const pc = new Pc("starred");
    const { out, exitCode } = await pc.unattended();
    expect(exitCode).toBe(0);
    expect(out).not.toContain(MENTION);
    expect(pc.ghCalls()).toEqual(["api --hostname github.com --include user/starred/devswha/herdr-web-ui"]);
  });

  it.concurrent("gives the link and asks nothing when the account has not starred", async () => {
    const pc = new Pc("not");
    const { out, exitCode } = await pc.unattended();
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    expect(out).not.toContain(QUESTION);
    expect(pc.stars()).toBe(0);
  });

  it.concurrent("stays quiet on a rerun, and does not ask gh", async () => {
    const pc = new Pc("not").installed();
    const { out, exitCode } = await pc.unattended();
    expect(exitCode).toBe(0);
    expect(out).toContain("already installed as a herdr plugin");
    expect(out).not.toContain(MENTION);
    expect(pc.ghCalls()).toEqual([]);
  });

  it.concurrent("goes on with the link when gh does not answer", async () => {
    const pc = new Pc("hangs");
    const started = Date.now();
    const { out, exitCode } = await pc.unattended();
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it.concurrent("is not held by a child of gh that keeps its output open after gh answered", async () => {
    const pc = new Pc("lingering");
    const started = Date.now();
    const { out, exitCode } = await pc.unattended();
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    expect(Date.now() - started).toBeLessThan(8_000);
  }, 30_000);

  it.concurrent("kills a gh that ignores TERM, and goes on with the link", async () => {
    const pc = new Pc("stubborn");
    const started = Date.now();
    const { out, exitCode } = await pc.unattended();
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    // 10 seconds for gh, 2 more before it is killed
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});

// script(1) as util-linux has it; macOS's takes other arguments
describe.skipIf(platform() !== "linux" || !Bun.which("script"))("install.sh at a terminal", () => {
  it.concurrent("stars once on y", async () => {
    const pc = new Pc("not");
    const { out, exitCode } = await pc.atTerminal("y\n");
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    expect(out).toContain("starred. Thank you!");
    expect(pc.stars()).toBe(1);
  });

  for (const [name, typed] of [["Enter alone", "\n"], ["n", "n\n"], ["anything but y or yes", "yy\n"], ["the end of input", "\x04"]] as const) {
    it.concurrent(`does not star on ${name}`, async () => {
      const pc = new Pc("not");
      const { asked, exitCode } = await pc.atTerminal(typed);
      expect(asked).toBe(true);
      expect(exitCode).toBe(0);
      expect(pc.stars()).toBe(0);
    });
  }

  it.concurrent("does not take what was typed before the question for its answer", async () => {
    const pc = new Pc("not");
    const { asked, exitCode } = await pc.atTerminal("\n", {}, "y\n");
    expect(asked).toBe(true);
    expect(exitCode).toBe(0);
    expect(pc.stars()).toBe(0);
  });

  it.concurrent("asks nothing where what was typed before cannot be discarded: a PC without perl, y typed ahead", async () => {
    const pc = new Pc("not", { perl: false });
    const { out, asked, exitCode } = await pc.atTerminal(null, {}, "y\n");
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    expect(asked).toBe(false);
    expect(pc.stars()).toBe(0);
  });

  it.concurrent("asks nothing from a background job, which the terminal would stop for reaching it", async () => {
    const pc = new Pc("not");
    const started = Date.now();
    const { out, asked, exitCode } = await pc.atTerminal(null, {}, undefined, true);
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    expect(asked).toBe(false);
    expect(pc.stars()).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it.concurrent("ends well, with no star, when the question is left with Ctrl-C", async () => {
    const pc = new Pc("not");
    const { asked, exitCode } = await pc.atTerminal(CTRL_C);
    expect(asked).toBe(true);
    expect(exitCode).toBe(0);
    expect(pc.stars()).toBe(0);
  });

  it.concurrent("says so when gh refuses the star", async () => {
    const pc = new Pc("refuses");
    const { out, exitCode } = await pc.atTerminal("yes\n");
    expect(exitCode).toBe(0);
    expect(out).toContain("gh could not star it");
  });

  // only GitHub's own "not starred" is a reason to ask: its text in another failure is not
  for (const mode of ["denied", "upstream", "signed-out"] as const) {
    it.concurrent(`asks nothing when gh's answer is ${mode}`, async () => {
      const pc = new Pc(mode);
      const { out, asked, exitCode } = await pc.atTerminal(null);
      expect(exitCode).toBe(0);
      expect(out).toContain(MENTION);
      expect(asked).toBe(false);
    });
  }

  it.concurrent("asks nothing in CI, terminal or not", async () => {
    const pc = new Pc("not");
    const { out, asked, exitCode } = await pc.atTerminal(null, { CI: "true" });
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    expect(asked).toBe(false);
  });

  it.concurrent("goes on by itself when nobody is at the terminal", async () => {
    const pc = new Pc("not");
    const started = Date.now();
    const { asked, askedAt, exitCode } = await pc.atTerminal(null);
    const ended = Date.now();
    expect(asked).toBe(true);
    expect(exitCode).toBe(0);
    expect(pc.stars()).toBe(0);
    // the 20 seconds are the question's, from the moment it is on the terminal
    expect(askedAt).not.toBeNull();
    expect(ended - askedAt!).toBeGreaterThanOrEqual(19_000);
    expect(ended - askedAt!).toBeLessThan(27_000);
    expect(ended - started).toBeLessThan(40_000);
  }, 60_000);
});

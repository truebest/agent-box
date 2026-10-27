import { readFileSync, readlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

type Process = { pid: number; start: string; parent: number; argv: string[]; executable: string };
type Pane = { pane_id: string; agent?: string; agent_status?: string; background_tasks?: number; background_wait?: boolean; launch_pending?: boolean };
type ProcessInfo = { shell_pid: number; foreground_processes: { pid: number }[] };
type Idle = { quiet: boolean; signature: string; control_busy?: boolean };
const execute = promisify(execFile);
const ready = (pane: Pane) => ["codex", "pi", "devin"].includes(pane.agent || "") && ["idle", "done"].includes(pane.agent_status || "") && !pane.background_tasks && !pane.background_wait && !pane.launch_pending;

function readProcess(pid: number): Process | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid agent process identity");
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ");
    return { pid, start: stat[19]!, parent: Number(stat[1]), argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+$/, "").split("\0"), executable: readlinkSync(`/proc/${pid}/exe`) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function snapshot(state: Idle): [Pane[], [number, string][]] {
  const value: unknown = JSON.parse(state.signature);
  if (!Array.isArray(value) || value.length !== 2 || !Array.isArray(value[0]) || !Array.isArray(value[1]) ||
      !value[0].every(pane => pane && typeof pane.pane_id === "string") ||
      !value[1].every(identity => Array.isArray(identity) && identity.length === 2 && Number.isSafeInteger(identity[0]) && identity[0] > 0 && typeof identity[1] === "string")) throw new Error("Invalid runtime idle snapshot");
  return value as [Pane[], [number, string][]];
}

export function refineIdle(state: Idle, information: Map<string, ProcessInfo>, processOf = readProcess): Idle {
  const [panes, unknown] = snapshot(state);
  if (state.quiet || state.control_busy || !panes.every(ready)) return state;
  const managed = new Map<number, Process>();
  for (const pane of panes) {
    const info = information.get(pane.pane_id);
    if (!info || !Number.isSafeInteger(info.shell_pid) || !Array.isArray(info.foreground_processes)) throw new Error("Agent process ownership is unavailable");
    const shell = processOf(info.shell_pid);
    if (!shell || !["/bin/bash", "/usr/bin/bash", "/bin/sh", "/bin/zsh", "/usr/bin/zsh", "/usr/bin/fish"].includes(shell.argv[0]!)) return { ...state, quiet: false };
    const foreground = info.foreground_processes.map(item => processOf(item.pid)).filter((item): item is Process => item !== null);
    const wrappers = foreground.filter(item => item.parent === shell.pid && ["node", "/usr/bin/node", "/usr/local/bin/node"].includes(item.argv[0]!) && item.argv[1] === `/opt/agents/node_modules/.bin/${pane.agent}`);
    // Pi replaces its argv with process.title after startup.
    const agents = pane.agent === "pi" ? [...wrappers, ...foreground.filter(item => item.parent === shell.pid && item.argv.length === 1 && item.argv[0] === "pi" && item.executable === "/usr/local/bin/node")] : foreground.filter(item => wrappers.some(wrapper => wrapper.pid === item.parent) && item.argv[0] === "/opt/agents/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex");
    const devin = pane.agent === "devin" ? foreground.filter(item => item.parent === shell.pid && ["devin", "/opt/devin-cli/bin/devin"].includes(item.argv[0]!) && item.executable === "/opt/devin-cli/bin/devin" && !item.argv.includes("--cloud")) : [];
    const acp = devin.length ? foreground.filter(item => devin.some(parent => parent.pid === item.parent) && item.executable === "/opt/devin-cli/bin/devin" && item.argv.length === 2 && item.argv[0] === "/opt/devin-cli/bin/devin" && item.argv[1] === "acp") : [];
    if (!(pane.agent === "devin" ? devin.length : agents.length)) return { ...state, quiet: false };
    for (const item of [shell, ...wrappers, ...agents, ...devin, ...acp]) managed.set(item.pid, item);
  }
  const fingerprints: [number, string, string][] = [];
  const remaining = unknown.filter(([pid, start]) => {
    const item = managed.get(pid);
    if (!item || item.start !== start) return true;
    fingerprints.push([pid, start, createHash("sha256").update(JSON.stringify([item.executable, item.argv])).digest("hex")]);
    return false;
  });
  return { quiet: remaining.length === 0, signature: JSON.stringify([panes, remaining, fingerprints.sort((a, b) => a[0] - b[0])]) };
}

export async function idleState(): Promise<Idle> {
  const read = async (): Promise<Idle> => {
    const response = await fetch("http://127.0.0.1/runtime/idle", { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Runtime idle state is unavailable");
    const state = await response.json() as Idle;
    if (typeof state.quiet !== "boolean" || typeof state.signature !== "string") throw new Error("Invalid runtime idle state");
    snapshot(state);
    return state;
  };
  const first = await read();
  const [panes, unknown] = snapshot(first);
  if (first.quiet || first.control_busy || unknown.length === 0 || !panes.every(ready)) return first;
  const information = new Map<string, ProcessInfo>();
  for (const pane of panes) {
    const result = await execute("herdr", ["pane", "process-info", "--pane", pane.pane_id], { timeout: 5000, maxBuffer: 1 << 20 });
    const response = JSON.parse(result.stdout);
    if (response.error) throw new Error("Agent process ownership is unavailable");
    information.set(pane.pane_id, response.result?.process_info);
  }
  const refined = refineIdle(first, information);
  const last = await read();
  return last.signature === first.signature && !last.control_busy ? refined : { ...last, quiet: false };
}

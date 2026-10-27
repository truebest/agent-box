import { expect, test } from "bun:test";
import { refineIdle } from "./idle.ts";

const binary = "/opt/agents/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex";
function fixture(kind = "codex") {
  const pane = { pane_id: "w1:p2", agent: kind, agent_status: "done" };
  const processes = new Map([
    [605, { pid: 605, start: "10", parent: 4, argv: ["/bin/bash"], executable: "/usr/bin/bash" }],
    [611, { pid: 611, start: "11", parent: 605, argv: ["node", `/opt/agents/node_modules/.bin/${kind}`], executable: "/usr/local/bin/node" }],
    [621, { pid: 621, start: "12", parent: 611, argv: [binary], executable: binary }],
  ]);
  if (kind === "pi") processes.delete(621);
  const information = new Map([[pane.pane_id, { shell_pid: 605, foreground_processes: [...processes.keys()].map(pid => ({ pid })) }]]);
  const state = () => ({ quiet: false, signature: JSON.stringify([[pane], [...processes.values()].map(item => [item.pid, item.start])]) });
  const inspect = () => refineIdle(state(), information, pid => processes.get(pid) ?? null);
  return { pane, processes, information, state, inspect };
}

test("agents added after runtime startup become idle for Codex and Pi", () => {
  for (const kind of ["codex", "pi"]) {
    const f = fixture(kind);
    expect(f.inspect().quiet).toBe(true);
    expect(f.inspect().signature).toBe(f.inspect().signature);
    expect(JSON.parse(f.inspect().signature)[1]).toEqual([]);
  }
});

test("Pi process.title is recognized only for its owned Node process", () => {
  const f = fixture("pi");
  f.processes.get(611)!.argv = ["pi"];
  expect(f.inspect().quiet).toBe(true);
  f.processes.get(611)!.executable = "/usr/bin/sleep";
  expect(f.inspect().quiet).toBe(false);
  f.processes.get(611)!.executable = "/usr/local/bin/node";
  f.processes.get(611)!.parent = 700;
  expect(f.inspect().quiet).toBe(false);
});

test("foreground and background tool children are never accepted as the agent", () => {
  for (const argv of [["sleep", "100"], ["python3", "job.py"], ["node", "job.js"], [binary]]) {
    const f = fixture();
    f.processes.set(700, { pid: 700, start: "20", parent: 621, argv, executable: argv[0]! });
    f.information.get(f.pane.pane_id)!.foreground_processes.push({ pid: 700 });
    expect(f.inspect().quiet).toBe(false);
    expect(JSON.parse(f.inspect().signature)[1]).toEqual([[700, "20"]]);
  }
});

test("working, input, pending launch, shell panes and helper operations block suspend", () => {
  for (const change of [{ agent_status: "working" }, { agent_status: "blocked" }, { background_tasks: 1 }, { background_wait: true }, { launch_pending: true }, { agent: "shell" }]) {
    const f = fixture(); Object.assign(f.pane, change);
    expect(f.inspect().quiet).toBe(false);
  }
  const f = fixture();
  expect(refineIdle({ ...f.state(), control_busy: true }, f.information, pid => f.processes.get(pid) ?? null).quiet).toBe(false);
});

test("missing ownership, changed commands, disappearing processes and PID reuse defer suspend", () => {
  const f = fixture();
  expect(() => refineIdle(f.state(), new Map(), pid => f.processes.get(pid) ?? null)).toThrow();
  const original = f.state();
  f.processes.get(621)!.start = "reused";
  expect(refineIdle(original, f.information, pid => f.processes.get(pid) ?? null).quiet).toBe(false);
  f.processes.get(621)!.argv = ["sleep", "100"];
  expect(f.inspect().quiet).toBe(false);
  f.processes.delete(611);
  expect(f.inspect().quiet).toBe(false);
  expect(() => refineIdle({ quiet: false, signature: "invalid" }, f.information)).toThrow();
});

test("Devin CLI idle accepts only its owned pinned REPL and ACP process", () => {
  const f = fixture("devin");
  const devin = "/opt/devin-cli/bin/devin";
  Object.assign(f.processes.get(611)!, { argv: ["devin"], executable: devin });
  Object.assign(f.processes.get(621)!, { argv: [devin, "acp"], executable: devin });
  expect(f.inspect().quiet).toBe(true);
  f.processes.get(621)!.argv = [devin, "-p", "background job"];
  expect(f.inspect().quiet).toBe(false);
  f.processes.get(621)!.argv = [devin, "acp"];
  f.processes.get(621)!.parent = 999;
  expect(f.inspect().quiet).toBe(false);
  f.processes.get(621)!.parent = 611;
  f.processes.get(611)!.executable = "/usr/bin/sleep";
  expect(f.inspect().quiet).toBe(false);
});

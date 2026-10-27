import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Machine, SetupRequest } from "../shared/machines.ts";

// A built client with a fictional PC and an in-memory API; no SSH and no user session.
// A PC that waits with action_required "bridge_conflict" is not a PC that needs setup approval:
// the sidebar and the line under the header say it is a conflict and offer Reconnect, which
// starts a plain setup (no bridge update).
const snapshot = { version: "0.9.3", protocol: 22, focused_workspace_id: null, focused_tab_id: null, focused_pane_id: null, workspaces: [], tabs: [], panes: [], layouts: [], agents: [] };
const local = { id: "local", name: "QA host", kind: "local", state: "connected", enabled: true, error: null, snapshot } as Machine;
const reason = "This PC uses a newer bridge (v99); this app requires v1. Update this app, then reconnect. The remote bridge was left running.";
const pc: Machine = { ...local, id: "qa-remote", name: "QA remote", kind: "ssh", target: { destination: "qa.invalid" }, state: "error", error: reason, action_required: "bridge_conflict" };
const requests: SetupRequest[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/health") return Response.json({ ok: true, auth: { authenticated: true, required: false, role: "drive" }, herdr: { version: "0.9.3", protocol: 22 }, web_ui: { revision: null, boot_id: "qa" } });
  if (path === "/api/machines") return Response.json({ machines: [local, pc] });
  if (path === "/api/session") return Response.json({ snapshot });
  if (path === "/api/machines/settings") return Response.json({ auto_update_bridges: false });
  if (path === "/api/machines/setup" && request.method === "POST") {
    const body = await request.json() as SetupRequest; requests.push(body);
    return Response.json({ id: "qa-job", machine_id: pc.id, target: { destination: body.destination }, phase: "connected", step: "Connected", challenge: null, installations: [], error: null, ssh_output: null }, { status: 202 });
  }
  if (path.startsWith("/api/") || path === "/ws") return Response.json({ error: { code: "qa", message: "Unavailable in fixture" } }, { status: 404 });
  const file = Bun.file(resolve("dist", path === "/" ? "index.html" : path.slice(1)));
  return new Response(await file.exists() ? file : Bun.file("dist/index.html"));
} });
const browser = await chromium.launch({ headless: true, executablePath: process.env["CHROME_PATH"] || chromium.executablePath() });
const shots = resolve("evidence/machine-conflict"); mkdirSync(shots, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" })));
  await page.goto(server.url.href);
  const notice = page.locator(".machine-action");
  await notice.getByText("Bridge connection conflict", { exact: true }).waitFor({ timeout: 10_000 });
  await notice.getByText(reason, { exact: true }).waitFor();
  await page.locator(".update-notice").getByText("QA remote has a bridge connection conflict.", { exact: true }).waitFor();
  // neither place calls it a setup that waits for approval, or offers an update that cannot help
  assert.equal(await page.getByText("Setup needed", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Set up…", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Update bridge", exact: true }).count(), 0);
  await page.screenshot({ path: `${shots}/conflict.png` });
  await notice.getByRole("button", { name: "Reconnect", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reconnect PC", exact: true });
  await dialog.locator("button[type=submit]").click();
  await dialog.getByRole("button", { name: "Open PC", exact: true }).waitFor();
  assert.equal(requests.length, 1); assert.equal(requests[0]!.machine_id, pc.id); assert.equal(requests[0]!.update_remote, undefined);
  await dialog.getByRole("button", { name: "Close PC setup" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator(".update-notice").getByRole("button", { name: "Reconnect", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${shots}/conflict-mobile.png` });
  assert.deepEqual(errors, []);
  console.log("PASS: a bridge conflict is named as one in the sidebar and under the header, and Reconnect starts a plain setup; screenshots:", shots);
} finally { await browser.close(); server.stop(true); }

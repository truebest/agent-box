"""Apply the embedded-only overlay to pinned Herdr Web v0.4.8; fail on drift."""
from pathlib import Path
import json
import shutil
import sys

root, overlay = map(Path, sys.argv[1:])


def replace(file, old, new):
    path = root / file
    text = path.read_text()
    assert text.count(old) == 1, (file, old[:100])
    path.write_text(text.replace(old, new))


for source, target in (("client.ts", "src/embedded.ts"), ("navigation.tsx", "src/ConsoleNavigation.tsx"), ("navigation.css", "src/ConsoleNavigation.css"), ("entry.ts", "server/embedded.ts"), ("workspace.ts", "server/workspace.ts"), ("idle.ts", "server/idle.ts")):
    shutil.copyfile(overlay / source, root / target)
for source, target in (("embedded.test.ts", "src/embedded.test.ts"), ("workspace.test.ts", "server/workspace.test.ts"), ("idle.test.ts", "server/idle.test.ts")):
    shutil.copyfile(overlay / source, root / target)
replace("src/main.tsx", 'import { App }', 'import { ConsoleRoot } from "./ConsoleNavigation.tsx";\nimport { App }')
replace("src/main.tsx", '{reader !== null ? <FileReader target={reader} /> : <App />}', '<ConsoleRoot>{reader !== null ? <FileReader target={reader} /> : <App />}</ConsoleRoot>')
replace("vite.config.ts", 'plugins: [react()', 'base: "/console-assets/",\n  plugins: [react()')
replace("index.html", '    <script type="module" src="/src/pwa.ts"></script>', '')
replace("index.html", '    <link rel="manifest" href="/manifest.webmanifest?v=2" />', '')
replace("src/lib/push.ts", '  return typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof globalThis.PushManager !== "undefined";', '  return false;')
replace("src/App.tsx", 'const updates = useUpdates(locked === false);', 'const updates = useUpdates(false);')
replace("src/App.tsx", '    const events = new EventSource("/api/machines/events");', '    if (EMBEDDED) return;\n    const events = new EventSource("/api/machines/events");')
replace("src/App.tsx", '  const handleServerMessage = useCallback((message: ServerMessage) => {', '''  const handleServerMessage = useCallback((message: ServerMessage) => {
    if (EMBEDDED && message.type === "pane-status") {
      snapshotRequests.current.invalidate();
      if (!machinesRef.current.find(machine => machine.id === "local")?.snapshot) scheduleRefetch();
      setMachines(list => list.map(machine => {
        if (machine.id !== "local" || !machine.snapshot) return machine;
        const snapshot = applyPaneStatus(machine.snapshot, message.pane_id, message.agent_status, message.background_tasks, message.background_wait === true, message.plan);
        return snapshot === machine.snapshot ? machine : { ...machine, snapshot };
      }));
    }
    if (EMBEDDED && (message.type === "session-changed" || message.type === "pane-exited")) {
      snapshotRequests.current.invalidate();
      scheduleRefetch();
    }''')
replace("src/App.tsx", '    if (message.type === "error" && message.code === "output_stalled") setOutputStopped(true);\n  }, []);', '    if (message.type === "error" && message.code === "output_stalled") setOutputStopped(true);\n  }, [scheduleRefetch]);')
replace("src/App.tsx", 'import { ApiError,', 'import { EMBEDDED } from "./embedded.ts";\nimport { ApiError,')
replace("src/App.tsx", 'import { MachineActionBanner, MachineSidebar }', 'import { useConsoleNavigation, useConsoleSession } from "./ConsoleNavigation.tsx";\nimport { MachineActionBanner }')
replace("src/App.tsx", '<MachineSidebar machines={machines} selectedMachineId={selectedMachineId} selectedPaneId={selectedPaneId} actions={actions} onSelect={selectTarget} onSetup={(machine, update = false) => { setUpdateRemote(update); setMachineDialog(machine); }} onNew={(id) => { setNewSessionMachineId(id); setNewTab(null); setNewSessionOpen(true); setDrawerOpen(false); }} />', '{null}')
replace("src/App.tsx", 't(drawerOpen ? "Close workspace list" : "Open workspace list")', 'drawerOpen ? "Close navigation" : "Open navigation"')
replace("src/App.tsx", 't(sidebarCollapsed ? "Show workspace list" : "Hide workspace list")', 'sidebarCollapsed ? "Show navigation" : "Hide navigation"')
replace("src/App.tsx", 'import { SidebarResizer } from "./components/SidebarResizer.tsx";\n', '')
replace("src/App.tsx", '<SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />', '')
replace("src/App.tsx", '  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);', '')
replace("src/App.tsx", 'import { storedSidebarWidth } from "./lib/sidebarWidth.ts";\n', '')
replace("src/App.tsx", ' style={sidebarWidth === null ? undefined : { "--sidebar-user-w": `${sidebarWidth}px` } as CSSProperties}', '')
replace("src/App.tsx", 'type CSSProperties, ', '')
replace("src/App.tsx", '  const [drawerOpen, setDrawerOpen] = useState(() => initialLink?.sidebar === "shown" && window.matchMedia?.("(min-width: 769px)").matches !== true);', '  const { drawerOpen, setDrawerOpen, sidebarCollapsed, setSidebarCollapsed } = useConsoleNavigation();')
replace("src/App.tsx", '  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => initialLink?.sidebar === "hidden");', '')
replace("src/App.tsx", '  useEffect(() => watchDrawerSwipe(() => drawerOpenRef.current, setDrawerOpen), []);', '')
replace("src/App.tsx", 'import { watchDrawerSwipe } from "./lib/edgeSwipe.ts";\n', '')
replace("src/App.tsx", '  const { drawerOpen, setDrawerOpen, sidebarCollapsed, setSidebarCollapsed } = useConsoleNavigation();', '''  const { drawerOpen, setDrawerOpen, sidebarCollapsed, setSidebarCollapsed } = useConsoleNavigation();
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.source === window.parent && event.data?.type === "console-settings") setSettingsOpen(true);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);''')
replace("src/App.tsx", '            aria-controls="workspace-drawer"\n', '')
replace("src/App.tsx", '<div className={`pane-column${chatShown ? " is-chat" : ""}`}>', '<div className={`pane-column${chatShown ? " is-chat" : ""}`}>\n        {error && <div className="error-state" role="alert"><p>{error}</p><button className="btn" onClick={() => void load()}>{t("Retry")}</button></div>}')
replace("src/App.tsx", '        {/* over the pane only:', '''        {snapshot && snapshot.panes.length === 0 && <div className="pane-notice"><button type="button" className="btn" onClick={actions.openNewSession}><Plus aria-hidden="true" />{t("New workspace")}</button></div>}
        {/* over the pane only:''')
replace("src/App.tsx", 'defaultCwd={newSessionMachineId === selectedMachineId ? selectedPane?.cwd ?? null : null}', 'defaultCwd={newSessionMachineId === selectedMachineId ? selectedPane?.cwd ?? "/workspace" : null}')
replace("src/App.tsx", '<header className="app-header">\n          <Brand />', '<header className="app-header">\n          <button className="icon-button drawer-toggle" aria-label={drawerOpen ? "Close navigation" : "Open navigation"} aria-expanded={drawerOpen} onClick={() => setDrawerOpen(open => !open)}>{drawerOpen ? <X /> : <Menu />}</button>\n          <button className="icon-button sidebar-toggle" aria-label={sidebarCollapsed ? "Show navigation" : "Hide navigation"} onClick={() => setSidebarCollapsed(collapsed => !collapsed)}><PanelLeft /></button>\n          <Brand />')
replace("src/lib/settings.ts", 'import { REPORTED_SETTINGS,', 'import { CONSOLE_SETTINGS_KEY } from "../embedded.ts";\nimport { REPORTED_SETTINGS,')
replace("src/lib/settings.ts", '  theme: "dark",', '  theme: "system",')
replace("src/lib/settings.ts", '  const [settings, setSettings] = useState<Settings>(loadSettings);', '''  const [settings, setSettings] = useState<Settings>(loadSettings);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === CONSOLE_SETTINGS_KEY || event.key === null) setSettings(loadSettings());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);''')
replace("src/lib/settings.ts", '  if (setting !== "system") return setting;', '''  if (setting !== "system") return setting;
  if (typeof window !== "undefined" && window.top && window.top !== window) {
    const scheme = window.top.getComputedStyle(window.top.document.documentElement).colorScheme;
    if (scheme === "dark" || scheme === "light") return scheme;
  }''')
replace("src/lib/settings.ts", '    const query = window.matchMedia?.(DARK_QUERY);\n    if (!query) return;', '''    if (window.top && window.top !== window) {
      const changed = () => setSystemDark(resolveTheme("system") === "dark");
      const observer = new MutationObserver(changed);
      observer.observe(window.top.document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      changed();
      return () => observer.disconnect();
    }
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;''')
replace("src/lib/api.ts", '  const response = await fetch("/api/machines", { signal });\n  if (!response.ok) throw await errorFrom("/api/machines", response);\n  return ((await response.json()) as { machines: Machine[] }).machines;', '''  const [snapshot, health] = await Promise.all([fetchSession(), fetchHealth()]);
  if (signal?.aborted) throw signal.reason;
  return [{ id: "local", name: agentName, kind: "local", enabled: true, state: "connected", error: null, snapshot, herdr: health.herdr }];''')
replace("src/lib/api.ts", '  return machinePath(machineId, `fs/file?${fileQuery(path, paneId)}${download ? "&download=1" : ""}`);', '  return scopedUrl(machinePath(machineId, `fs/file?${fileQuery(path, paneId)}${download ? "&download=1" : ""}`));')
replace("src/lib/api.ts", 'import { machinePath,', 'import { agentName, scopedUrl } from "../embedded.ts";\nimport { machinePath,')
replace("src/components/ChatView.tsx", 'import { createContext,', 'import { scopedUrl } from "../embedded.ts";\nimport { createContext,')
replace("src/components/ChatView.tsx", 'const Turn = memo(function Turn(', 'export { Turn as ArchivedTurn, formatTime as formatArchivedTime };\nconst Turn = memo(function Turn(')
for variable in ("image", "part"):
    expression = 'machinePath(machineId, `pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: ' + variable + '.ref }).toString()}`)'
    replace("src/components/ChatView.tsx", expression, 'scopedUrl(' + expression + ')')
replace("src/components/SettingsDialog.tsx", '  { id: "devices", icon: Smartphone },', '')
replace("src/components/SettingsDialog.tsx", '  { id: "remote", icon: Monitor },', '')
replace("src/components/SettingsDialog.tsx", 'Plus, Smartphone, SquareTerminal', 'Plus, SquareTerminal')
replace("src/components/SettingsDialog.tsx", '<UpdateControls updates={updates} bridgesFollow={bridgesFollow} />', '{false && <UpdateControls updates={updates} bridgesFollow={bridgesFollow} />}')
replace("src/components/SettingsDialog.tsx", '<HerdrUpdateControls enabled herdrVersion={herdrVersion} />', '{false && <HerdrUpdateControls enabled herdrVersion={herdrVersion} />}')
replace("src/components/SettingsDialog.tsx", '<TelemetryControls />', '{false && <TelemetryControls />}')
replace("src/components/CommandPalette.tsx", '{ id: "add-pc", label: t("Add PC"), icon: Monitor, run: actions.openAddPc },', '')
replace("src/components/CommandPalette.tsx", 'Minimize2, Monitor, PanelLeft', 'Minimize2, PanelLeft')
for old, new in (
    ("A finished agent you have opened here loses its dot, as herdr's own view would clear it; remembered per PC on this browser", "A finished agent you have opened here loses its dot, as herdr's own view would clear it; remembered per sandbox on this browser"),
    ("Turn this on if this PC also shows herdr in a terminal window. A second after you switch to another window, this tab only watches the pane, so herdr's window keeps the pane at its own size instead of this window's. Click the tab to type again. While it watches, the pane is drawn at herdr's size and may not fill this window.", "Turn this on when another terminal client uses Herdr in this sandbox. After you switch to another window, this tab watches the pane at that client's size. Click the tab to type again."),
    ("For this device. An alert waits a little first, and none comes when the pane changes meanwhile, as when you answer at the PC.", "For this device. Alerts wait briefly and are skipped when the pane changes meanwhile, such as when you answer in another Herdr client."),
    ("Beside Settings, how much of each plan the AI tools on the server's PC have used. Turning it on sends their sign-ins to each provider's usage endpoint; they are never refreshed here.", "Beside Settings, show plan usage for the agents in this sandbox. This queries each provider's usage endpoint with the agent's sign-in; credentials are never refreshed here."),
    ("herdr's integrations let it resume each agent's session after a restart. This page only reads them: run a command in a terminal on the PC herdr runs on, then reopen this page.", "Herdr integrations restore agent conversations after a restart. This page reads integration status; run commands in this sandbox's terminal, then reopen this page."),
    ("This PC's bridge does not offer agent integrations yet. It will after its next runtime update.", "This sandbox's bridge does not offer agent integrations."),
    ("Not found on this PC", "Not found in this sandbox"),
):
    replace("src/components/SettingsDialog.tsx", f't({json.dumps(old)})', json.dumps(new))
replace("src/components/SettingsDialog.tsx", 't(voice.source === "env" ? "OpenAI key set by HERDR_WEB_OPENAI_API_KEY" : "OpenAI key saved on this PC")', '(voice.source === "env" ? "OpenAI key set by HERDR_WEB_OPENAI_API_KEY" : "OpenAI key saved in this sandbox")')
replace("src/App.tsx", 't("This PC\'s bridge does not offer this yet")', '"This sandbox\'s bridge does not offer this yet"')
replace("server/index.ts", 'import { randomBytes }', 'import { idleState } from "./idle.ts";\nimport { workspaceDirectory } from "./workspace.ts";\nimport { randomBytes }')
replace("server/index.ts", '      if (pathname === "/api/session") {', '''      if (pathname === "/api/idle" && request.method === "GET") {
        try { return jsonResponse(await idleState()); }
        catch { return jsonResponse({ error: { code: "idle_unavailable", message: "Idle state is unavailable" } }, 503); }
      }
      if (pathname === "/api/session") {''')
replace("server/index.ts", 'if (import.meta.main) {', 'if (false) {')
replace("server/index.ts", '    return statSync(expanded).isDirectory() ? expanded : null;', '    return workspaceDirectory(expanded) && statSync(expanded).isDirectory() ? expanded : null;')
replace("server/index.ts", '  return { agent: pane.agent ?? pane.agent_session?.agent ?? null, cwd };', '  if (!workspaceDirectory(cwd)) throw new HerdrError("invalid_cwd", "Directory must be inside /workspace without symlinks");\n  return { agent: pane.agent ?? pane.agent_session?.agent ?? null, cwd };')
replace("server/index.ts", '      let { pathname } = url;', '''      let { pathname } = url;
      if (!isAuthenticated(request, token)) return unauthorizedJson();
      if (/^\\/api\\/(?:auth|devices|access|updates|herdr\\/update|telemetry|machines|push|voice|usage|plugin)(?:\\/|$)/.test(pathname)) {
        return jsonResponse({ error: { code: "not_found", message: "Managed by the panel" } }, 404);
      }
''')
replace("server/paste.ts", 'import { mkdirSync, writeFileSync } from "node:fs";', 'import { writeWorkspaceFile } from "./workspace.ts";')
replace("server/paste.ts", '  mkdirSync(directory, { recursive: true });', '')
replace("server/paste.ts", '  writeFileSync(path, data, { mode: 0o600 });', '  writeWorkspaceFile(path, data);')
# Read file bytes through the checked descriptor, including when a path is replaced later.
replace("server/file-view.ts", 'import { closeSync, openSync, readSync, statSync }', 'import { createReadStream, closeSync, fstatSync, openSync, readSync }')
replace("server/file-view.ts", 'import { filesNamed }', 'import { Readable } from "node:stream";\nimport { openWorkspace } from "./workspace.ts";\nimport { filesNamed }')
replace("server/file-view.ts", '    stat = statSync(path);', '    const fd = openWorkspace(path);\n    try { stat = fstatSync(fd); } finally { closeSync(fd); }')
replace("server/file-view.ts", '    fd = openSync(path, "r");', '    fd = openWorkspace(path);')
replace("server/file-view.ts", 'fstatSync, openSync, readSync', 'fstatSync, readSync')
replace("server/file-view.ts", '  const file = Bun.file(info.path, { type });\n  return new Response(file, { headers });', '''  const fd = openWorkspace(info.path);
  headers.set("content-type", type);
  headers.set("content-length", String(fstatSync(fd).size));
  return new Response(Readable.toWeb(createReadStream("", { fd, autoClose: true })) as unknown as ReadableStream, { headers });''')
replace("server/directories.ts", 'import { readdirSync, statSync }', 'import { closeSync, readdirSync, statSync }')
replace("server/directories.ts", 'import type { DirectoryListing }', 'import { openWorkspace } from "./workspace.ts";\nimport type { DirectoryListing }')
replace("server/directories.ts", '    if (!statSync(target).isDirectory()) return null;\n    entries = readdirSync(target, { withFileTypes: true });', '    const fd = openWorkspace(target, true);\n    try { entries = readdirSync(`/proc/self/fd/${fd}`, { withFileTypes: true }); } finally { closeSync(fd); }')
replace("server/directories.ts", '    if (!hidden && entry.name.startsWith(".")) continue;', '    if (entry.isSymbolicLink() || !hidden && entry.name.startsWith(".")) continue;')
replace("server/directories.ts", '    parent: parent === target ? null : parent,', '    parent: target === "/workspace" ? null : parent,')
replace("server/directories.ts", '    home,', '    home: "/workspace",')


replace("server/conversation.ts", 'transcriptGeneration(path, stat)', 'transcriptGeneration(realpathSync(path), stat)')

replace("server/codex-images.ts", 'import { constants, createReadStream }', 'import { closeSync, createReadStream, fstatSync, readSync }')
replace("server/codex-images.ts", 'import { open } from "node:fs/promises";', 'import { openWorkspace } from "./workspace.ts";')
replace("server/codex-images.ts", '''  const file = await open(resolve(cwd, value), constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally { await file.close(); }''', '''  const fd = openWorkspace(resolve(cwd, value));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    return bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, 0));
  } finally { closeSync(fd); }''')

replace("src/components/SettingsDialog.tsx", '  actions: AppActions;', '  actions?: AppActions;')
replace("src/main.tsx", '<ConsoleRoot>{reader !== null ? <FileReader target={reader} /> : <App />}</ConsoleRoot>', '{reader !== null ? <FileReader target={reader} /> : <ConsoleRoot><App /></ConsoleRoot>}')

replace("src/components/SettingsDialog.tsx", 'case "remote": return <RemotePcsPage actions={actions} pcSettings={pcSettings} pcSettingsError={pcSettingsError} onPcSettings={(patch) => void updatePcSettings(patch)} />;', 'case "remote": return actions ? <RemotePcsPage actions={actions} pcSettings={pcSettings} pcSettingsError={pcSettingsError} onPcSettings={(patch) => void updatePcSettings(patch)} /> : null;')

replace("src/App.tsx", "  const selectTargetRef = useRef(selectTarget); selectTargetRef.current = selectTarget;", "  const selectTargetRef = useRef(selectTarget); selectTargetRef.current = selectTarget;\n  useConsoleSession(snapshot, selectedPaneId, selectTarget, connected);")

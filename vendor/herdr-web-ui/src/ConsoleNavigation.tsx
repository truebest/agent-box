import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Box, ChevronDown, ChevronRight, Menu, Monitor, PanelLeft, Server, Settings, X } from "lucide-react";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { sidebarAgents } from "./lib/sidebarAgents.ts";
import { paneStatus } from "./lib/status.ts";
import { AgentMark } from "./components/AgentMark.tsx";
import { SettingsDialog } from "./components/SettingsDialog.tsx";
import { useUpdates } from "./lib/updates.ts";
import { agentUID, initializeConsole } from "./embedded.ts";
import { SidebarResizer } from "./components/SidebarResizer.tsx";
import { storedSidebarWidth } from "./lib/sidebarWidth.ts";
import { useSettings } from "./lib/settings.ts";
import { useMediaQuery } from "./lib/useMediaQuery.ts";
import { watchDrawerSwipe } from "./lib/edgeSwipe.ts";
import "./components/Sidebar.css";
import "./components/AgentSidebar.css";
import "./components/Machines.css";
import "./ConsoleNavigation.css";

type Host = { id: string; name: string };
type Sandbox = { host: string; name: string; uid: string; kind: string; sandbox: string; runner: string; worker: string; error?: string };
type Worker = { host: string; id: string; name: string; state: string; agents: number; capacity: Record<string, string>; allocated: Record<string, string> };
type ConsoleState = {
  pool: { enabled: boolean; hosts: Host[]; workers: Worker[]; agents: Sandbox[] } | null;
  uid: string; host: string; worker: string; error: string; connectionError: string; connectedUID: string; pending: boolean; drawerOpen?: boolean; sidebarCollapsed?: boolean; wideScreen?: boolean;
};
const ConsoleContext = createContext<ConsoleState | null>(null);
const initialSession = initializeConsole();

export function command(type: string, fields: Record<string, unknown> = {}): void {
  window.parent.postMessage({ type, ...fields }, window.location.origin);
}

export function ConsoleRoot({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConsoleState | null>(null);
  const { settings, resolvedTheme } = useSettings();
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    let stopped = false;
    void initialSession.then(() => { if (!stopped) setInitialized(true); });
    return () => { stopped = true; };
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.source === window.parent && event.data?.type === "console-state") { setState(event.data as ConsoleState); if (agentUID) document.documentElement.dataset.consoleWide = String(Boolean(event.data.wideScreen)); }
    };
    window.addEventListener("message", receive);
    let appearanceTimer = 0;
    const report = () => {
      window.clearTimeout(appearanceTimer);
      appearanceTimer = window.setTimeout(() => {
        const style = getComputedStyle(document.body);
        command("console-ready", { background: style.backgroundColor, color: style.color, colorScheme: getComputedStyle(document.documentElement).colorScheme });
      }, 0);
    };
    const observer = new MutationObserver(report);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-palette"] });
    report();
    return () => { window.removeEventListener("message", receive); observer.disconnect(); window.clearTimeout(appearanceTimer); };
  }, [resolvedTheme, settings.theme, settings.palette, settings.density]);
  return <ConsoleContext.Provider value={state}>
    {!agentUID ? <ConsoleShell /> : initialized && state?.uid === agentUID && state.connectedUID === agentUID ? children : <ConsoleSessionPlaceholder initializing={!initialized} />}
  </ConsoleContext.Provider>;
}

type ConsoleAgent = { pane: string; name: string; kind: string; status: string };
type ChooseSandbox = (sandbox: Sandbox, pane?: string) => void;
type SelectedPane = { uid: string; pane: string };

function consoleAgents(snapshot: SessionSnapshot): ConsoleAgent[] {
  return sidebarAgents(snapshot).map(entry => ({
    pane: entry.pane.pane_id,
    name: entry.agent?.name?.trim() || entry.pane.label?.trim() || entry.agent?.title?.trim() || entry.pane.title?.trim() || entry.canonicalAgent || entry.pane.pane_id,
    kind: entry.canonicalAgent ?? "",
    status: paneStatus(entry.pane),
  }));
}

export function useConsoleSession(snapshot: SessionSnapshot | null, selectedPaneId: string | null, selectTarget: (machine: string, pane: string | null) => void) {
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent || event.data?.type !== "console-select-pane" || event.data.uid !== agentUID) return;
      if (typeof event.data.pane === "string" && snapshot && consoleAgents(snapshot).some(agent => agent.pane === event.data.pane)) selectTarget("local", event.data.pane);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [snapshot, selectTarget]);
  useEffect(() => {
    if (snapshot) command("console-pane-state", { uid: agentUID, pane: selectedPaneId, panes: consoleAgents(snapshot).map(agent => agent.pane) });
  }, [snapshot, selectedPaneId]);
}

export function ConsoleSidebar({ onSettings, onSelect, selectedPane }: { onSettings?: () => void; onSelect: ChooseSandbox; selectedPane: SelectedPane }) {
  const state = useContext(ConsoleContext);
  const pool = state?.pool;
  return <div className="sidebar-shell console-sidebar" aria-label="Hosts, workers, sandboxes and agents">
    <div className="console-host-list" aria-label="Hosts">
      {!pool && <p className="tree-state" role="status">Loading hosts…</p>}
      {pool?.hosts.map(host => <ConsoleHost key={host.id} host={host} onSelect={onSelect} selectedPane={selectedPane} />)}
      {state?.error && <div className="error-state" role="alert"><p>{state.error}</p><button className="btn" onClick={() => command("console-retry")}>Retry</button></div>}
    </div>
    {onSettings && <footer className="sidebar-footer"><button className="btn btn-ghost sidebar-footer-action" onClick={onSettings}><Settings aria-hidden="true" />Settings</button></footer>}
  </div>;
}

function ConsoleSandbox({ sandbox, onSelect, selectedPane, visible }: { sandbox: Sandbox; onSelect: ChooseSandbox; selectedPane: SelectedPane; visible: boolean }) {
  const state = useContext(ConsoleContext);
  const [expanded, setExpanded] = useState(() => {
    try { return state?.uid === sandbox.uid || localStorage.getItem("pvm-console:sandbox-expanded:" + sandbox.uid) === "1"; } catch { return state?.uid === sandbox.uid; }
  });
  const [agents, setAgents] = useState<ConsoleAgent[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => { if (state?.uid === sandbox.uid) setExpanded(true); }, [state?.uid, sandbox.uid]);
  useEffect(() => { try { localStorage.setItem("pvm-console:sandbox-expanded:" + sandbox.uid, expanded ? "1" : "0"); } catch {} }, [sandbox.uid, expanded]);
  const base = "/api/console/agents/" + encodeURIComponent(sandbox.name) + "/" + encodeURIComponent(sandbox.uid);
  const connected = state?.connectedUID === sandbox.uid;
  useEffect(() => {
    if (!visible || !expanded || sandbox.sandbox !== "RUNNING") { setAgents([]); setError(""); setLoading(false); return; }
    const controller = new AbortController();
    let timer = 0;
    setLoading(true);
    const poll = async () => {
      if (document.visibilityState === "hidden") { timer = window.setTimeout(() => void poll(), 5000); return; }
      try {
        const response = await fetch(base + "/bridge/api/session", { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
        if (!response.ok) throw new Error("Open this sandbox to connect its agents.");
        const { snapshot } = await response.json() as { snapshot: SessionSnapshot };
        if (!snapshot || ![snapshot.panes, snapshot.agents, snapshot.workspaces, snapshot.tabs].every(Array.isArray)) throw new Error("Agent list is unavailable.");
        const next = consoleAgents(snapshot);
        if (!controller.signal.aborted) { setAgents(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next); setError(""); }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) { setLoading(false); timer = window.setTimeout(() => void poll(), 5000); }
      }
    };
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [base, sandbox.sandbox, expanded, visible, connected, retry]);
  const choose = (pane?: string) => { setExpanded(true); onSelect(sandbox, pane); };
  const label = sandbox.sandbox[0] + sandbox.sandbox.slice(1).toLowerCase();
  const labels: Record<string, string> = { idle: "Ready", working: "Working", blocked: "Needs input", done: "Done", waiting: "Waiting for background work", unknown: "Status unavailable" };
  return <section className="console-sandbox-branch" data-console-sandbox={sandbox.uid} aria-label={"Sandbox " + sandbox.name}>
    <div className={"console-sandbox-header" + (state?.uid === sandbox.uid ? " is-selected" : "")}>
      <button type="button" className="agent-row console-sandbox" aria-pressed={state?.uid === sandbox.uid} data-sandbox-uid={sandbox.uid} onClick={() => choose()}>
        <span className="sidebar-mark" aria-hidden="true"><Box /></span>
        <span className="agent-copy"><span className="agent-title">{sandbox.name}</span><span className="agent-context" data-sandbox-state={sandbox.sandbox}>{label}</span></span>
      </button>
      <button type="button" className="sidebar-row-action" aria-label={(expanded ? "Collapse " : "Expand ") + sandbox.name} aria-expanded={expanded} aria-controls={"console-sandbox-" + sandbox.uid} onClick={() => setExpanded(value => !value)}>{expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</button>
    </div>
    <div id={"console-sandbox-" + sandbox.uid} className="console-sandbox-contents" hidden={!expanded}>
      {sandbox.sandbox === "RUNNING" ? <>
        <ul className="agent-list" aria-label="Agents">{agents.map(agent => {
          const status = error ? "unknown" : agent.status;
          return <li key={agent.pane} className={"agent-item" + (selectedPane.uid === sandbox.uid && selectedPane.pane === agent.pane ? " is-selected" : "")}>
            <button type="button" className="agent-row console-agent" data-agent-pane={agent.pane} aria-pressed={selectedPane.uid === sandbox.uid && selectedPane.pane === agent.pane} onClick={() => choose(agent.pane)}>
              <span className="sidebar-mark" aria-hidden="true"><AgentMark agent={agent.kind} size={18} /></span>
              <span className="agent-copy"><span className="agent-title">{agent.name}</span><span className="agent-context">{agent.kind || "Agent"} · {agent.pane}</span></span>
              <span className="agent-row-status"><span className="console-agent-status" data-status={status} role="status" aria-label={labels[status] ?? labels.unknown} title={labels[status] ?? labels.unknown}><span className="sidebar-status-dot" aria-hidden="true" /></span></span>
            </button>
          </li>;
        })}</ul>
        {loading && agents.length === 0 && <p className="agent-empty" role="status">Loading agents…</p>}
        {error && <div className="console-roster-error" role="status"><p>{error}</p><button type="button" className="btn btn-ghost" onClick={() => setRetry(value => value + 1)}>Retry agents</button></div>}
        {!loading && !error && agents.length === 0 && <p className="agent-empty" role="status">No agents running in this sandbox.</p>}
      </> : <p className="agent-empty" role="status">{label}</p>}
      {sandbox.error && <p className="console-roster-error" role="status">{sandbox.error}</p>}
    </div>
  </section>;
}

function ConsoleHost({ host, onSelect, selectedPane }: { host: Host; onSelect: ChooseSandbox; selectedPane: SelectedPane }) {
  const state = useContext(ConsoleContext);
  const pool = state?.pool;
  const worker = state?.host === host.id ? state.worker : "";
  const sandboxes = pool?.agents.filter(sandbox => sandbox.host === host.id) ?? [];
  const workers = pool?.workers.filter(item => item.host === host.id) ?? [];
  const unassigned = sandboxes.filter(sandbox => sandbox.sandbox === "SUSPENDED" || !workers.some(item => item.id === sandbox.worker));
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem("herdr-web-ui:pc-collapsed:" + host.id) === "1"; } catch { return false; } });
  const toggle = () => {
    setCollapsed(!collapsed);
    try { localStorage.setItem("herdr-web-ui:pc-collapsed:" + host.id, collapsed ? "0" : "1"); } catch {}
  };
  const rows = (items: Sandbox[]) => items.map(sandbox => <ConsoleSandbox key={sandbox.uid} sandbox={sandbox} onSelect={onSelect} selectedPane={selectedPane} visible={!collapsed} />);
  return <section className={"machine-group" + (sandboxes.some(sandbox => sandbox.uid === state?.uid) ? " is-current" : "")} data-host-id={host.id} aria-label={"Host " + host.name}>
    <header className="machine-header">
      <div className="machine-title"><span className="sidebar-mark" aria-hidden="true"><Monitor /></span><span className="machine-name">{host.name}</span><span className="machine-kind">Host</span></div>
      <button type="button" className="sidebar-row-action machine-toggle" aria-expanded={!collapsed} aria-label={(collapsed ? "Expand " : "Collapse ") + host.name} aria-controls={"console-host-" + encodeURIComponent(host.id)} onClick={toggle}>{collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button>
    </header>
    <div id={"console-host-" + encodeURIComponent(host.id)} hidden={collapsed}>
      <section className="console-workers" aria-label="Workers">
        <div className="console-section-head"><h2>Workers</h2><button type="button" className="btn btn-ghost console-all-workers" aria-pressed={!worker} onClick={() => command("console-worker", { host: host.id, worker: "" })}>All workers</button></div>
        {workers.filter(item => !worker || item.id === worker).map(item => {
          const assigned = sandboxes.filter(sandbox => sandbox.sandbox !== "SUSPENDED" && sandbox.worker === item.id);
          return <section className="console-worker-branch" key={item.id} data-console-worker={item.id} aria-label={"Worker " + item.name}>
            <button type="button" className="console-worker" data-worker-id={item.id} aria-pressed={worker === item.id} onClick={() => command("console-worker", { host: host.id, worker: item.id })}>
              <span className="sidebar-mark" aria-hidden="true"><Server /></span>
              <span className="agent-copy"><span className="console-worker-name">{item.name}</span><span className="agent-context" role="status">{item.state} · {item.agents} {item.agents === 1 ? "sandbox" : "sandboxes"}</span><span className="agent-context">CPU {item.allocated.cpu}/{item.capacity.cpu} · RAM {item.allocated.memory}/{item.capacity.memory}</span></span>
            </button>
            <div className="console-worker-sandboxes" role="group" aria-label="Sandboxes">{rows(assigned)}{assigned.length === 0 && <p className="agent-empty" role="status">No sandboxes on this worker.</p>}</div>
          </section>;
        })}
      </section>
      {unassigned.length > 0 && <section className="console-sandboxes" aria-label="Unassigned sandboxes"><div className="console-section-head"><h2>Unassigned sandboxes</h2></div>{rows(unassigned)}</section>}
      {pool && sandboxes.length === 0 && <p className="agent-empty" role="status">No sandboxes.</p>}
    </div>
  </section>;
}

export function useConsoleNavigation() {
  const state = useContext(ConsoleContext);
  const drawerOpen = Boolean(state?.drawerOpen), sidebarCollapsed = Boolean(state?.sidebarCollapsed);
  return {
    drawerOpen, sidebarCollapsed,
    setDrawerOpen: (value: boolean | ((current: boolean) => boolean)) => command("console-drawer", { open: String(typeof value === "function" ? value(drawerOpen) : value) }),
    setSidebarCollapsed: (value: boolean | ((current: boolean) => boolean)) => command("console-sidebar", { collapsed: String(typeof value === "function" ? value(sidebarCollapsed) : value) }),
  };
}

function ConsoleShell() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const updates = useUpdates(false);
  const state = useContext(ConsoleContext);
  const selected = state?.pool?.agents.find(agent => agent.uid === state.uid);
  const frame = useRef<HTMLIFrameElement>(null);
  const [selectedPane, setSelectedPane] = useState<SelectedPane>({ uid: "", pane: "" });
  const [paneError, setPaneError] = useState("");
  const pendingPane = useRef<SelectedPane | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(storedSidebarWidth);
  const wideScreen = useMediaQuery("(min-width: 769px)");
  const drawer = useRef(drawerOpen); drawer.current = drawerOpen;
  const choose: ChooseSandbox = (sandbox, pane) => {
    pendingPane.current = pane ? { uid: sandbox.uid, pane } : null;
    setPaneError(""); setDrawerOpen(false);
    command("console-select", { host: sandbox.host, uid: sandbox.uid });
    if (pane && state?.uid === sandbox.uid && state.connectedUID === sandbox.uid && frame.current?.dataset.ready) {
      frame.current.contentWindow?.postMessage({ type: "console-select-pane", uid: sandbox.uid, pane }, window.location.origin);
    }
  };
  const src = useMemo(() => {
    if (selected?.sandbox !== "RUNNING") return null;
    const url = "/api/console/agents/" + encodeURIComponent(selected.name) + "/" + encodeURIComponent(selected.uid) + "/ui/";
    const target = pendingPane.current;
    return target?.uid === selected.uid ? url + "?" + new URLSearchParams({ pane: target.pane }).toString() : url;
  }, [selected?.uid, selected?.name, selected?.sandbox]);
  const send = () => frame.current?.contentWindow?.postMessage({ ...state, drawerOpen, sidebarCollapsed, wideScreen }, window.location.origin);
  useEffect(() => watchDrawerSwipe(() => drawer.current, setDrawerOpen), []);
  useEffect(() => { setDrawerOpen(false); setPaneError(""); setSelectedPane({ uid: state?.uid ?? "", pane: "" }); }, [state?.uid]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      const message = event.data;
      if (message?.type === "console-ready") {
        if (frame.current) frame.current.dataset.ready = "true";
        send();
      }
      if (message?.type === "console-auth-required" && state && message.uid === state.uid) command("console-auth-required");
      if (message?.type === "console-pane-state" && state && message.uid === state.uid && Array.isArray(message.panes) && message.panes.length <= 10000 && message.panes.every((pane: unknown) => typeof pane === "string")) {
        const pane = typeof message.pane === "string" && message.panes.includes(message.pane) ? message.pane : "";
        setSelectedPane(previous => previous.uid === state.uid && previous.pane === pane ? previous : { uid: state.uid, pane });
        const target = pendingPane.current;
        if (target?.uid === state.uid) {
          if (pane === target.pane) pendingPane.current = null;
          else if (message.panes.includes(target.pane)) frame.current?.contentWindow?.postMessage({ type: "console-select-pane", uid: state.uid, pane: target.pane }, window.location.origin);
          else { pendingPane.current = null; setPaneError("This agent is no longer available. Select another agent."); }
        }
      }
      if (message?.type === "console-drawer" && ["true", "false"].includes(message.open)) setDrawerOpen(message.open === "true");
      if (message?.type === "console-sidebar" && ["true", "false"].includes(message.collapsed)) setSidebarCollapsed(message.collapsed === "true");
      if (message?.type === "console-retry") command("console-retry");
    };
    window.addEventListener("message", receive);
    send();
    return () => window.removeEventListener("message", receive);
  }, [state, drawerOpen, sidebarCollapsed, wideScreen]);
  return <div className={`app console-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`} style={sidebarWidth === null ? undefined : { "--sidebar-user-w": `${sidebarWidth}px` } as CSSProperties}>
    <div className="app-body">
      <aside id="workspace-drawer" className={`sidebar${drawerOpen ? " is-open" : ""}`}>
        <ConsoleSidebar onSelect={choose} selectedPane={selectedPane} onSettings={() => { if (src) frame.current?.contentWindow?.postMessage({ type: "console-settings" }, window.location.origin); else setSettingsOpen(true); }} />
        <SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} />
      </aside>
      <div className={`scrim${drawerOpen ? " is-open" : ""}`} aria-hidden="true" onClick={() => setDrawerOpen(false)} />
      <div className="console-session">
        {paneError && <div className="error-state console-pane-error" role="alert"><p>{paneError}</p></div>}
        {src ? <>
          <div className="terminal-placeholder"><div className="terminal-placeholder-inner console-placeholder" role="status">Opening {selected?.name}…</div></div>
          <iframe key={src} ref={frame} className="console-session-frame" title={`${selected?.name} Superterminal`} src={src} onLoad={send} />
        </> : <div className="app">
          <header className="app-header">
            <button className="icon-button drawer-toggle" aria-label={drawerOpen ? "Close navigation" : "Open navigation"} aria-expanded={drawerOpen} aria-controls="workspace-drawer" onClick={() => setDrawerOpen(open => !open)}>{drawerOpen ? <X /> : <Menu />}</button>
            <button className="icon-button sidebar-toggle" aria-label={sidebarCollapsed ? "Show navigation" : "Hide navigation"} aria-pressed={!sidebarCollapsed} onClick={() => setSidebarCollapsed(collapsed => !collapsed)}><PanelLeft /></button>
            {selected && <span className="brand">{selected.name}</span>}
          </header>
          <main className="terminal-host"><ConsolePlaceholder /></main>
        </div>}
      </div>
    </div>
    {settingsOpen && <SettingsDialog open onClose={() => setSettingsOpen(false)} updates={updates} auth={null} herdrVersion={null} onEnableNotifications={async () => typeof Notification !== "undefined" && await Notification.requestPermission() === "granted"} />}
  </div>;
}

function ConsolePlaceholder({ initializing = false }: { initializing?: boolean }) {
  const state = useContext(ConsoleContext);
  const selected = state?.pool?.agents.find(agent => agent.uid === state.uid);
  return <div className="terminal-placeholder"><div className="terminal-placeholder-inner console-placeholder">
    <p role="status">{!state?.pool ? "Loading hosts…" : !selected ? state.uid ? "This sandbox no longer exists. Select a sandbox." : "Select a sandbox to open its existing session." : state.pending || initializing ? selected.sandbox === "SUSPENDED" ? "Resuming…" : "Connecting to the existing session…" : `Sandbox: ${selected.sandbox}`}</p>
    {selected?.sandbox === "SUSPENDED" && <button className="btn" disabled={state?.pending} onClick={() => command("console-resume", { host: selected.host, uid: selected.uid })}>{state?.pending ? "Resuming…" : "Resume"}</button>}
    {state?.connectionError && <><p role="alert">{state.connectionError}</p><button className="btn" disabled={state.pending} onClick={() => command("console-retry")}>Reconnect</button></>}
  </div></div>;
}

function ConsoleSessionPlaceholder({ initializing }: { initializing: boolean }) {
  const { drawerOpen, setDrawerOpen, sidebarCollapsed, setSidebarCollapsed } = useConsoleNavigation();
  return <div className="app">
    <header className="app-header">
      <button className="icon-button drawer-toggle" aria-label={drawerOpen ? "Close navigation" : "Open navigation"} aria-expanded={drawerOpen} onClick={() => setDrawerOpen(open => !open)}>{drawerOpen ? <X /> : <Menu />}</button>
      <button className="icon-button sidebar-toggle" aria-label={sidebarCollapsed ? "Show navigation" : "Hide navigation"} aria-pressed={!sidebarCollapsed} onClick={() => setSidebarCollapsed(collapsed => !collapsed)}><PanelLeft /></button>
    </header>
    <main className="terminal-host"><ConsolePlaceholder initializing={initializing} /></main>
  </div>;
}

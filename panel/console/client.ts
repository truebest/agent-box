// Each iframe owns an immutable agent URL and storage namespace, including async work.
export const agentUID = window.location.pathname.split("/")[5] ?? "";
if (agentUID && typeof document !== "undefined") document.documentElement.dataset.consoleSession = "true";
export const agentName = agentUID ? window.location.pathname.split("/")[4] ?? "Agent" : "";
export const bridgeBase = agentUID ? window.location.pathname.replace(/\/ui\/$/, "/bridge") : "";
if (!/^\/api\/console\/(?:ui\/|agents\/[^/]+\/[^/]+\/ui\/)$/.test(window.location.pathname)) {
  throw new Error("Superterminal requires a sandbox UID");
}

// Allow CONNECT routing plus the bridge's ten-second Herdr RPC window after restore.
export const SESSION_REQUEST_TIMEOUT_MS = 15000;

export function scopedUrl(value: string | URL): string {
  const url = new URL(value, window.location.href);
  if (agentUID && url.origin === window.location.origin && !url.pathname.startsWith("/api/console/") && !url.pathname.startsWith(bridgeBase + "/") && (url.pathname.startsWith("/api/") || url.pathname === "/ws")) {
    url.pathname = bridgeBase + url.pathname;
  }
  return url.href;
}

const originalFetch = window.fetch.bind(window);
const browserLocalStorage = (() => { try { return window.localStorage; } catch { return null; } })();
function currentLogoutEpoch(): string | null {
  try { return browserLocalStorage?.getItem("agent-box:logout") ?? null; } catch { return null; }
}
const logoutEpoch = currentLogoutEpoch();
const draftKey = /(?:^|:)herdr-web-ui:(?:composer-draft|composer-sending|terminal-draft|terminal-line|pending):/;
function authenticationRequired(): void {
  window.parent.postMessage({ type: "console-auth-required", uid: agentUID }, window.location.origin);
}
function checkAuthentication(): void {
  void originalFetch("/api/auth/session", { credentials: "same-origin", signal: AbortSignal.timeout(5000) })
    .then(response => response.ok ? response.json() : null)
    .then(session => { if (session?.authenticated === false) authenticationRequired(); }).catch(() => {});
}
window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await originalFetch(input instanceof Request ? new Request(scopedUrl(input.url), input) : scopedUrl(input), init);
  if (response.status === 401) checkAuthentication();
  return response;
}, window.fetch);
const OriginalWebSocket = window.WebSocket;
window.WebSocket = class extends OriginalWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    const target = new URL(url, window.location.href);
    if (agentUID && target.host === window.location.host && target.pathname === "/ws") target.pathname = bridgeBase + "/ws";
    super(target, protocols);
    this.addEventListener("close", checkAuthentication);
  }
};

export const CONSOLE_SETTINGS_KEY = "pvm-console:settings";
const NATIVE_SETTINGS_KEY = "herdr-web-ui:settings";

export function scopedStorage(storage: Storage, prefix: string): Storage {
  const storageKey = (key: string) => key === NATIVE_SETTINGS_KEY ? CONSOLE_SETTINGS_KEY : prefix + key;
  const keys = () => Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => key !== null && key !== NATIVE_SETTINGS_KEY && (key === CONSOLE_SETTINGS_KEY || key.startsWith(prefix)));
  return {
    get length() { return keys().length; },
    key: (index) => { const key = keys()[index]; return key === CONSOLE_SETTINGS_KEY ? NATIVE_SETTINGS_KEY : key?.slice(prefix.length) ?? null; },
    getItem: (key) => storage.getItem(storageKey(key)),
    setItem: (key, value) => {
      if (draftKey.test(key) && currentLogoutEpoch() !== logoutEpoch) return;
      storage.setItem(storageKey(key), value);
    },
    removeItem: (key) => storage.removeItem(storageKey(key)),
    clear: () => keys().forEach((key) => storage.removeItem(key)),
  };
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  try { Object.defineProperty(window, name, { value: scopedStorage(window[name], agentUID ? `pvm-console:${agentUID}:` : "") }); } catch { /* private mode */ }
}

export async function initializeConsole(): Promise<void> {
  if (!agentUID) return;
  try {
    if (window.localStorage.getItem("herdr-web-ui:selection") || window.sessionStorage.getItem("herdr-web-ui:selection")) return;
    const response = await originalFetch(bridgeBase.replace(/\/bridge$/, "/session"), { credentials: "same-origin", signal: AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS) });
    if (!response.ok) return;
    const session = await response.json() as { pane_id?: string };
    if (session.pane_id) window.localStorage.setItem("herdr-web-ui:selection", JSON.stringify({ machine_id: "local", pane_id: session.pane_id }));
  } catch { /* keep the native selection if the session probe is unavailable */ }
}

// Embedded builds use panel authentication and never register a service worker.
export const EMBEDDED = true;

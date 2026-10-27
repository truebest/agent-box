import { expect, test } from "bun:test";

function storage(): Storage {
  const records = new Map<string, string>();
  return {
    get length() { return records.size; },
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => { records.set(key, value); },
    removeItem: (key) => { records.delete(key); },
    key: (index) => [...records.keys()][index] ?? null,
    clear: () => records.clear(),
  };
}

test("agent scopes keep identical pane IDs, URLs and asynchronous work separate", async () => {
  const local = storage();
  const fetched: string[] = [];
  const sockets: string[] = [];
  const location = { pathname: "/api/console/agents/first/uid-one/ui/", href: "https://panel.test/api/console/agents/first/uid-one/ui/", origin: "https://panel.test", host: "panel.test" };
  Object.assign(globalThis, { window: {
    location, localStorage: local, sessionStorage: storage(),
    fetch: async (url: string) => { fetched.push(url); return new Response("ok"); },
    WebSocket: class { constructor(url: URL) { sockets.push(url.href); } addEventListener() {} },
  } });
  const { scopedStorage, scopedUrl } = await import("./embedded.ts");
  const one = window.localStorage;
  const two = scopedStorage(local, "pvm-console:uid-two:");
  one.setItem("draft:w1:p1", "one");
  two.setItem("draft:w1:p1", "two");
  expect(one.getItem("draft:w1:p1")).toBe("one");
  expect(two.getItem("draft:w1:p1")).toBe("two");
  expect(one.key(0)).toBe("draft:w1:p1");
  expect(one.length).toBe(1);
  two.clear();
  expect(one.getItem("draft:w1:p1")).toBe("one");
  expect(two.length).toBe(0);
  const settingsKey = "herdr-web-ui:settings";
  one.setItem(settingsKey, JSON.stringify({ theme: "system", terminalFontSize: 17 }));
  expect(two.getItem(settingsKey)).toBe(one.getItem(settingsKey));
  expect(local.getItem("pvm-console:settings")).toBe(one.getItem(settingsKey));
  expect(local.getItem("pvm-console:uid-one:" + settingsKey)).toBe(null);
  expect(one.length).toBe(2);
  expect(two.key(0)).toBe(settingsKey);
  two.setItem(settingsKey, JSON.stringify({ theme: "dark", terminalFontSize: 19 }));
  expect(one.getItem(settingsKey)).toBe(two.getItem(settingsKey));
  expect(one.getItem("draft:w1:p1")).toBe("one");
  const file = scopedUrl("/api/fs/file?path=/workspace/test");
  expect(scopedUrl(file)).toBe(file);
  await window.fetch("/api/session");
  new window.WebSocket("wss://panel.test/ws");
  location.pathname = "/api/console/agents/second/uid-two/ui/";
  await window.fetch("/api/session");
  expect(fetched).toEqual(["https://panel.test/api/console/agents/first/uid-one/bridge/api/session", "https://panel.test/api/console/agents/first/uid-one/bridge/api/session"]);
  expect(sockets).toEqual(["wss://panel.test/api/console/agents/first/uid-one/bridge/ws"]);
  local.setItem("agent-box:logout", "another-login");
  one.setItem("herdr-web-ui:composer-draft:local:w1:p1", "must not return after logout");
  expect(local.getItem("pvm-console:uid-one:herdr-web-ui:composer-draft:local:w1:p1")).toBe(null);
  one.setItem(settingsKey, '{"theme":"light"}');
  expect(local.getItem("pvm-console:settings")).toBe('{"theme":"light"}');
});

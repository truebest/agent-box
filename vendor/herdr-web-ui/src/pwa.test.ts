import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const publicDir = join(import.meta.dir, "..", "public");

/** Runs public/sw.js against a stand-in `self` and returns its fetch listener. */
function serviceWorkerFetch(): (request: { method: string; url: string; mode: string }) => boolean {
  const listeners = new Map<string, (event: unknown) => void>();
  const self = { location: { origin: "https://app.test" }, addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener) };
  const caches = { match: async () => new Response("cached"), open: async () => ({ match: async () => undefined, put: async () => undefined }) };
  const fetch = async () => new Response("network");
  new Function("self", "caches", "fetch", readFileSync(join(publicDir, "sw.js"), "utf8"))(self, caches, fetch);
  const listener = listeners.get("fetch")!;
  return (request) => {
    let answered = false;
    listener({ request, respondWith: () => { answered = true; }, waitUntil: () => undefined });
    return answered;
  };
}

describe("installed app", () => {
  it("leaves the screen orientation to the device's rotation lock", () => {
    // Chrome for Android before mid-2026 ran an `orientation: "any"` app full-sensor,
    // rotating it even with auto-rotate off; no orientation follows the system setting
    const manifest = JSON.parse(readFileSync(join(publicDir, "manifest.webmanifest"), "utf8")) as Record<string, unknown>;
    expect(manifest["orientation"]).toBeUndefined();
  });

  it("rereads the web manifest from the network while static assets stay cache-first", () => {
    const answers = serviceWorkerFetch();
    const get = (path: string) => ({ method: "GET", url: `https://app.test${path}`, mode: "no-cors" });
    expect(answers(get("/manifest.webmanifest"))).toBe(false);
    expect(answers(get("/icons/icon-192.png?v=ram1"))).toBe(true);
    expect(answers(get("/assets/index-abc123.js"))).toBe(true);
  });
});

type WorkerRequest = { method: string; url: string; mode: string };

/** public/sw.js over a stand-in CacheStorage and a network that can be cut. */
function serviceWorker(stored: Record<string, Record<string, string>>) {
  const origin = "https://app.test";
  const keyOf = (request: string | WorkerRequest): string => (typeof request === "string" ? request : request.url.slice(origin.length));
  const store = new Map(Object.entries(stored).map(([name, entries]) => [name, new Map(Object.entries(entries))]));
  const cacheOf = (entries: Map<string, string>) => ({
    match: async (request: string | WorkerRequest) => (entries.has(keyOf(request)) ? new Response(entries.get(keyOf(request))) : undefined),
    put: async (request: string | WorkerRequest, response: Response) => { await disk.ready; entries.set(keyOf(request), await response.text()); },
  });
  const caches = {
    keys: async () => [...store.keys()],
    delete: async (name: string) => store.delete(name),
    open: async (name: string) => {
      if (!store.has(name)) store.set(name, new Map());
      return cacheOf(store.get(name)!);
    },
    // every cache, oldest first, as the browser's does
    match: async (request: string | WorkerRequest) => {
      for (const entries of store.values()) if (entries.has(keyOf(request))) return new Response(entries.get(keyOf(request)));
      return undefined;
    },
  };
  /** `ready` is awaited by every write: a test replaces it to hold the cache back. */
  const disk = { ready: Promise.resolve() as Promise<void> };
  const network = { online: true, shell: "shell", status: 200, fetched: [] as string[] };
  const fetch = async (request: WorkerRequest) => {
    if (!network.online) throw new TypeError("Failed to fetch");
    network.fetched.push(keyOf(request));
    const response = request.mode === "navigate" ? new Response(network.shell, { status: network.status }) : new Response(`network ${keyOf(request)}`);
    // a same-origin answer, which is all the worker keeps
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };
  const listeners = new Map<string, (event: unknown) => void>();
  const self = { location: { origin }, clients: { claim: async () => undefined }, skipWaiting: () => undefined, addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener) };
  new Function("self", "caches", "fetch", readFileSync(join(publicDir, "sw.js"), "utf8"))(self, caches, fetch);
  /** The answer as the page gets it, and `kept`: everything the worker asked to stay alive for. */
  const fire = (type: string, event: Record<string, unknown> = {}): { answer: Promise<Response> | undefined; kept: () => Promise<void> } => {
    let answer: Promise<Response> | undefined;
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({ ...event, respondWith: (response: Promise<Response>) => { answer = response; }, waitUntil: (work: Promise<unknown>) => { waits.push(work); } });
    // a wait may be added while the answer is made, so the list is read again until it is still
    const kept = async (): Promise<void> => { for (let seen = -1; seen !== waits.length;) { seen = waits.length; await Promise.all(waits); } };
    return { answer, kept };
  };
  const dispatch = async (type: string, event: Record<string, unknown> = {}): Promise<Response | undefined> => {
    const { answer, kept } = fire(type, event);
    const response = await answer;
    await kept();
    return response;
  };
  const text = async (request: WorkerRequest): Promise<string | null> => {
    // a rejected answer is what the page sees as a network error
    const response = await dispatch("fetch", { request }).catch(() => undefined);
    const body = response === undefined || response.type === "error" ? null : await response.text();
    // an asset is kept without holding its answer back
    await new Promise((done) => setTimeout(done, 0));
    return body;
  };
  return {
    network,
    disk,
    fire: (path = "/") => fire("fetch", { request: { method: "GET", url: `${origin}${path}`, mode: "navigate" } }),
    names: () => [...store.keys()],
    entries: (name: string) => [...(store.get(name)?.keys() ?? [])],
    update: async () => { await dispatch("install"); await dispatch("activate"); },
    navigate: (path = "/") => text({ method: "GET", url: `${origin}${path}`, mode: "navigate" }),
    get: (path: string) => text({ method: "GET", url: `${origin}${path}`, mode: "no-cors" }),
    /** an asset request as fired, its answer apart from what the worker keeps alive for it */
    ask: (path: string) => fire("fetch", { request: { method: "GET", url: `${origin}${path}`, mode: "no-cors" } }),
  };
}

describe("a service worker under a new cache name", () => {
  const sw = readFileSync(join(publicDir, "sw.js"), "utf8");
  const current = /const CACHE_NAME = "([^"]+)"/.exec(sw)![1]!;
  const before = "herdr-web-ui-v3-ram";
  const old = () => ({ [before]: { "/": "old shell", "/assets/index-old.js": "old bundle", "/assets/PretendardVariable.subset.91-old.woff2": "old chunk" } });

  it("starts offline from the shell and the files the worker before it kept", async () => {
    expect(current).not.toBe(before);
    const worker = serviceWorker(old());
    await worker.update();
    worker.network.online = false;
    expect(await worker.navigate()).toBe("old shell");
    expect(await worker.get("/assets/index-old.js")).toBe("old bundle");
    expect(await worker.get("/assets/PretendardVariable.subset.91-old.woff2")).toBe("old chunk");
    expect(worker.network.fetched).toEqual([]);
    expect(worker.names()).toContain(before);
  });

  it("drops that cache once its own holds a shell, and carries nothing of the old build over", async () => {
    const worker = serviceWorker(old());
    await worker.update();
    worker.network.shell = "new shell";
    expect(await worker.navigate("/?pane=p_1")).toBe("new shell");
    expect(worker.names()).toEqual([current]);
    expect(worker.entries(current)).toEqual(["/"]);
    // what the new shell asks for is fetched and kept as before, one file at a time
    expect(await worker.get("/assets/index-new.js")).toBe("network /assets/index-new.js");
    expect(worker.entries(current)).toEqual(["/", "/assets/index-new.js"]);
    worker.network.online = false;
    expect(await worker.navigate()).toBe("new shell");
    expect(await worker.get("/assets/index-new.js")).toBe("network /assets/index-new.js");
    expect(await worker.get("/assets/index-old.js")).toBeNull();
  });

  it("gives the page its shell without waiting for the copy to be kept", async () => {
    const worker = serviceWorker(old());
    await worker.update();
    worker.network.shell = "new shell";
    let written = (): void => undefined;
    worker.disk.ready = new Promise<void>((done) => { written = done; });
    const { answer, kept } = worker.fire();
    // the answer settles while the write is still held
    expect(await (await answer)!.text()).toBe("new shell");
    expect(worker.entries(current)).toEqual([]);
    expect(worker.names()).toContain(before);
    written();
    await kept();
    expect(worker.entries(current)).toEqual(["/"]);
    expect(worker.names()).toEqual([current]);
  });

  it("keeps a file the old cache answered while the new shell's copy was still being kept", async () => {
    const worker = serviceWorker(old());
    await worker.update();
    worker.network.shell = "new shell";
    let written = (): void => undefined;
    worker.disk.ready = new Promise<void>((done) => { written = done; });
    const { answer, kept } = worker.fire();
    expect(await (await answer)!.text()).toBe("new shell");
    // the page asks for a bundle only the old cache holds, before that cache is retired
    const asked = worker.ask("/assets/index-old.js");
    expect(await (await asked.answer)!.text()).toBe("old bundle");
    written();
    await kept();
    await asked.kept();
    expect(worker.names()).toEqual([current]);
    expect(worker.entries(current)).toEqual(["/", "/assets/index-old.js"]);
    worker.network.online = false;
    expect(await worker.get("/assets/index-old.js")).toBe("old bundle");
  });

  it("keeps the old cache through a navigation the server refused", async () => {
    const worker = serviceWorker(old());
    await worker.update();
    worker.network.shell = "sign in";
    worker.network.status = 401;
    expect(await worker.navigate()).toBe("sign in");
    expect(worker.names()).toContain(before);
    expect(worker.entries(before)).toContain("/");
    worker.network.online = false;
    expect(await worker.navigate()).toBe("old shell");
  });

  it("has no shell to give a device that never loaded the app online", async () => {
    const worker = serviceWorker({});
    await worker.update();
    worker.network.online = false;
    expect(await worker.navigate()).toBeNull();
  });
});

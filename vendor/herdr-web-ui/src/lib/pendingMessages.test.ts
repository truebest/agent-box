import { describe, expect, it } from "bun:test";
import type { PendingMessage } from "../../shared/protocol.ts";
import { PendingMessageStore } from "./pendingMessages.ts";

const storage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
};
const message = (id: string, state: PendingMessage["state"] = "queued", text = "check the tests"): PendingMessage => ({ id, request_id: 1, text, state, created_at: "2026-10-06T00:00:00Z" });

describe("pending message ownership", () => {
  it("restores saved queued and sending text as uncertain, without arming delivery", () => {
    const port = storage(), live = new PendingMessageStore(() => port);
    live.accept("pc:pane", message("q"), "connection-1");
    live.accept("pc:pane", message("s", "sending"), "connection-1");
    live.accept("pc:pane", message("h", "held"), "connection-1");
    const restored = new PendingMessageStore(() => port);
    expect(restored.read("pc:pane").map(({ id, state, serverOwned }) => [id, state, serverOwned])).toEqual([["q", "uncertain", false], ["s", "uncertain", false], ["h", "held", false]]);
    restored.publish("pc:pane", [], [], "connection-2");
    expect(restored.read("pc:pane")).toHaveLength(3);
  });
  it("keeps owner isolation and requires a matching connection proof for removal receipts", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("local:p1", message("one"), "scope-1");
    store.accept("remote:p1", message("two"), "scope-2");
    store.publish("local:p1", [], [{ id: "one", outcome: "sent" }], "scope-2");
    expect(store.read("local:p1")).toHaveLength(1);
    store.publish("local:p1", [], [{ id: "one", outcome: "sent" }], "scope-1");
    expect(store.read("local:p1")).toEqual([]);
    expect(store.read("remote:p1")[0]!.id).toBe("two");
  });
  it("suspends unconfirmed deliveries, retains confirmed held items, and cannot be rearmed by a late ACK", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("p", message("q"), "old");
    store.accept("p", message("h", "held"), "old");
    store.suspendScope("old");
    store.accept("p", message("q"), null);
    expect(store.read("p").map(({ state, serverOwned }) => [state, serverOwned])).toEqual([["uncertain", false], ["held", false]]);
    store.publish("p", [], [{ id: "q", outcome: "sent" }], "new");
    expect(store.read("p")).toHaveLength(2);
  });
  it("retains identical texts with different IDs and serializes actions on one ID", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("p", message("a"), "scope");
    store.accept("p", message("b"), "scope");
    expect(store.read("p")).toHaveLength(2);
    expect(store.begin("p", "a")).toBe(true);
    expect(store.begin("p", "a")).toBe(false);
    store.publish("p", [], [{ id: "a", outcome: "discarded" }], "scope");
    store.end("p", "a");
    expect(store.read("p").map((row) => row.id)).toEqual(["b"]);
  });
  it("does not resurrect an already delivered ID when its acceptance ACK arrives late", () => {
    const port = storage(), store = new PendingMessageStore(() => port);
    store.accept("p", message("a"), "scope");
    store.publish("p", [], [{ id: "a", outcome: "sent" }], "scope");
    store.accept("p", message("a"), "scope");
    expect(store.read("p")).toEqual([]);
  });
  it("does not let another tab's saved copy discard a live server-owned request", () => {
    const port = storage(), own = new PendingMessageStore(() => port);
    own.accept("p", message("a"), "scope");
    const other = new PendingMessageStore(() => port);
    expect(other.read("p")[0]!.state).toBe("uncertain");
    other.removeCopy("p", "a");
    own.refresh("p");
    expect(own.read("p")[0]!.serverOwned).toBe(true);
  });
  it("keeps another tab's saved message when a removal receipt arrives before that tab's storage event", () => {
    const port = storage(), first = new PendingMessageStore(() => port), second = new PendingMessageStore(() => port);
    first.accept("pc:pane", message("x"), "connection-a");
    second.read("pc:pane");
    second.accept("pc:pane", message("y"), "connection-b");
    first.publish("pc:pane", [], [{ id: "x", outcome: "sent" }], "connection-a");
    expect(first.read("pc:pane").map((item) => item.id)).toEqual(["y"]);
    expect(new PendingMessageStore(() => port).read("pc:pane").map((item) => item.id)).toEqual(["y"]);
  });
  it("saves a held copy as not confirmed while it is sent again, and as held once that is refused", () => {
    const port = storage(), live = new PendingMessageStore(() => port);
    live.accept("pc:pane", message("h", "held"), "connection-1");
    const restored = new PendingMessageStore(() => port);
    expect(restored.begin("pc:pane", "h")).toBe(true);
    restored.unconfirm("pc:pane", "h");
    expect(restored.read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "held"]]);
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"]]);
    restored.fail("pc:pane", "h", { code: "agent_blocked", message: "menu" }, false);
    restored.end("pc:pane", "h");
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "held"]]);
  });
  it("keeps a copy being sent again not confirmed through another row's write", () => {
    const port = storage(), live = new PendingMessageStore(() => port);
    live.accept("pc:pane", message("a", "held"), "connection-1");
    live.accept("pc:pane", message("b", "held"), "connection-1");
    const restored = new PendingMessageStore(() => port);
    expect(restored.begin("pc:pane", "a")).toBe(true);
    restored.unconfirm("pc:pane", "a");
    restored.removeCopy("pc:pane", "b");
    expect(restored.read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["a", "held"]]);
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["a", "uncertain"]]);
  });
  it("keeps another tab's saved message when a held copy is marked before that tab's storage event", () => {
    const port = storage(), seed = new PendingMessageStore(() => port);
    seed.accept("pc:pane", message("h", "held"), "connection-0");
    const first = new PendingMessageStore(() => port), second = new PendingMessageStore(() => port);
    first.read("pc:pane"); second.read("pc:pane");
    second.accept("pc:pane", message("y"), "connection-b");
    expect(first.begin("pc:pane", "h")).toBe(true);
    first.unconfirm("pc:pane", "h");
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"], ["y", "uncertain"]]);
  });
  it("keeps another tab's mark when this tab writes the list for a row of its own", () => {
    const port = storage(), seed = new PendingMessageStore(() => port);
    seed.accept("pc:pane", message("h", "held"), "connection-0");
    seed.accept("pc:pane", message("b", "held"), "connection-0");
    const first = new PendingMessageStore(() => port), second = new PendingMessageStore(() => port);
    first.read("pc:pane"); second.read("pc:pane");
    expect(first.begin("pc:pane", "h")).toBe(true);
    expect(first.unconfirm("pc:pane", "h")).toBe(true);
    second.removeCopy("pc:pane", "b");
    expect(second.read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"]]);
    expect(new PendingMessageStore(() => port).read("pc:pane").map(({ id, state }) => [id, state])).toEqual([["h", "uncertain"]]);
  });
  it("does not send a held copy again when its mark cannot be saved over the saved copy", () => {
    const port = storage(), seed = new PendingMessageStore(() => port);
    seed.accept("pc:pane", message("h", "held"), "connection-0");
    const full = new PendingMessageStore(() => ({ ...port, setItem: () => { throw new Error("quota"); } }));
    expect(full.begin("pc:pane", "h")).toBe(true);
    expect(full.unconfirm("pc:pane", "h")).toBe(false);
    // with nothing saved there is no copy a reload could offer again
    const none = new PendingMessageStore(() => ({ getItem: () => null, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} }));
    none.accept("pc:pane", message("m", "held"), null);
    expect(none.begin("pc:pane", "m")).toBe(true);
    expect(none.unconfirm("pc:pane", "m")).toBe(true);
  });
  it("keeps unsaved text in memory when storage fails", () => {
    const store = new PendingMessageStore(() => ({ getItem: () => null, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("full"); } }));
    store.accept("p", message("a"), "scope");
    expect(store.isUnsaved("p")).toBe(true);
    store.refresh("p");
    expect(store.read("p")[0]!.text).toBe("check the tests");
  });
});

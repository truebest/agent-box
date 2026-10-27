import { describe, expect, it } from "bun:test";
import { applyToDraft, draftIsEmpty, DRAFT_TTL_MS, EMPTY_DRAFT, restoreDraft } from "./draft.ts";

describe("applyToDraft", () => {
  it("appends a printable character to the draft", () => {
    expect(applyToDraft(EMPTY_DRAFT, "a")).toEqual({ text: "a", truncated: false });
  });

  it("keeps the order of consecutive typed characters", () => {
    const draft = applyToDraft(applyToDraft(EMPTY_DRAFT, "l"), "s");
    expect(draft.text).toBe("ls");
  });

  it("leaves a special key out of the draft", () => {
    const draft = applyToDraft(applyToDraft(EMPTY_DRAFT, "x"), "\r");
    expect(draft).toEqual({ text: "x", truncated: false });
  });

  it("holds nothing for escape sequences, arrows, control codes and DEL: there is nothing to send or to tell", () => {
    // also what xterm answers a program by itself: a cursor position, a focus or a mouse report
    for (const special of ["\u001b[A", "\u0003", "\u001b", "\t", "\u007f", "\u001b[12;40R", "\u001b[I", "\u001b[<35;10;5M"]) {
      const draft = applyToDraft(EMPTY_DRAFT, special);
      expect(draft).toBe(EMPTY_DRAFT);
      expect(draftIsEmpty(draft)).toBe(true);
    }
  });

  it("caps the draft instead of growing without bound, and says that text was left out", () => {
    let draft = EMPTY_DRAFT;
    for (let i = 0; i < 1024; i += 1) draft = applyToDraft(draft, "x");
    expect(draft).toEqual({ text: "x".repeat(1024), truncated: false });
    for (let i = 0; i < 76; i += 1) draft = applyToDraft(draft, "y");
    expect(draft).toEqual({ text: "x".repeat(1024), truncated: true });
  });

  it("leaves out whole a chunk the draft has no room for, and says so even with nothing held", () => {
    // a paste that arrives as one chunk: half of a command is never held
    const pasted = applyToDraft(EMPTY_DRAFT, "x".repeat(1025));
    expect(pasted).toEqual({ text: "", truncated: true });
    expect(draftIsEmpty(pasted)).toBe(false);
    const after = applyToDraft(applyToDraft(EMPTY_DRAFT, "ls "), "x".repeat(1022));
    expect(after).toEqual({ text: "ls ", truncated: true });
    // what still fits is held, and the loss stays told
    expect(applyToDraft(after, "-la")).toEqual({ text: "ls -la", truncated: true });
  });

  it("keeps a loss told when a special key follows it", () => {
    const lost = applyToDraft(EMPTY_DRAFT, "x".repeat(1025));
    expect(applyToDraft(lost, "\r")).toBe(lost);
  });
});

describe("draftIsEmpty", () => {
  it("is true for the empty draft and false once text is held or was left out", () => {
    expect(draftIsEmpty(EMPTY_DRAFT)).toBe(true);
    expect(draftIsEmpty({ text: "a", truncated: false })).toBe(false);
    expect(draftIsEmpty({ text: "", truncated: true })).toBe(false);
  });
});

it("holds multi-codepoint IME commits without splitting a surrogate at the limit", () => {
  for (const text of ["한글", "😀", "e\u0301", "abc"]) expect(applyToDraft(EMPTY_DRAFT, text).text).toBe(text);
  expect(applyToDraft({ text: "a".repeat(1023), truncated: false }, "😀")).toEqual({ text: "a".repeat(1023), truncated: true });
  // a paste is held by its text, not lost with its frames; one of several lines holds controls and is not
  expect(applyToDraft(EMPTY_DRAFT, "\x1b[200~text\x1b[201~")).toEqual({ text: "text", truncated: false });
  expect(applyToDraft(EMPTY_DRAFT, "\x1b[200~one\rtwo\x1b[201~")).toEqual(EMPTY_DRAFT);
  expect(applyToDraft(EMPTY_DRAFT, `\x1b[200~${"a".repeat(1025)}\x1b[201~`)).toEqual({ text: "", truncated: true });
  // a frame that never closes is a control chunk still
  expect(applyToDraft(EMPTY_DRAFT, "\x1b[200~text")).toEqual(EMPTY_DRAFT);
});

describe("restoreDraft", () => {
  const now = 1_800_000_000_000;
  const record = (at: number) => JSON.stringify({ text: "hunter2", truncated: false, at });

  it("restores a draft written inside the TTL", () => {
    expect(restoreDraft(record(now - 1000), now)).toEqual({ text: "hunter2", truncated: false });
  });

  it("forgets a draft past the TTL", () => {
    expect(restoreDraft(record(now - DRAFT_TTL_MS - 1), now)).toEqual(EMPTY_DRAFT);
  });

  it("keeps an undated record, written before the TTL existed: an update must not lose held input", () => {
    expect(restoreDraft(JSON.stringify({ text: "hunter2", truncated: false }), now)).toEqual({ text: "hunter2", truncated: false });
  });

  it("holds nothing for a missing, malformed or hand-edited record", () => {
    expect(restoreDraft(null, now)).toEqual(EMPTY_DRAFT);
    expect(restoreDraft("not json", now)).toEqual(EMPTY_DRAFT);
    expect(restoreDraft(JSON.stringify({ text: 7, truncated: false, at: now }), now)).toEqual(EMPTY_DRAFT);
    expect(restoreDraft(JSON.stringify({ text: "a", truncated: false, at: "soon" }), now)).toEqual(EMPTY_DRAFT);
  });

  it("reads a flag it does not recognise as no loss told, and keeps the text", () => {
    expect(restoreDraft(JSON.stringify({ text: "a", truncated: "yes", at: now }), now)).toEqual({ text: "a", truncated: false });
  });

  it("keeps a loss it told, and forgets it with the text", () => {
    expect(restoreDraft(JSON.stringify({ text: "ls", truncated: true, at: now - DRAFT_TTL_MS - 1 }), now)).toEqual(EMPTY_DRAFT);
    expect(restoreDraft(JSON.stringify({ text: "ls", truncated: true, at: now }), now)).toEqual({ text: "ls", truncated: true });
  });

  it("keeps the text of a record an earlier version wrote, and nothing but a count it held", () => {
    const legacy = JSON.stringify({ text: "ls", droppedSpecial: 3, at: now });
    expect(restoreDraft(legacy, now)).toEqual({ text: "ls", truncated: false });
    expect(restoreDraft(JSON.stringify({ text: "", droppedSpecial: 3, at: now }), now)).toEqual(EMPTY_DRAFT);
  });
});

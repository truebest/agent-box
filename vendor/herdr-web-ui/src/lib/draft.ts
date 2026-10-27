/**
 * The disconnected-input draft: while the socket is down, typed text is held for the
 * user to review and send after reconnect instead of being queued and fired blindly.
 * Pure logic, DOM-free, so the policy is unit-testable (see draft.test.ts).
 */

export interface InputDraft {
  readonly text: string;
  /** text was typed or pasted that the draft had no room for: what is held is not all of it */
  readonly truncated: boolean;
}

export const EMPTY_DRAFT: InputDraft = { text: "", truncated: false };

const MAX_DRAFT_CHARS = 1024;

/**
 * How long held input stays in the browser profile once it has been written there. The draft is
 * kept so a reload in the middle of a disconnect does not lose what the user typed; a day is far
 * longer than that, and short enough that text typed at a password prompt is not left lying
 * about afterwards. A record without a timestamp was written before the TTL existed: it is kept,
 * so an update in the middle of a disconnect loses nothing, and it is dated as it is restored.
 */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/** What a stored draft record holds: the draft, and when it was written. */
interface StoredDraft extends InputDraft { at: number }

/**
 * The draft a stored record restores, or the empty one: malformed and expired records read as
 * nothing held, so a hand-edited or stale entry cannot put text back on screen.
 * A record written by an earlier version counts the keys it left out instead of flagging them:
 * only its text is kept, and a record that held nothing but a count reads as empty.
 */
export function restoreDraft(raw: string | null, now: number): InputDraft {
  if (raw === null) return EMPTY_DRAFT;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return EMPTY_DRAFT; }
  if (typeof value !== "object" || value === null) return EMPTY_DRAFT;
  const { text, truncated, at } = value as Partial<StoredDraft>;
  if (typeof text !== "string") return EMPTY_DRAFT;
  if (at !== undefined && (typeof at !== "number" || !Number.isFinite(at) || now - at > DRAFT_TTL_MS)) return EMPTY_DRAFT;
  return { text, truncated: truncated === true };
}

/** An IME commit can contain several code points. Never preserve terminal control sequences. */
function isPrintableChar(data: string): boolean {
  return data.length > 0 && !/[\x00-\x1f\x7f-\x9f]/u.test(data);
}

/** xterm's bracketed paste: the pasted text between the frames, which is what the user gave. */
const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;

/**
 * Folds one onData chunk into the draft: printable text accumulates, a paste by the text
 * inside its bracketed-paste frames. A chunk with controls is left out and not told: Enter,
 * arrows and a paste of several lines contain them, and so do the answers xterm gives a
 * program by itself (cursor position, focus, mouse), which no one typed. Text the draft has
 * no room for is left out whole, never cut in the middle of what was typed, and the draft
 * says so.
 */
export function applyToDraft(draft: InputDraft, data: string): InputDraft {
  const text = BRACKETED_PASTE.exec(data)?.[1] ?? data;
  if (!isPrintableChar(text)) return draft;
  if (draft.text.length + text.length > MAX_DRAFT_CHARS) return draft.truncated ? draft : { ...draft, truncated: true };
  return { ...draft, text: draft.text + text };
}

/** Nothing held and nothing to tell. A draft that only lost text is not empty: its loss is still to be told. */
export function draftIsEmpty(draft: InputDraft): boolean {
  return draft.text.length === 0 && !draft.truncated;
}

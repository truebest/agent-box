/**
 * The fictional session behind the README media (scripts/readme-media/stage.ts) and the browser
 * demo (site/demo/transport.ts): five panes, their curated chats and one Codex approval. Nothing
 * here comes from a real machine. It imports no server code, so the browser bundle can take it.
 */
import type { ConversationTurn, InteractivePrompt } from "../../shared/protocol.ts";

export interface DemoSpec {
  key: string;
  /** the workspace's label and the folder name under the demo root */
  label: string;
  /** the pane's title */
  title: string;
  agent: string | null;
  state?: "idle" | "working" | "blocked";
}

export const SPECS: DemoSpec[] = [
  { key: "api", label: "checkout-api", title: "Idempotent payments", agent: "claude", state: "working" },
  { key: "web", label: "web-dashboard", title: "Guard the export button", agent: "codex", state: "blocked" },
  { key: "infra", label: "infra", title: "Why did the backup fail?", agent: "gjc", state: "idle" },
  { key: "docs", label: "docs-site", title: "Proofread the guide", agent: "omo", state: "idle" },
  { key: "cli", label: "cli-tools", title: "Ship the retry flag", agent: "pi", state: "idle" },
  { key: "shell", label: "release", title: "Tag v1.4.0", agent: null },
];

export const t = (min: number, sec = 0) => `2026-09-25T09:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.000Z`;
const tool = (name: string, summary: string, input: unknown, output: string): ConversationTurn["parts"][number] => ({ kind: "tool", name, summary, input: typeof input === "string" ? input : JSON.stringify(input, null, 2), output });

export const CHATS: Record<string, { turns: ConversationTurn[]; metadata: { model: string; reasoning_effort: string } }> = {
  api: {
    metadata: { model: "claude-opus-5-5", reasoning_effort: "high" },
    turns: [
      { role: "user" as const, ts: t(2), parts: [{ kind: "text" as const, text: "Make `POST /payments` idempotent: a client retrying with the same `Idempotency-Key` must get the first response back, never a second charge. Cover it with tests." }] },
      { role: "assistant" as const, ts: t(2, 5), end_ts: t(4, 41), parts: [
        { kind: "text" as const, text: "I'll look at how payments are created and where a key could be stored." },
        tool("Grep", "Idempotency-Key", { pattern: "Idempotency-Key", path: "src" }, "src/routes/payments.ts:14: // TODO: honour Idempotency-Key"),
        tool("Read", "src/routes/payments.ts", { file_path: "src/routes/payments.ts" }, "export async function createPayment(req: Request) { … }"),
        tool("Edit", "src/routes/payments.ts", { file_path: "src/routes/payments.ts" }, "Updated src/routes/payments.ts"),
        tool("Write", "src/lib/idempotency.ts", { file_path: "src/lib/idempotency.ts" }, "Created src/lib/idempotency.ts"),
        tool("Bash", "bun test payments", { command: "bun test payments" }, " 14 pass\n 0 fail\nRan 14 tests across 2 files. [412ms]"),
        { kind: "text" as const, text: "Done. Retries are now safe:\n\n- **`src/lib/idempotency.ts`** stores the first response per key for 24 h, scoped to the API client, so two clients can reuse a key without colliding.\n- **`POST /payments`** replays the stored response for a repeated key, and answers `409` while the first request with that key is still in flight.\n- A repeated key with a **different body** is rejected with `422`, instead of silently returning the old payment.\n\n```ts\nconst cached = await idempotency.lookup(client.id, key, body);\nif (cached) return cached.response;\n```\n\nTests: 14 pass, including concurrent retries and a key reused with a changed amount. See https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/ for the header's semantics." },
      ] },
      { role: "user" as const, ts: t(6), parts: [{ kind: "text" as const, text: "Nice. Now add a metric for replayed requests." }] },
      { role: "assistant" as const, ts: t(6, 3), parts: [
        { kind: "text" as const, text: "Adding a `payments_idempotent_replays_total` counter next to the existing request metrics." },
        tool("Read", "src/metrics.ts", { file_path: "src/metrics.ts" }, "export const requests = new Counter({ … })"),
        tool("Edit", "src/metrics.ts", { file_path: "src/metrics.ts" }, "Updated src/metrics.ts"),
      ] },
    ],
  },
  web: {
    metadata: { model: "gpt-5.6-sol", reasoning_effort: "medium" },
    turns: [
      { role: "user" as const, ts: t(1), parts: [{ kind: "text" as const, text: "Rate-limit the export button so a double click can't start two exports, then push the branch." }] },
      { role: "assistant" as const, ts: t(1, 4), end_ts: t(3, 20), parts: [
        tool("exec", "rg -n \"startExport\" src", { cmd: "rg -n \"startExport\" src" }, "src/pages/Reports.tsx:88:  onClick={() => startExport(filters)}"),
        tool("apply_patch", "src/pages/Reports.tsx", "*** Begin Patch\n*** Update File: src/pages/Reports.tsx\n@@\n-  onClick={() => startExport(filters)}\n+  disabled={exporting}\n+  onClick={() => { if (!exporting) startExport(filters); }}\n*** End Patch", "Success. Updated the following files:\nM src/pages/Reports.tsx"),
        tool("exec", "pnpm test --filter reports", { cmd: "pnpm test --filter reports" }, "✓ 9 tests passed"),
        { kind: "text" as const, text: "The button is disabled while an export runs, and a second click within the same run is ignored. Tests pass; I need your OK to push `feat/export-guard`." },
      ] },
    ],
  },
  infra: {
    metadata: { model: "glm-5.3", reasoning_effort: "med" },
    turns: [
      { role: "user" as const, ts: t(0), parts: [{ kind: "text" as const, text: "Why did last night's backup job fail?" }] },
      { role: "assistant" as const, ts: t(0, 6), end_ts: t(1, 2), parts: [
        tool("bash", "journalctl -u backup --since yesterday", { command: "journalctl -u backup --since yesterday" }, "backup.sh: disk quota exceeded on /mnt/archive"),
        { kind: "text" as const, text: "The archive volume hit its quota at 02:14. Old snapshots were never pruned because the retention flag was dropped in the last config change. I restored `--keep-daily 14`; tonight's run will prune and succeed." },
      ] },
    ],
  },
  docs: {
    metadata: { model: "claude-sonnet-5", reasoning_effort: "low" },
    turns: [
      { role: "user" as const, ts: t(0), parts: [{ kind: "text" as const, text: "Proofread the getting-started guide." }] },
      // OmO's background tasks: the call that starts them, then what OmO reports when they end
      { role: "assistant" as const, ts: t(0, 5), end_ts: t(0, 9), parts: [
        { kind: "text" as const, text: "I'll hand two checks to background tasks and proofread meanwhile." },
        tool("task", "Find pages that still say v0.2 · Translate the FAQ to Korean", { run_in_background: true, tasks: [
          { task_summary: "Find pages that still say v0.2", category: "quick", prompt: "List every page under docs/ that still names v0.2, with file and line." },
          { task_summary: "Translate the FAQ to Korean", category: "writing", prompt: "Translate docs/faq.md to Korean, keeping the terms in docs/i18n/glossary.ko.json." },
        ] }, "Batch running.\n1. st_demo3 (running)\n2. st_demo4 (running)"),
      ] },
      { role: "user" as const, ts: t(4), parts: [{ kind: "task_result" as const, tasks: [
        { id: "st_demo3", title: "Find pages that still say v0.2", agent: "quick", model: "Claude Haiku 4.5", status: "completed" as const, duration_ms: 241_000, turns: 9, tool_calls: 33, tokens: 61_200,
          result: "**3 pages** still say v0.2:\n\n- line 12 of `docs/guide/install.md`: the `curl` line downloads `v0.2/install.sh`\n- lines 4 and 31 of `docs/guide/upgrade.md`\n- line 88 of `docs/faq.md`\n\nEvery other page names v0.3." },
        { id: "st_demo4", title: "Translate the FAQ to Korean", agent: "writing", model: "GPT-6.1", status: "failed" as const, duration_ms: 236_000, turns: 3, tool_calls: 5, tokens: 12_000,
          result: "The glossary `docs/i18n/glossary.ko.json` is missing, so the terms could not be kept consistent. Nothing was written." },
      ] }] },
      { role: "assistant" as const, ts: t(4, 3), parts: [{ kind: "text" as const, text: "Fixed 6 typos and one broken link, and moved the three v0.2 pages to v0.3. The Korean FAQ needs a glossary first: shall I start `docs/i18n/glossary.ko.json` from the English one?" }] },
    ],
  },
  // pi reads its own session file, which is an entry tree rather than a log: a `/tree` move
  // shows only the branch in play, and a `/compact` leaves a summary where it folded the rest.
  cli: {
    metadata: { model: "anthropic/claude-opus-5-5", reasoning_effort: "high" },
    turns: [
      { role: "user" as const, ts: t(11), parts: [{ kind: "text" as const, text: "`release publish` dies on a flaky upload. Retry it, but never on a 4xx." }] },
      { role: "assistant" as const, ts: t(11, 4), end_ts: t(13, 12), parts: [
        { kind: "thinking" as const, text: "A 4xx means the request itself is wrong, so retrying only wastes another upload. The retry belongs around the transport error, not around the call." },
        { kind: "text" as const, text: "I'll find where the upload is issued before wrapping anything." },
        tool("bash", "rg -n upload src/publish", { command: "rg -n upload src/publish" }, "src/publish.ts:41:  const res = await upload(archive);"),
        tool("edit", "src/publish.ts", { path: "src/publish.ts" }, "Updated src/publish.ts"),
        tool("bash", "bun test publish", { command: "bun test publish" }, " 11 pass\n 0 fail\nRan 11 tests across 1 file. [286ms]"),
        { kind: "text" as const, text: "`upload` now retries a transport failure three times with backoff, and a 4xx fails on the first answer. Added `--retries`, defaulting to 3." },
      ] },
      { role: "user" as const, ts: t(20), parts: [{ kind: "compact" as const, text: "## Session Goal\n- Add bounded retries to `release publish` without retrying a 4xx\n\n## Files And Changes\n- `src/publish.ts` — `upload(archive, { retries })`, transport errors only\n- `src/publish.test.ts` — 11 tests, one per status family\n\n## User Preferences\n- Never retry a request the server rejected on purpose" }] },
      { role: "user" as const, ts: t(21), parts: [{ kind: "text" as const, text: "Now expose it as `RELEASE_RETRIES`." }] },
      { role: "assistant" as const, ts: t(21, 3), end_ts: t(22, 40), parts: [
        tool("read", "src/config.ts", { path: "src/config.ts" }, "export interface PublishOptions { … }"),
        tool("edit", "src/config.ts", { path: "src/config.ts" }, "Updated src/config.ts"),
        { kind: "text" as const, text: "`RELEASE_RETRIES` sets the default, and `--retries` still wins over it. The README's environment table lists it." },
      ] },
    ],
  },
};

export const PROMPT: InteractivePrompt = {
  id: "demo-approval",
  agent: "codex",
  kind: "approval" as const,
  // the shape Codex's approval has on the wire: the heading is the question too, and the command
  // is the body (server/prompt.ts)
  title: "Allow command?",
  question: "Allow command?",
  body: "git push origin feat/export-guard",
  options: [
    { label: "Yes", description: null },
    { label: "Yes, and don't ask again for git push", description: null },
    { label: "No, and tell Codex what to do differently", description: null },
  ],
  multi_select: false,
  custom_option_index: null,
};

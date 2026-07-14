// A worker's two-sided transcript, derived PURELY from its native codex/claude session (thread/read) —
// QiYan stores nothing for workers. Prompts come from `userMessage.content` (codex populates it; the
// Claude adapter currently does not, so Claude shows agent replies only), replies from the agent's
// final-answer messages. Codex session setup (<environment_context>) is stripped. This is the pure map;
// the pool read lives in SessionService so this stays trivially testable with a plain turns array.

export interface WorkerConvoRow {
  id: string;
  turnId: string;
  role: "you" | "worker"; // "you" = a prompt sent to the worker; "worker" = its reply
  body: string;
  completedAt: number; // millis — sort/paging key
  terminalStatus: string;
}

// Native turn timestamps are Unix SECONDS (Turn.startedAt/completedAt); normalize to millis, tolerating
// a value that is already millis.
const toMillis = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? (n < 1e12 ? Math.round(n * 1000) : Math.round(n)) : 0; };

// Join the text spans of a codex userMessage's `content` (Array<UserInput>); ignore images/mentions.
const userInputText = (content: unknown): string =>
  Array.isArray(content) ? content.filter((c) => c && (c as { type?: string }).type === "text" && typeof (c as { text?: unknown }).text === "string").map((c) => (c as { text: string }).text).join("").trim() : "";

// Drop a leading codex <environment_context>…</environment_context> setup block (injected on session
// start, not a user prompt); keep any real prompt that follows.
const stripSetup = (text: string): string => text.replace(/^\s*<environment_context>[\s\S]*?<\/environment_context>\s*/i, "").trim();

type NativeItem = { type?: string; id?: string; text?: string; phase?: string | null; content?: unknown };
type NativeTurn = { id?: string; status?: string; startedAt?: number | null; completedAt?: number | null; items?: NativeItem[] };

// Flatten native turns into an oldest→newest, two-sided message list, then return one page: the newest
// `count` rows at-or-before the `before` (millis) cursor. INCLUSIVE cursor (the client dedups by id) so
// nothing sharing the boundary instant is skipped on scroll-up.
export function mapWorkerConversation(turns: readonly unknown[], count: number, before?: number): WorkerConvoRow[] {
  const rows: Array<WorkerConvoRow & { order: number }> = [];
  for (const raw of turns) {
    const turn = (raw ?? {}) as NativeTurn;
    const turnId = String(turn.id ?? "");
    const items = Array.isArray(turn.items) ? turn.items : [];
    const startedMs = toMillis(turn.startedAt ?? turn.completedAt);
    const completedMs = toMillis(turn.completedAt ?? turn.startedAt);
    items.forEach((item, index) => {
      if (item.type !== "userMessage") return;
      const body = stripSetup(userInputText(item.content));
      if (body) rows.push({ id: `u:${turnId}:${item.id ?? index}`, turnId, role: "you", body, completedAt: startedMs, terminalStatus: "", order: index });
    });
    // The worker's reply: explicit final_answer items, else (older/unknown-phase transcripts) the last
    // phase-null agent message — mirrors FinalMessageStore's selection.
    const agent = items.map((item, index) => ({ item, index })).filter(({ item }) => item.type === "agentMessage" && item.text);
    const explicit = agent.filter(({ item }) => item.phase === "final_answer");
    const chosen = explicit.length > 0 ? explicit : agent.filter(({ item }) => item.phase == null).slice(-1);
    for (const { item, index } of chosen) {
      rows.push({ id: `a:${turnId}:${item.id ?? index}`, turnId, role: "worker", body: String(item.text), completedAt: completedMs, terminalStatus: String(turn.status ?? ""), order: index });
    }
  }
  rows.sort((a, b) => a.completedAt - b.completedAt || (a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0) || a.order - b.order);
  const filtered = before !== undefined && Number.isFinite(before) ? rows.filter((r) => r.completedAt <= before) : rows;
  return filtered.slice(Math.max(0, filtered.length - count)).map(({ order: _order, ...row }) => row);
}

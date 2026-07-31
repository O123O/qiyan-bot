// Claude transcript → Codex `thread/read` reconstruction (Phase 1.2).
//
// The pool/relay address a Claude session through the Codex request surface and,
// successful turn completion is hydrated through bounded authoritative transcript pages
// (`events/relay.ts` projectTarget). So the source of truth for delivered content is
// the transcript on disk, not the live stream: a COMPLETED turn is fully persisted
// by the time the SDK reports it done (spike 0.2/interrupt finding — only interrupted
// turns lose un-flushed stream output). This pure function reconstructs the Codex
// `thread/read` view from parsed transcript records; 1.3 wraps it with file I/O and
// uses the live stream only to detect turn completion.
//
// A turn starts on
// a `user` row with non-empty `promptSource`; a null-`promptSource` user row is a
// tool_result (mid-turn); a turn ends on an assistant row whose `stop_reason` is a
// concrete value other than `tool_use`.
import {
  extractClaudeClientMarker,
  isClaudeInternalTaskNotification,
  visibleClaudeUserText,
} from "./claude-client-marker.ts";

export type ClaudeTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type ClaudeMessagePhase = "final_answer" | "commentary";

export interface ClaudeThreadItem {
  type: "userMessage" | "agentMessage";
  id: string;
  clientId?: string | null;
  content?: Array<{ type: "text"; text: string; text_elements: unknown[] }>;
  text?: string;
  phase?: ClaudeMessagePhase | null;
}

export interface ClaudeThreadTurn {
  id: string;
  status: ClaudeTurnStatus;
  itemsView: "full" | "summary" | "notLoaded";
  items: ClaudeThreadItem[];
  startedAt?: number | null;
  completedAt?: number | null;
}

export interface ClaudeThreadView {
  id: string;
  cwd: string;
  status: { type: "idle" | "active" };
  // Work Claude started for itself and is still running after the turn that began it.
  // Present only for a Claude worker; absent means "none", not "unknown".
  nativeActivity?: { backgroundTasks: number; subagents: number };
  itemsView: "full";
  turns: ClaudeThreadTurn[];
  threadSource?: string;
  model?: string;
}

export interface ReconstructClaudeThreadParams {
  threadId: string;
  cwd: string;
  records: readonly unknown[];
  threadSource?: string;
  model?: string;
  // Turn ids the runtime knows were interrupted (the SDK query's response was aborted).
  interruptedTurnIds?: ReadonlySet<string>;
  // The turn the host is running right now (in-memory, authoritative). A turn can be
  // executing before `claude` flushes its user row, so disk reconstruction alone can
  // read `idle`; overlaying this forces the thread `active`.
  runningTurnId?: string;
}

interface TurnAccumulator {
  turn: ClaudeThreadTurn;
  terminal: boolean;
}

export function reconstructClaudeThread(params: ReconstructClaudeThreadParams): ClaudeThreadView {
  const turns: ClaudeThreadTurn[] = [];
  let current: TurnAccumulator | undefined;
  let assistantRecordSeq = 0;

  const finalize = (accumulator: TurnAccumulator | undefined): void => {
    if (!accumulator) return;
    if (!accumulator.terminal) {
      // Claude is a headless child process, not a resumable daemon. Only the child
      // tracked by this runtime can make a turn live. A trailing transcript row after
      // restart means the former process exited without a terminal record.
      accumulator.turn.status = params.runningTurnId === accumulator.turn.id ? "inProgress" : "interrupted";
    }
    turns.push(accumulator.turn);
  };

  for (const raw of params.records) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const type = record.type;

    if (type === "user") {
      const rowId = promptOrRowId(record);
      const turnId = claudeTurnIdFromRecord(record);
      if (!rowId || !turnId) continue; // tool_result or malformed user row
      finalize(current);
      const marker = extractClaudeClientMarker(record.message);
      // The turn id is the row's own uuid (see claudeTurnIdFromRecord); Claude's promptId is
      // only a fallback identity for a row that somehow has no uuid. A legacy client marker
      // still wins, so transcripts written by the retired one-shot path keep their ids.
      const text = visibleClaudeUserText(record.message);
      const userItem: ClaudeThreadItem = {
        type: "userMessage",
        id: idOf(record) ?? `${rowId}:user`,
        clientId: marker ?? null,
        ...(text ? { content: [{ type: "text", text, text_elements: [] }] } : {}),
      };
      current = {
        turn: {
          id: turnId,
          status: "completed",
          itemsView: "full",
          items: [userItem],
          startedAt: timestampOf(record) ?? null,
          completedAt: null,
        },
        terminal: false,
      };
      assistantRecordSeq = 0;
      continue;
    }

    if (type === "assistant" && current) {
      const terminal = isTurnEnd(record);
      const recordId = idOf(record) ?? `${current.turn.id}:assistant:${assistantRecordSeq}`;
      assistantRecordSeq += 1;
      for (const [blockIndex, block] of textBlocks(record.message).entries()) {
        current.turn.items.push({
          type: "agentMessage",
          id: `${recordId}:${blockIndex}`,
          text: block,
          phase: terminal ? "final_answer" : "commentary",
        });
      }
      if (terminal) {
        current.terminal = true;
        current.turn.status = "completed";
        current.turn.completedAt = timestampOf(record) ?? current.turn.startedAt ?? null;
      }
    }
  }
  finalize(current);

  // A turn QiYan drove that failed/interrupted BEFORE `claude` persisted its
  // turn-start user row (spawn ENOENT on a node without claude, a rejected flag,
  // etc.) leaves no transcript turn — so synthesize a findable terminal turn for
  // every known-terminal id that isn't already present. Otherwise the relay, which
  // finds the turn by id in thread/read, retries forever and never releases the
  // capacity claim.
  if (params.interruptedTurnIds) {
    const present = new Set(turns.map((turn) => turn.id));
    for (const id of params.interruptedTurnIds) {
      if (present.has(id)) continue;
      turns.push({ id, status: "interrupted", itemsView: "full", items: [{ type: "userMessage", id: `${id}:user`, clientId: id }] });
    }
  }

  if (params.runningTurnId !== undefined && !turns.some((turn) => turn.id === params.runningTurnId && turn.status === "inProgress")) {
    const existing = turns.find((turn) => turn.id === params.runningTurnId);
    if (existing) existing.status = "inProgress";
    else turns.push({ id: params.runningTurnId, status: "inProgress", itemsView: "full", items: [{ type: "userMessage", id: `${params.runningTurnId}:user`, clientId: params.runningTurnId }] });
  }

  const active = turns.some((turn) => turn.status === "inProgress");
  return {
    id: params.threadId,
    cwd: params.cwd,
    status: { type: active ? "active" : "idle" },
    itemsView: "full",
    turns,
    ...(params.threadSource === undefined ? {} : { threadSource: params.threadSource }),
    ...(params.model === undefined ? {} : { model: params.model }),
  };
}

export function claudeTurnIdFromRecord(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.type !== "user" || typeof record.promptSource !== "string" || record.promptSource.length === 0) return undefined;
  if (isClaudeInternalTaskNotification(record.message)) return undefined;
  const fallback = promptOrRowId(record);
  if (!fallback) return undefined;
  // A turn's id is the user row's own uuid, which for a QiYan-driven turn IS the
  // clientUserMessageId we handed the SDK. That makes a live turn and its reconstructed
  // history agree on identity, so the Web UI merges them instead of rendering both.
  // `promptId` is a separate Claude-generated id and must NOT be used: it never matches
  // anything QiYan knows. A legacy client marker still wins so transcripts written by the
  // retired one-shot path keep their historical turn ids.
  return extractClaudeClientMarker(record.message) ?? idOf(record) ?? fallback;
}

// Any identity the row carries, in the order the retired one-shot path used. Only a
// presence check and the user item's id fallback still need it — a TURN's id comes from
// claudeTurnIdFromRecord, which prefers the uuid.
function promptOrRowId(record: Record<string, unknown>): string | undefined {
  if (typeof record.promptId === "string" && record.promptId.length > 0) return record.promptId;
  return idOf(record);
}

function idOf(record: Record<string, unknown>): string | undefined {
  return typeof record.uuid === "string" && record.uuid.length > 0 ? record.uuid : undefined;
}

function timestampOf(record: Record<string, unknown>): number | undefined {
  if (typeof record.timestamp === "number" && Number.isFinite(record.timestamp) && record.timestamp > 0) {
    return record.timestamp;
  }
  if (typeof record.timestamp !== "string") return undefined;
  const parsed = Date.parse(record.timestamp);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isTurnEnd(record: Record<string, unknown>): boolean {
  return claudeMessagePhase(record) === "final_answer";
}

// Shared by reconstruction and by the live SDK event path, so an assistant message is
// phased identically whether the Web UI sees it stream in or reloads it from the
// transcript. The two must agree: a live item and its reconstructed twin are merged by id,
// and a divergent phase would leave the merged message describing itself two ways.
// `stop_reason` is "tool_use" when the model is pausing to call a tool, so anything else
// non-empty terminates the turn; absent means still streaming.
export function claudeMessagePhase(record: Record<string, unknown>): ClaudeMessagePhase {
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return "commentary";
  const stopReason = (message as Record<string, unknown>).stop_reason;
  return typeof stopReason === "string" && stopReason.length > 0 && stopReason !== "tool_use"
    ? "final_answer"
    : "commentary";
}

// Only assistant TEXT blocks become deliverable agentMessages; thinking and tool_use
// blocks are not delivered. A string content is treated as a single text block.
function textBlocks(message: unknown): string[] {
  if (!message || typeof message !== "object" || Array.isArray(message)) return [];
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content.length > 0 ? [content] : [];
  if (!Array.isArray(content)) return [];
  const blocks: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string" && text.length > 0) blocks.push(text);
    }
  }
  return blocks;
}

// Claude's `/goal` writes its state into the session's own transcript: the slash command
// echoes `Goal set: <condition>` on stdout, and clearing echoes `Goal cleared`. That is a
// durable record QiYan already reads for history, so a native goal is observable after all
// — what the SDK withholds is only the LIVE progress of one (iterations, tokens), never
// whether one exists. Reading the last marker wins over storing a duplicate goal row.
export function claudeNativeGoal(records: readonly unknown[]): { objective: string } | null {
  let goal: { objective: string } | null = null;
  for (const raw of records) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    if (record.type !== "user") continue;
    const text = messageTextOf(record.message);
    if (!text.includes("<local-command-stdout>")) continue;
    // Later markers supersede earlier ones, so the last one in the file is current.
    const set = /Goal set:\s*([^<\n]+)/u.exec(text);
    if (set?.[1]) { goal = { objective: set[1].trim() }; continue; }
    if (/Goal cleared/u.test(text)) goal = null;
  }
  return goal;
}

function messageTextOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "text"
      ? String((block as Record<string, unknown>).text ?? "")
      : "")
    .join("");
}

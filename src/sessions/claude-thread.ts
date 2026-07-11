// Claude transcript → Codex `thread/read` reconstruction (Phase 1.2).
//
// The pool/relay address a Claude session through the Codex request surface and,
// crucially, the relay does NOT trust the `turn/completed` notification body — after
// a turn completes it re-reads authoritative history via `thread/read`
// (`events/relay.ts` projectTarget). So the source of truth for delivered content is
// the transcript on disk, not the live stream: a COMPLETED turn is fully persisted
// by the time `claude -p` exits (spike 0.2/interrupt finding — only interrupted
// turns lose un-flushed stream output). This pure function reconstructs the Codex
// `thread/read` view from parsed transcript records; 1.3 wraps it with file I/O and
// uses the live stream only to detect turn completion.
//
// Turn model matches the ownership scanner (`claude-transcript.ts`): a turn starts on
// a `user` row with non-empty `promptSource`; a null-`promptSource` user row is a
// tool_result (mid-turn); a turn ends on an assistant row whose `stop_reason` is a
// concrete value other than `tool_use`.
import { extractClientMarker } from "./claude-transcript.ts";

export type ClaudeTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type ClaudeMessagePhase = "final_answer" | "commentary";

export interface ClaudeThreadItem {
  type: "userMessage" | "agentMessage";
  id: string;
  clientId?: string | null;
  text?: string;
  phase?: ClaudeMessagePhase | null;
}

export interface ClaudeThreadTurn {
  id: string;
  status: ClaudeTurnStatus;
  itemsView: "full";
  items: ClaudeThreadItem[];
}

export interface ClaudeThreadView {
  id: string;
  cwd: string;
  status: { type: "idle" | "active" };
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
  // Turn ids the runtime knows were interrupted (subprocess killed). An open turn
  // not listed here is reported `inProgress`.
  interruptedTurnIds?: ReadonlySet<string>;
}

interface TurnAccumulator {
  turn: ClaudeThreadTurn;
  terminal: boolean;
}

export function reconstructClaudeThread(params: ReconstructClaudeThreadParams): ClaudeThreadView {
  const turns: ClaudeThreadTurn[] = [];
  let current: TurnAccumulator | undefined;
  let itemSeq = 0;

  const finalize = (accumulator: TurnAccumulator | undefined): void => {
    if (!accumulator) return;
    if (!accumulator.terminal) {
      accumulator.turn.status = params.interruptedTurnIds?.has(accumulator.turn.id) ? "interrupted" : "inProgress";
    }
    turns.push(accumulator.turn);
  };

  for (const raw of params.records) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const type = record.type;

    if (type === "user") {
      const promptSource = record.promptSource;
      if (typeof promptSource !== "string" || promptSource.length === 0) continue; // tool_result: mid-turn
      const promptId = turnIdOf(record);
      if (!promptId) continue;
      finalize(current);
      const marker = extractClientMarker(record.message);
      // turn.id is the QiYan clientUserMessageId marker when owned (so it equals the
      // id `turn/start` returned and `turn/completed` pushes, letting the relay find
      // the turn), else the Claude promptId for external/human turns.
      const turnId = marker ?? promptId;
      const userItem: ClaudeThreadItem = {
        type: "userMessage",
        id: idOf(record) ?? `${promptId}:user`,
        clientId: marker ?? null,
      };
      current = { turn: { id: turnId, status: "completed", itemsView: "full", items: [userItem] }, terminal: false };
      continue;
    }

    if (type === "assistant" && current) {
      const terminal = isTurnEnd(record);
      for (const block of textBlocks(record.message)) {
        current.turn.items.push({
          type: "agentMessage",
          id: `${idOf(record) ?? current.turn.id}:${itemSeq++}`,
          text: block,
          phase: terminal ? "final_answer" : "commentary",
        });
      }
      if (terminal) { current.terminal = true; current.turn.status = "completed"; }
    }
  }
  finalize(current);

  const openTurn = turns.length > 0 && (turns[turns.length - 1]!.status === "inProgress");
  return {
    id: params.threadId,
    cwd: params.cwd,
    status: { type: openTurn ? "active" : "idle" },
    itemsView: "full",
    turns,
    ...(params.threadSource === undefined ? {} : { threadSource: params.threadSource }),
    ...(params.model === undefined ? {} : { model: params.model }),
  };
}

function turnIdOf(record: Record<string, unknown>): string | undefined {
  if (typeof record.promptId === "string" && record.promptId.length > 0) return record.promptId;
  if (typeof record.uuid === "string" && record.uuid.length > 0) return record.uuid;
  return undefined;
}

function idOf(record: Record<string, unknown>): string | undefined {
  return typeof record.uuid === "string" && record.uuid.length > 0 ? record.uuid : undefined;
}

function isTurnEnd(record: Record<string, unknown>): boolean {
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const stopReason = (message as Record<string, unknown>).stop_reason;
  return typeof stopReason === "string" && stopReason.length > 0 && stopReason !== "tool_use";
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

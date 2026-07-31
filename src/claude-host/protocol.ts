// Wire contract between the QiYan backend and qiyan-claude-host.
//
// Deliberately smaller than the Codex App Server protocol: it carries what QiYan's
// capabilities need and nothing speculative. Two methods are provisioned ahead of their
// callers and say so where they are declared — `models`, because `model/list` still answers
// from the static catalog, and `stopTask`, because no manager tool cancels a native
// background task yet. Newline-delimited JSON over an owner-only Unix socket; the handshake
// is the first request on every connection.
export const CLAUDE_HOST_PROTOCOL_VERSION = 1;

export type SessionActivity = "idle" | "working" | "background";

export interface BackgroundTaskView {
  taskId: string;
  // Task-tool subagents are distinguished from anything else Claude backgrounded, because
  // the Web UI reports them separately.
  kind: "subagent" | "background";
  description?: string;
  startedAt: number;
}

export interface SessionStatus {
  sessionId: string;
  activity: SessionActivity;
  // Accepted sends that have not settled, in submission order.
  inFlightTurns: string[];
  backgroundTasks: BackgroundTaskView[];
}

export interface HostStatus {
  protocolVersion: number;
  hostBuild: string;
  sdkVersion: string;
  claudeVersion: string;
  // Bumped whenever the host process is replaced, so a reconnecting backend can tell
  // "same host" from "new host that lost my sessions".
  runtimeGeneration: string;
  capabilities: readonly string[];
  sessions: SessionStatus[];
}

// Events are live fan-out only — the host buffers nothing. A client that misses events
// while disconnected reloads the tail of the durable transcript instead, which is the
// only complete source anyway.
interface HostEventBase {
  sessionId: string;
  at: number;
}

export type HostEvent =
  | (HostEventBase & { type: "session/init"; message: Record<string, unknown> })
  | (HostEventBase & { type: "session/error"; message: string })
  // The session is gone and will never produce another event: its query ended (cleanly or
  // because the `claude` child died), it was evicted, or it was closed outright. A consumer
  // holding "this thread is loaded" state must drop it and reopen on the next turn.
  | (HostEventBase & { type: "session/closed" })
  | (HostEventBase & { type: "turn/accepted"; uuid: string })
  | (HostEventBase & {
    type: "turn/completed";
    // Absent when the terminal result could not be attributed to an accepted send.
    uuid?: string;
    origin: "human" | "task-notification";
    status: "completed" | "failed" | "interrupted";
    result?: Record<string, unknown>;
  })
  | (HostEventBase & { type: "content/assistant"; message: Record<string, unknown> })
  | (HostEventBase & { type: "content/nested"; message: Record<string, unknown> })
  // The whole live set after any change, so a consumer never maintains its own counters.
  | (HostEventBase & { type: "task/set"; background: number; subagents: number; descriptions: string[] });

// One request per ClaudeHost method, so the server's dispatch is mechanical and the wire
// cannot drift from the interface. `params` is the method's argument tuple.
export type HostRequest =
  | { method: "host/status" }
  | { method: "open"; params: [OpenSessionRequestWire] }
  | { method: "close"; params: [string] }
  | { method: "send"; params: [string, string, string] }
  | { method: "interrupt"; params: [string] }
  | { method: "status"; params: [string] }
  | { method: "setModel"; params: [string, string | undefined] }
  | { method: "setEffort"; params: [string, string | undefined] }
  | { method: "models"; params: [string] }
  | { method: "stopTask"; params: [string, string] }
  | { method: "evictIdle"; params: [number] }
  | { method: "shutdown"; params: [] };

// Structurally identical to OpenSessionRequest; declared here so protocol.ts stays free
// of an import cycle with host.ts.
export interface OpenSessionRequestWire {
  sessionId: string;
  mode: "create" | "resume";
  cwd: string;
  model?: string;
  effort?: string;
}

export interface HostFrame {
  id: number;
  request?: HostRequest;
  result?: unknown;
  error?: { code: string; message: string };
  event?: HostEvent;
}

export function encodeFrame(frame: HostFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function decodeFrames(buffer: string): { frames: HostFrame[]; rest: string } {
  const frames: HostFrame[] = [];
  let rest = buffer;
  let index: number;
  while ((index = rest.indexOf("\n")) >= 0) {
    const line = rest.slice(0, index).trim();
    rest = rest.slice(index + 1);
    if (!line) continue;
    try { frames.push(JSON.parse(line) as HostFrame); }
    catch { /* a partial or corrupt line is dropped; the stream stays framed */ }
  }
  return { frames, rest };
}

// Wire contract between the QiYan backend and qiyan-claude-host.
//
// Deliberately smaller than the Codex App Server protocol: a method exists only when a
// QiYan capability already calls it. Newline-delimited JSON over an owner-only Unix
// socket; the handshake is the first request on every connection.
export const CLAUDE_HOST_PROTOCOL_VERSION = 1;

export type SessionActivity = "idle" | "working" | "background";

export interface BackgroundTaskView {
  taskId: string;
  taskType?: string;
  startedAt: number;
}

export interface SessionStatus {
  sessionId: string;
  activity: SessionActivity;
  // Accepted sends that have not settled, in submission order.
  inFlightTurns: string[];
  backgroundTasks: BackgroundTaskView[];
  // Latest event sequence number, for replay after a reconnect.
  cursor: number;
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

interface HostEventBase {
  seq: number;
  sessionId: string;
  at: number;
}

export type HostEvent =
  | (HostEventBase & { type: "session/init"; message: Record<string, unknown> })
  | (HostEventBase & { type: "session/error"; message: string })
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
  | (HostEventBase & { type: "task/started"; taskId: string })
  | (HostEventBase & { type: "task/settled"; taskId: string; status: string })
  | (HostEventBase & { type: "task/set"; taskIds: string[] });

// A HostEvent before the host stamps its sequence number. Written as a distributive
// conditional because a plain `Omit<HostEvent, "seq">` collapses the union to its
// common keys and would reject every variant-specific field.
export type HostEventDraft = HostEvent extends infer Variant
  ? Variant extends HostEvent ? Omit<Variant, "seq"> : never
  : never;

// Turn completion for an interrupted turn arrives without a uuid, so a client that is
// waiting on one specific send must fall back to this ordering rule: the oldest
// in-flight turn owns the next uncorrelated terminal result. The host applies it, and
// the event's `uuid` reports the attribution it made.

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
  | { method: "models"; params: [string] }
  | { method: "stopTask"; params: [string, string] }
  | { method: "eventsSince"; params: [string, number] }
  | { method: "evictIdle"; params: [number] }
  | { method: "shutdown"; params: [] };

// Structurally identical to OpenSessionRequest; declared here so protocol.ts stays free
// of an import cycle with host.ts.
export interface OpenSessionRequestWire {
  sessionId: string;
  mode: "create" | "resume";
  cwd: string;
  model?: string;
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

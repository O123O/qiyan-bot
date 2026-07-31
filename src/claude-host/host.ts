// The one interface QiYan uses to run Claude sessions, and its in-process implementation.
//
// There are two transports and exactly one behavioural implementation:
//
//   LocalClaudeHost   — holds SDK queries in this process. A QiYan restart ends them,
//                       which is the local behaviour today; nothing regresses.
//   remote (later)    — the same ClaudeHostSession actor running inside the endpoint's
//                       tmux-supervised `qiyan-claude-host`, reached over SSH. There a
//                       restart of QiYan does NOT end a turn.
//
// Both satisfy `ClaudeHost`, so `ClaudeCodeRuntime` never learns which one it has, and
// session behaviour is defined once in ClaudeHostSession rather than per transport.
// Every method is async so the remote transport needs no shape changes.
import { AppError } from "../core/errors.ts";
import type { HostEvent, SessionStatus } from "./protocol.ts";
import { ClaudeHostSession, type SessionQueryFactory } from "./session.ts";

export interface OpenSessionRequest {
  sessionId: string;
  // "create" reserves the caller's UUID as the native session id; "resume" reopens an
  // existing native session without forking it. Both are proven in the capability spike.
  mode: "create" | "resume";
  cwd: string;
  model?: string;
}

export interface ClaudeHost {
  open(request: OpenSessionRequest): Promise<SessionStatus>;
  close(sessionId: string): Promise<void>;
  // Returns false when the uuid was already accepted, so a retry after an ambiguous
  // transport failure reports "already accepted" instead of queueing a second turn.
  send(sessionId: string, uuid: string, text: string): Promise<boolean>;
  interrupt(sessionId: string): Promise<void>;
  status(sessionId: string): Promise<SessionStatus>;
  setModel(sessionId: string, model?: string): Promise<void>;
  models(sessionId: string): Promise<unknown[]>;
  stopTask(sessionId: string, taskId: string): Promise<void>;
  subscribe(listener: (event: HostEvent) => void): () => void;
  // Unload idle sessions above the loaded-session budget. A session with a running turn
  // or a live background task is never evicted, or its output would be lost.
  evictIdle(keep: number): Promise<string[]>;
  shutdown(): Promise<void>;
}

export class LocalClaudeHost implements ClaudeHost {
  private readonly sessions = new Map<string, ClaudeHostSession>();
  private readonly listeners = new Set<(event: HostEvent) => void>();
  private readonly unsubscribes = new Map<string, () => void>();

  // `prepare` resolves everything a session needs (launch options, permission
  // pass-through) before the actor exists, so the actor's constructor stays synchronous
  // and nothing is patched in afterwards.
  constructor(private readonly prepare: (request: OpenSessionRequest) => Promise<SessionQueryFactory>) {}

  async open(request: OpenSessionRequest): Promise<SessionStatus> {
    const existing = this.sessions.get(request.sessionId);
    if (existing) return existing.status();
    const session = new ClaudeHostSession(request.sessionId, await this.prepare(request));
    this.sessions.set(request.sessionId, session);
    this.unsubscribes.set(request.sessionId, session.subscribe((event) => {
      for (const listener of this.listeners) listener(event);
    }));
    return session.status();
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.unsubscribes.get(sessionId)?.();
    this.unsubscribes.delete(sessionId);
    this.sessions.delete(sessionId);
    session.close();
  }

  async send(sessionId: string, uuid: string, text: string): Promise<boolean> {
    return this.require(sessionId).send(uuid, text);
  }

  async interrupt(sessionId: string): Promise<void> { await this.require(sessionId).interrupt(); }
  async status(sessionId: string): Promise<SessionStatus> { return this.require(sessionId).status(); }
  async setModel(sessionId: string, model?: string): Promise<void> { await this.require(sessionId).setModel(model); }
  async models(sessionId: string): Promise<unknown[]> { return await this.require(sessionId).supportedModels(); }
  async stopTask(sessionId: string, taskId: string): Promise<void> { await this.require(sessionId).stopTask(taskId); }

  subscribe(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // Oldest-first among evictable sessions, so the most recently active stay loaded.
  async evictIdle(keep: number): Promise<string[]> {
    const evictable = [...this.sessions.entries()].filter(([, session]) => session.isEvictable());
    const excess = this.sessions.size - keep;
    if (excess <= 0) return [];
    const evicted: string[] = [];
    for (const [sessionId] of evictable.slice(0, excess)) {
      await this.close(sessionId);
      evicted.push(sessionId);
    }
    return evicted;
  }

  async shutdown(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) await this.close(sessionId);
  }

  private require(sessionId: string): ClaudeHostSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new AppError("UNKNOWN_SESSION", `claude session is not loaded: ${sessionId}`);
    return session;
  }
}

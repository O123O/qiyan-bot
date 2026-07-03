import type { AppServerPool } from "../app-server/pool.ts";
import type { Clock } from "../core/clock.ts";
import type { SessionRegistry } from "../registry/session-registry.ts";
import type { FinalMessageStore } from "../sessions/final-messages.ts";
import type { Database } from "../storage/database.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";
import type { RuntimeStore } from "../storage/runtime-store.ts";
import type { AttachmentStore } from "../attachments/store.ts";
import type { ConversationBinding } from "../chat/binding.ts";

interface TerminalTurn { id: string; status: string; startedAt?: number | null; completedAt: number | null; items: Array<{ type: string; id: string; text?: string; phase?: string | null }> }
interface ExpectedGeneration { mappingId: string; epochId: string }
export interface TerminalObservation {
  endpointId: string;
  threadId: string;
  turnId: string;
  status: string;
  startedAt: number | null;
  completedAt: number;
  finalMessageId: string | null;
}

export class EventRelay {
  constructor(
    private readonly db: Database,
    private readonly pool: AppServerPool,
    private readonly registry: SessionRegistry,
    private readonly runtime: RuntimeStore,
    private readonly finals: FinalMessageStore,
    private readonly deliveries: DeliveryStore,
    private readonly options: { binding(): ConversationBinding; clock: Clock; onTerminal?(event: TerminalObservation): void | Promise<void> },
    private readonly attachments?: Pick<AttachmentStore, "releaseTurn">,
  ) {}

  async handleNotification(endpointId: string, method: string, params: any): Promise<void> {
    if (method === "turn/completed") await this.handleTerminal(endpointId, params.threadId, params.turn as TerminalTurn);
  }

  async handlePermissionBlocked(endpointId: string, event: { threadId?: string; turnId?: string; method: string; params: unknown }): Promise<void> {
    if (!event.threadId) return;
    const mapping = this.mapping(endpointId, event.threadId);
    const state = mapping ? this.runtime.getSession(endpointId, event.threadId, mapping.session.mapping_id) : undefined;
    if (!mapping || mapping.session.lifecycle_state !== "managed" || state?.managementState !== "managed") return;
    const nickname = mapping.nickname;
    const key = `permission:${endpointId}:${event.threadId}:${event.turnId ?? "unknown"}:${event.method}`;
    this.deliveries.prepare({ id: key, kind: "permission", binding: this.options.binding(), body: `[${nickname}] blocked by a permission request`, mandatory: true });
    this.persistEvent(key, endpointId, event.threadId, event.turnId, "permission_blocked", { nickname, turnId: event.turnId ?? null, method: event.method });
    this.runtime.setSession(endpointId, event.threadId, mapping.session.mapping_id, "managed", "permissionBlocked");
  }

  async reconcileEndpoint(endpointId: string): Promise<void> {
    for (const [nickname, session] of Object.entries(this.registry.managedSnapshot().sessions)) {
      if (session.endpoint !== endpointId) continue;
      const state = this.runtime.getSession(endpointId, session.thread_id, session.mapping_id);
      const epoch = this.runtime.currentEpoch(endpointId, session.thread_id, session.mapping_id);
      if (state?.managementState !== "managed" || !epoch) continue;
      const expected = { mappingId: session.mapping_id, epochId: epoch.id };
      const response = await this.pool.request<{ thread: { turns: TerminalTurn[] } }>(endpointId, "thread/read", { threadId: session.thread_id, includeTurns: true });
      if (!this.isCurrentGeneration(endpointId, session.thread_id, expected)) continue;
      const turns = response.thread.turns;
      let index = epoch.baselineTurnId ? turns.findIndex((turn) => turn.id === epoch.baselineTurnId) + 1 : 0;
      if (epoch.baselineTurnId && index === 0) continue;
      if (state.deliveryCursor) {
        const cursorIndex = turns.findIndex((turn) => turn.id === state.deliveryCursor);
        if (cursorIndex >= 0) index = Math.max(index, cursorIndex + 1);
      }
      for (const turn of turns.slice(index)) {
        if (!new Set(["completed", "failed", "interrupted"]).has(turn.status)) break;
        if (!await this.handleTerminal(endpointId, session.thread_id, turn, nickname, true, expected)) break;
        this.runtime.setDeliveryCursor(endpointId, session.thread_id, session.mapping_id, turn.id);
      }
    }
  }

  private async handleTerminal(
    endpointId: string,
    threadId: string,
    turn: TerminalTurn,
    knownNickname?: string,
    authoritative = false,
    expected?: ExpectedGeneration,
  ): Promise<boolean> {
    const mapping = this.mapping(endpointId, threadId);
    const state = mapping ? this.runtime.getSession(endpointId, threadId, mapping.session.mapping_id) : undefined;
    let nickname = knownNickname ?? mapping?.nickname;
    const epoch = mapping ? this.runtime.currentEpoch(endpointId, threadId, mapping.session.mapping_id) : undefined;
    if (!mapping || mapping.session.lifecycle_state !== "managed" || !nickname || state?.managementState !== "managed" || !epoch) return false;
    if (expected && (mapping.session.mapping_id !== expected.mappingId || epoch.id !== expected.epochId)) return false;
    if (expected) nickname = mapping.nickname;
    if (!authoritative) {
      const history = await this.pool.request<{ thread: { turns: TerminalTurn[] } }>(endpointId, "thread/read", { threadId, includeTurns: true });
      const turnIndex = history.thread.turns.findIndex((candidate) => candidate.id === turn.id);
      if (turnIndex < 0) return false;
      if (epoch.baselineTurnId) {
        const baselineIndex = history.thread.turns.findIndex((candidate) => candidate.id === epoch.baselineTurnId);
        if (baselineIndex < 0 || turnIndex <= baselineIndex) return false;
      }
      turn = history.thread.turns[turnIndex]!;
      const directExpected = { mappingId: mapping.session.mapping_id, epochId: epoch.id };
      if (!this.isCurrentGeneration(endpointId, threadId, directExpected)) return false;
      const current = this.mapping(endpointId, threadId)!;
      nickname = current.nickname;
    }
    this.runtime.clearActiveTurn(endpointId, threadId, mapping.session.mapping_id, turn.id);
    this.pool.markTurnTerminal(endpointId, threadId, turn.id);
    const messages = this.finals.persistTerminalTurn(endpointId, threadId, turn, this.options.clock.now());
    const eventId = `terminal:${endpointId}:${threadId}:${turn.id}`;
    this.persistEvent(eventId, endpointId, threadId, turn.id, "turn_terminal", {
      final: true, nickname, endpointId, threadId, turnId: turn.id, completedAt: turn.completedAt ?? this.options.clock.now(), status: turn.status,
      finalMessageIds: messages.map((message) => message.id), deliveryState: "prepared",
    });
    await this.options.onTerminal?.({
      endpointId,
      threadId,
      turnId: turn.id,
      status: turn.status,
      startedAt: turn.startedAt ?? null,
      completedAt: turn.completedAt ?? this.options.clock.now(),
      finalMessageId: messages.at(-1)?.id ?? null,
    });
    if (messages.length === 0 && turn.status !== "completed") {
      this.deliveries.prepare({ id: `${eventId}:warning`, kind: "worker_warning", binding: this.options.binding(), body: `[${nickname}] turn ${turn.id} ${turn.status} without a final response`, mandatory: true });
    }
    for (const message of messages) {
      const status = turn.status === "completed" ? "" : ` · ${turn.status}`;
      this.deliveries.prepare({ id: `worker:${endpointId}:${threadId}:${message.turnId}:${message.itemId}`, kind: "worker_final", binding: this.options.binding(), body: `[${nickname}${status}] ${message.body}`, mandatory: true });
    }
    this.attachments?.releaseTurn(endpointId, threadId, turn.id);
    return true;
  }

  private isCurrentGeneration(endpointId: string, threadId: string, expected: ExpectedGeneration): boolean {
    const current = this.mapping(endpointId, threadId);
    const state = current ? this.runtime.getSession(endpointId, threadId, current.session.mapping_id) : undefined;
    const epoch = current ? this.runtime.currentEpoch(endpointId, threadId, current.session.mapping_id) : undefined;
    return current?.session.mapping_id === expected.mappingId && current.session.lifecycle_state === "managed"
      && state?.managementState === "managed" && epoch?.id === expected.epochId;
  }

  private persistEvent(id: string, endpointId: string, threadId: string, turnId: string | undefined, kind: string, payload: unknown): void {
    this.db.prepare(`INSERT OR IGNORE INTO events(id, endpoint_id, thread_id, turn_id, kind, payload_json, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
      .run(id, endpointId, threadId, turnId ?? null, kind, JSON.stringify(payload), this.options.clock.now());
  }

  private mapping(endpointId: string, threadId: string) {
    return this.registry.getByIdentity(endpointId, threadId);
  }
}

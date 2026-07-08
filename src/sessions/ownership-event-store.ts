import type { SessionRegistry } from "../registry/session-registry.ts";
import type { Database } from "../storage/database.ts";
import {
  externalOwnershipEventPayload,
  type ExternalOwnershipReleaseStatus,
  type ExternalTurnIncident,
} from "./ownership-watcher.ts";

type OwnershipRegistry = Pick<SessionRegistry, "getByIdentity">;

interface PendingEventRow {
  id: unknown;
  endpoint_id: unknown;
  thread_id: unknown;
  turn_id: unknown;
  payload_json: unknown;
}

export class OwnershipEventStore {
  constructor(
    private readonly db: Database,
    private readonly clock: { now(): number } = { now: () => Date.now() },
  ) {}

  record(incident: ExternalTurnIncident, releaseStatus: ExternalOwnershipReleaseStatus): boolean {
    const payload = externalOwnershipEventPayload(incident, releaseStatus);
    return this.db.prepare(`INSERT OR IGNORE INTO events(id, endpoint_id, thread_id, turn_id, kind, payload_json, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(
      eventId(incident, releaseStatus),
      incident.endpoint,
      incident.thread_id,
      incident.turnId,
      payload.event,
      JSON.stringify(payload),
      this.clock.now(),
    ).changes === 1;
  }

  pending(endpointId?: string): ExternalTurnIncident[] {
    const endpointFilter = endpointId === undefined ? "" : " AND pending.endpoint_id = ?";
    const rows = this.db.prepare(`SELECT pending.id, pending.endpoint_id, pending.thread_id, pending.turn_id, pending.payload_json
      FROM events pending
      LEFT JOIN events completed
        ON completed.id = 'external-release:' || substr(pending.id, length('external-turn:') + 1)
      WHERE pending.kind = 'external_worker_turn_detected' AND completed.id IS NULL${endpointFilter}
      ORDER BY pending.created_at, pending.id`).all(...(endpointId === undefined ? [] : [endpointId])) as unknown as PendingEventRow[];
    return rows.map(parsePendingIncident);
  }

  reconcileReleased(registry: OwnershipRegistry): number {
    let inserted = 0;
    for (const incident of this.pending()) {
      const current = registry.getByIdentity(incident.endpoint, incident.thread_id);
      if (current?.session.mapping_id === incident.mapping_id) continue;
      if (this.record(incident, "completed")) inserted += 1;
    }
    return inserted;
  }
}

function eventId(incident: ExternalTurnIncident, releaseStatus: ExternalOwnershipReleaseStatus): string {
  const prefix = releaseStatus === "pending" ? "external-turn" : "external-release";
  return `${prefix}:${incident.endpoint}:${incident.thread_id}:${incident.mapping_id}:${incident.turnId}`;
}

function parsePendingIncident(row: PendingEventRow): ExternalTurnIncident {
  let payload: unknown;
  try { payload = JSON.parse(String(row.payload_json)); }
  catch { throw new Error("invalid persisted external ownership event"); }
  if (!payload || typeof payload !== "object") throw new Error("invalid persisted external ownership event");
  const value = payload as Record<string, unknown>;
  const endpoint = String(row.endpoint_id);
  const threadId = String(row.thread_id);
  const turnId = String(row.turn_id);
  if (value.event !== "external_worker_turn_detected" || value.releaseStatus !== "pending"
    || typeof value.nickname !== "string" || typeof value.mappingId !== "string" || typeof value.turnId !== "string"
    || value.nickname.length === 0 || value.mappingId.length === 0 || value.turnId !== turnId) {
    throw new Error("invalid persisted external ownership event");
  }
  const incident = {
    nickname: value.nickname,
    endpoint,
    thread_id: threadId,
    mapping_id: value.mappingId,
    turnId,
  };
  if (String(row.id) !== eventId(incident, "pending")) throw new Error("invalid persisted external ownership event");
  return incident;
}

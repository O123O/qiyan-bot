import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ThreadSourceKind } from "../app-server/generated/v2/ThreadSourceKind.ts";
import type { AppServerPool } from "../app-server/pool.ts";
import type { Clock } from "../core/clock.ts";
import { SystemClock } from "../core/clock.ts";
import { AppError } from "../core/errors.ts";
import type { Database } from "../storage/database.ts";
import type { EndpointWorkLease } from "../endpoints/types.ts";

export const DISCOVERY_SOURCE_KINDS: readonly ThreadSourceKind[] = [
  "cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown",
];

export interface DiscoveredSession {
  id: string;
  updatedAt: number;
  cwd: string;
  preview: string;
  archived: boolean;
  [key: string]: unknown;
}

interface ListResponse { data: Array<Record<string, unknown>>; nextCursor: string | null }
interface Cursor { id: string; offset: number; queryHash: string; signature: string }

export class SessionDiscovery {
  private readonly clock: Clock;
  private readonly snapshotTtlMs: number;
  private readonly secret = randomBytes(32).toString("hex");

  constructor(private readonly db: Database, private readonly pool: AppServerPool, options: { clock?: Clock; snapshotTtlMs?: number } = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.snapshotTtlMs = options.snapshotTtlMs ?? 5 * 60_000;
  }

  async list(query: { endpointId: string; search?: string; cwd?: string; limit?: number; cursor?: string }, lease?: EndpointWorkLease): Promise<{ sessions: DiscoveredSession[]; nextCursor?: string }> {
    const limit = query.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("limit must be between 1 and 100");
    const queryHash = this.queryHash(query.endpointId, query.search, query.cwd, limit);
    let snapshotId: string;
    let offset = 0;
    let rows: DiscoveredSession[];

    if (query.cursor) {
      const cursor = this.decodeCursor(query.cursor);
      if (cursor.queryHash !== queryHash) throw new AppError("OPERATION_CONFLICT", "discovery cursor belongs to a different query");
      const record = this.db.prepare("SELECT rows_json, query_hash, expires_at FROM discovery_snapshots WHERE id = ?").get(cursor.id) as Record<string, unknown> | undefined;
      if (!record || Number(record.expires_at) <= this.clock.now()) throw new AppError("OPERATION_UNCERTAIN", "discovery cursor expired or is unknown");
      if (String(record.query_hash) !== queryHash) throw new AppError("OPERATION_CONFLICT", "discovery snapshot query mismatch");
      snapshotId = cursor.id;
      offset = cursor.offset;
      rows = JSON.parse(String(record.rows_json)) as DiscoveredSession[];
    } else {
      this.cleanupExpired();
      rows = await this.fetchAll(query.endpointId, query.cwd, lease);
      if (query.search) {
        const needle = query.search.toLocaleLowerCase();
        rows = rows.filter((row) => `${row.id}\n${row.cwd}\n${row.preview}`.toLocaleLowerCase().includes(needle));
      }
      snapshotId = `snap_${crypto.randomUUID()}`;
      this.db.prepare("INSERT INTO discovery_snapshots(id, query_hash, rows_json, expires_at) VALUES (?, ?, ?, ?)")
        .run(snapshotId, queryHash, JSON.stringify(rows), this.clock.now() + this.snapshotTtlMs);
    }

    const sessions = rows.slice(offset, offset + limit);
    const nextOffset = offset + sessions.length;
    return {
      sessions,
      ...(nextOffset < rows.length ? { nextCursor: this.encodeCursor(snapshotId, nextOffset, queryHash) } : {}),
    };
  }

  cleanupExpired(): number {
    return Number(this.db.prepare("DELETE FROM discovery_snapshots WHERE expires_at <= ?").run(this.clock.now()).changes);
  }

  private async fetchAll(endpointId: string, cwd?: string, lease?: EndpointWorkLease): Promise<DiscoveredSession[]> {
    const rows = new Map<string, DiscoveredSession>();
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const params: Record<string, unknown> = {
          cursor,
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: [...DISCOVERY_SOURCE_KINDS],
          archived,
          useStateDbOnly: false,
        };
        if (cursor === null) delete params.cursor;
        if (cwd !== undefined) params.cwd = cwd;
        const page = await this.pool.request<ListResponse>(endpointId, "thread/list", params, undefined, lease);
        for (const raw of page.data) {
          if (raw.ephemeral === true || raw.parentThreadId != null) continue;
          const id = String(raw.id);
          rows.set(id, { ...raw, id, updatedAt: Number(raw.updatedAt), cwd: String(raw.cwd), preview: String(raw.preview ?? ""), archived });
        }
        cursor = page.nextCursor;
      } while (cursor !== null);
    }
    return [...rows.values()].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
  }

  private queryHash(endpointId: string, search: string | undefined, cwd: string | undefined, limit: number): string {
    return createHash("sha256").update(JSON.stringify({ endpointId, search: search ?? null, cwd: cwd ?? null, limit })).digest("hex");
  }

  private encodeCursor(id: string, offset: number, queryHash: string): string {
    const payload = { id, offset, queryHash };
    const signature = this.sign(payload);
    return Buffer.from(JSON.stringify({ ...payload, signature })).toString("base64url");
  }

  private decodeCursor(value: string): Cursor {
    try {
      const bytes = Buffer.from(value, "base64url");
      if (bytes.toString("base64url") !== value) throw new Error("non-canonical encoding");
      const parsed = JSON.parse(bytes.toString("utf8")) as Cursor;
      if (!parsed.id || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || !parsed.queryHash || !parsed.signature) throw new Error("invalid fields");
      const actual = Buffer.from(parsed.signature, "hex");
      const expected = Buffer.from(this.sign({ id: parsed.id, offset: parsed.offset, queryHash: parsed.queryHash }), "hex");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("invalid signature");
      return parsed;
    } catch {
      throw new AppError("OPERATION_UNCERTAIN", "invalid discovery cursor");
    }
  }

  private sign(value: object): string {
    return createHash("sha256").update(this.secret).update(JSON.stringify(value)).digest("hex");
  }
}

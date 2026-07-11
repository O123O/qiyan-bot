import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { AppError } from "../core/errors.ts";
import type { MappingIdentity } from "../registry/session-registry.ts";
import { inTransaction, type Database } from "../storage/database.ts";
import type { OperationStore } from "../storage/operation-store.ts";
import type { RuntimeStore } from "../storage/runtime-store.ts";
import type { EndpointWorkLease } from "../endpoints/types.ts";
import type { AppServerPool } from "../app-server/pool.ts";
import { isExactThreadNoRollout, isExactThreadNotLoaded, isExactThreadNotMaterialized } from "../app-server/thread-errors.ts";

export interface RolloutCursor {
  device: string;
  inode: string;
  offset: number;
}

export interface RolloutTurnStart {
  turnId: string;
  clientId?: string;
  hasUserMessage?: true;
}

export interface RolloutScanResult {
  cursor: RolloutCursor;
  starts: RolloutTurnStart[];
  openTurn?: RolloutTurnStart;
  malformed?: true;
}

export type RolloutMaterialization =
  | { state: "missing" }
  | { state: "present"; result: RolloutScanResult };

export interface RolloutAccess {
  scan(endpointId: string, requests: ReadonlyArray<{ path: string; threadId: string; cursor?: RolloutCursor }>, lease?: EndpointWorkLease): Promise<RolloutScanResult[]>;
  scanUnmaterialized?(
    endpointId: string,
    request: { path: string; threadId: string },
    lease?: EndpointWorkLease,
  ): Promise<RolloutMaterialization>;
}

export type OwnershipInspection =
  | { state: "owned" }
  | { state: "pending" }
  | { state: "lost" }
  | { state: "external"; turnId: string }
  | { state: "unclassified"; turnId: string };

export type RolloutPathResolution =
  | { state: "resolved"; path: string }
  | { state: "pending" }
  // No rollout exists and none will until the first turn runs (e.g. a Claude session, whose
  // transcript is written only by `claude -p`). Distinct from "pending" (a transient window
  // where a path is expected to bind shortly, as for Codex) so the guard can safely dispatch
  // the first turn instead of deadlocking waiting for a rollout the first turn itself creates.
  | { state: "unstarted" }
  | { state: "lost" };

export type RolloutPathResolver = (
  identity: MappingIdentity,
  lease?: EndpointWorkLease,
) => Promise<RolloutPathResolution>;

export function createAppServerRolloutPathResolver(
  pool: Pick<AppServerPool, "request">,
): RolloutPathResolver {
  return async (identity, lease) => {
    let response: unknown;
    try {
      response = await pool.request(identity.endpoint, "thread/read", {
        threadId: identity.thread_id,
        includeTurns: false,
      }, undefined, lease);
    } catch (error) {
      if (isExactThreadNotMaterialized(error, identity.thread_id)) return { state: "pending" };
      if (isExactThreadNoRollout(error, identity.thread_id)) return { state: "pending" };
      if (!isExactThreadNotLoaded(error, identity.thread_id)) throw error;
      try {
        response = await pool.request(identity.endpoint, "thread/resume", {
          threadId: identity.thread_id,
        }, undefined, lease);
      } catch (resumeError) {
        if (isExactThreadNoRollout(resumeError, identity.thread_id)) return { state: "lost" };
        throw resumeError;
      }
    }
    const path = exactThreadPath(response, identity.thread_id);
    return path === undefined ? { state: "pending" } : { state: "resolved", path };
  };
}

const rolloutReadChunkBytes = 64 * 1024;
const maxRolloutLineBytes = 64 * 1024 * 1024;
const maxReportedStarts = 1024;

// The retry sentinel shared by every rollout/transcript scanner and the
// `retryConcurrentRolloutAppend` harness: a scan that raced a concurrent append
// throws THIS exact message so the harness retries into a stable snapshot. Any
// scanner (Codex or Claude) that reports a mid-scan append MUST throw this string.
export const ROLLOUT_APPENDED_WHILE_SCANNING = "rollout appended while scanning";

function ownershipUnclassified(message: string): AppError {
  return new AppError("OPERATION_UNCERTAIN", message, { recovery: "ownership_unclassified" });
}

function externalTurn(threadId: string): AppError {
  return new AppError("SESSION_BUSY", `thread ${threadId} has an externally started turn`, { recovery: "external_turn" });
}

export class SessionOwnershipGuard {
  constructor(
    private readonly db: Database,
    private readonly runtime: RuntimeStore,
    private readonly operations: OperationStore,
    private readonly access: RolloutAccess,
    private readonly resolvePath?: RolloutPathResolver,
  ) {}

  recordUnmaterialized(identity: MappingIdentity, path?: string): void {
    if (path !== undefined && !validRolloutPath(path, identity.thread_id)) {
      throw new AppError("OPERATION_UNCERTAIN", "managed rollout path is invalid");
    }
    inTransaction(this.db, () => {
      this.db.prepare(`INSERT OR IGNORE INTO session_rollout_ownership
        (endpoint_id, thread_id, mapping_id, rollout_path, device, inode, byte_offset, materialized, external_turn_id, updated_at)
        VALUES (?, ?, ?, ?, '', '', 0, 0, NULL, ?)`).run(
        identity.endpoint, identity.thread_id, identity.mapping_id, path ?? "", Date.now(),
      );
      let existing = this.row(identity);
      if (path !== undefined && existing?.rolloutPath === undefined) {
        this.db.prepare(`UPDATE session_rollout_ownership SET rollout_path = ?, updated_at = ?
          WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND rollout_path = ''`).run(
          path, Date.now(), identity.endpoint, identity.thread_id, identity.mapping_id,
        );
        existing = this.row(identity);
      }
      if (path !== undefined && existing?.rolloutPath !== path) {
        throw new AppError("OPERATION_UNCERTAIN", "managed rollout path changed");
      }
    });
  }

  async initialize(
    identity: MappingIdentity,
    path: string,
    lease?: EndpointWorkLease,
    options: { allowUnmaterialized?: boolean; authorizedTurnId?: string } = {},
  ): Promise<void> {
    let existing = this.row(identity);
    if (existing) {
      this.recordUnmaterialized(identity, path);
      if (options.authorizedTurnId) this.recordOwnedTurn(identity, options.authorizedTurnId);
      existing = this.row(identity)!;
      const inspection = await this.inspectCurrent(
        identity,
        lease,
        !existing.materialized && options.allowUnmaterialized !== true,
      );
      if (inspection.state === "external") throw externalTurn(identity.thread_id);
      if (inspection.state === "unclassified") throw ownershipUnclassified("rollout ownership is temporarily uncertain");
      return;
    }
    const materialization = options.allowUnmaterialized
      ? await this.scanUnmaterialized(identity, path, lease)
      : await this.scanMaterialized(identity, path, lease);
    if (materialization.state === "missing") {
      this.db.prepare(`INSERT INTO session_rollout_ownership
        (endpoint_id, thread_id, mapping_id, rollout_path, device, inode, byte_offset, materialized, external_turn_id, updated_at)
        VALUES (?, ?, ?, ?, '', '', 0, 0, NULL, ?)`).run(
        identity.endpoint, identity.thread_id, identity.mapping_id, path, Date.now(),
      );
      return;
    }
    const result = materialization.result;
    if (!result) throw ownershipUnclassified("rollout ownership scan returned no result");
    const goalControlled = this.runtime.goalControlled(identity.endpoint, identity.thread_id, identity.mapping_id);
    const pendingUnclassified = result.openTurn
      && !result.starts.some((turn) => turn.turnId === result.openTurn!.turnId)
      && !this.ownsObservedTurn(identity, result.openTurn)
      && result.openTurn.turnId !== options.authorizedTurnId
      && result.openTurn.hasUserMessage !== true ? result.openTurn : undefined;
    const candidates = options.allowUnmaterialized ? [...result.starts] : [];
    if (result.openTurn && !candidates.some((turn) => turn.turnId === result.openTurn!.turnId)
      && (result.openTurn.hasUserMessage === true || this.ownsObservedTurn(identity, result.openTurn)
        || result.openTurn.turnId === options.authorizedTurnId)) candidates.push(result.openTurn);
    const classified = candidates.map((turn) => ({
      turn,
      state: this.classifyObservedTurn(identity, turn, goalControlled, options.authorizedTurnId),
    }));
    const external = classified.find((item) => item.state === "external")?.turn;
    const pending = pendingUnclassified ?? classified.find((item) => item.state === "unclassified")?.turn;
    if ((result.malformed || pending) && !external) throw ownershipUnclassified("rollout ownership is temporarily uncertain");
    inTransaction(this.db, () => {
      this.db.prepare(`INSERT INTO session_rollout_ownership
        (endpoint_id, thread_id, mapping_id, rollout_path, device, inode, byte_offset, materialized, external_turn_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
        identity.endpoint, identity.thread_id, identity.mapping_id, path,
        result.cursor.device, result.cursor.inode, result.cursor.offset, external?.turnId ?? null, Date.now(),
      );
      if (options.authorizedTurnId && !external) this.recordOwnedTurn(identity, options.authorizedTurnId);
      for (const item of classified) if (item.state === "owned") this.recordOwnedTurn(identity, item.turn.turnId);
      if (external) {
        this.revokeAuthorizedTurn(identity, external.turnId);
        const state = this.runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id);
        if (state) this.runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "unadopting", state.nativeStatus);
      }
    });
    if (external) throw externalTurn(identity.thread_id);
  }

  async inspect(identity: MappingIdentity, lease?: EndpointWorkLease, options?: { requireMaterialized?: boolean }): Promise<OwnershipInspection> {
    return this.inspectCurrent(identity, lease, false, options?.requireMaterialized ?? false);
  }

  private async inspectCurrent(
    identity: MappingIdentity,
    lease: EndpointWorkLease | undefined,
    requireClassifiedTurn: boolean,
    requireMaterialized = false,
  ): Promise<OwnershipInspection> {
    let existing = this.row(identity);
    if (!existing) throw ownershipUnclassified("session ownership guard is not initialized");
    if (!existing.rolloutPath) {
      if (!this.resolvePath) return { state: "pending" };
      const resolution = await this.resolvePath(identity, lease);
      if (resolution.state === "unstarted") {
        // The endpoint reports no rollout exists and none will until the first turn runs
        // (a Claude session's transcript is only written by the first `claude -p`). No turn —
        // ours or external — has run, so there is nothing to conflict with and the first
        // dispatch is safe; this mirrors the "missing" materialization case below (path known
        // but file absent). A Codex thread instead binds its path shortly after create, so its
        // pathless window is a transient "pending" (below), NOT "unstarted".
        if (requireMaterialized) return { state: "lost" };
        if (requireClassifiedTurn) throw ownershipUnclassified("pending rollout does not prove the native turns are owned");
        return { state: "owned" };
      }
      if (resolution.state !== "resolved") return resolution;
      this.recordUnmaterialized(identity, resolution.path);
      existing = this.row(identity)!;
    }
    const rolloutPath = existing.rolloutPath;
    if (!rolloutPath) throw ownershipUnclassified("managed rollout path is not materialized");
    const materialization = existing.materialized
      ? await this.scanMaterialized(identity, rolloutPath, lease, {
        device: existing.device,
        inode: existing.inode,
        offset: existing.byteOffset,
      })
      : await this.scanUnmaterialized(identity, rolloutPath, lease);
    if (materialization.state === "missing") {
      // A rollout that was recorded but never durably written to disk is not recoverable after
      // the endpoint forgets its in-memory thread. Create-completion recovery asks for this
      // strict check so a never-materialized thread is dropped instead of blessed as owned.
      if (requireMaterialized) return { state: "lost" };
      if (requireClassifiedTurn) throw ownershipUnclassified("pending rollout does not prove the native turns are owned");
      return { state: "owned" };
    }
    const result = materialization.result;
    if (!result) throw ownershipUnclassified("rollout ownership scan returned no result");
    const goalControlled = this.runtime.goalControlled(identity.endpoint, identity.thread_id, identity.mapping_id);
    const unclassified = result.openTurn && !result.starts.some((turn) => turn.turnId === result.openTurn!.turnId)
      && !this.ownsObservedTurn(identity, result.openTurn) ? result.openTurn : undefined;
    const candidates = [...result.starts];
    if (result.openTurn && !candidates.some((turn) => turn.turnId === result.openTurn!.turnId)
      && this.ownsObservedTurn(identity, result.openTurn)) candidates.push(result.openTurn);
    const classified = candidates.map((turn) => ({ turn, state: this.classifyObservedTurn(identity, turn, goalControlled) }));
    const external = classified.find((item) => item.state === "external")?.turn;
    const pending = unclassified ?? classified.find((item) => item.state === "unclassified")?.turn;
    const incidentTurnId = existing.externalTurnId ?? external?.turnId;
    if (result.malformed && !incidentTurnId) throw ownershipUnclassified("rollout ownership is temporarily uncertain");
    if (requireClassifiedTurn && !incidentTurnId && (classified.length === 0 || pending)) {
      throw ownershipUnclassified("pending rollout does not prove the native turns are owned");
    }
    if (pending && !incidentTurnId) return { state: "unclassified", turnId: pending.turnId };
    inTransaction(this.db, () => {
      for (const item of classified) if (item.state === "owned") this.recordOwnedTurn(identity, item.turn.turnId);
      if (incidentTurnId) this.revokeAuthorizedTurn(identity, incidentTurnId);
      this.updateCursor(identity, existing, result.cursor, external?.turnId);
      if (incidentTurnId) {
        const state = this.runtime.getSession(identity.endpoint, identity.thread_id, identity.mapping_id);
        if (state) this.runtime.setSession(identity.endpoint, identity.thread_id, identity.mapping_id, "unadopting", state.nativeStatus);
      }
    });
    if (incidentTurnId) return { state: "external", turnId: incidentTurnId };
    return { state: "owned" };
  }

  async inspectIfInitialized(identity: MappingIdentity, lease?: EndpointWorkLease, options?: { requireMaterialized?: boolean }): Promise<
    { state: "uninitialized" } | OwnershipInspection
  > {
    return this.row(identity) ? this.inspect(identity, lease, options) : { state: "uninitialized" };
  }

  release(identity: MappingIdentity): void {
    this.db.prepare("DELETE FROM session_rollout_ownership WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?")
      .run(identity.endpoint, identity.thread_id, identity.mapping_id);
  }

  ownsTurn(identity: MappingIdentity, turnId: string): boolean {
    if (this.operations.ownsWorkerTurn({ turnId })) return true;
    return this.db.prepare(`SELECT 1 FROM session_rollout_owned_turns
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND turn_id = ?`)
      .get(identity.endpoint, identity.thread_id, identity.mapping_id, turnId) !== undefined;
  }

  authorizeTurn(identity: MappingIdentity, turnId: string): void {
    if (!this.row(identity)) throw ownershipUnclassified("session ownership guard is not initialized");
    this.recordOwnedTurn(identity, turnId);
  }

  authorizeTurnIfInitialized(identity: MappingIdentity, turnId: string): boolean {
    if (!this.row(identity)) return false;
    this.recordOwnedTurn(identity, turnId);
    return true;
  }

  private ownsObservedTurn(identity: MappingIdentity, turn: RolloutTurnStart): boolean {
    return this.operations.ownsWorkerTurn(turn) || this.isAuthorizedTurn(identity, turn.turnId);
  }

  private isAuthorizedTurn(identity: MappingIdentity, turnId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM session_rollout_owned_turns
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND turn_id = ?`)
      .get(identity.endpoint, identity.thread_id, identity.mapping_id, turnId) !== undefined;
  }

  private classifyObservedTurn(
    identity: MappingIdentity,
    turn: RolloutTurnStart,
    goalControlled: boolean,
    authorizedTurnId?: string,
  ): "owned" | "external" | "unclassified" {
    if (this.operations.ownsWorkerTurn(turn)) return "owned";
    if (turn.hasUserMessage === true) return "external";
    if (turn.turnId === authorizedTurnId || this.isAuthorizedTurn(identity, turn.turnId) || goalControlled) return "owned";
    return "unclassified";
  }

  private row(identity: MappingIdentity): OwnershipRow | undefined {
    const row = this.db.prepare(`SELECT rollout_path, device, inode, byte_offset, materialized, external_turn_id
      FROM session_rollout_ownership WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?`)
      .get(identity.endpoint, identity.thread_id, identity.mapping_id) as Record<string, unknown> | undefined;
    const rolloutPath = row ? String(row.rollout_path) : "";
    return row ? {
      ...(rolloutPath ? { rolloutPath } : {}), device: String(row.device), inode: String(row.inode), byteOffset: Number(row.byte_offset),
      materialized: Number(row.materialized) === 1,
      ...(row.external_turn_id ? { externalTurnId: String(row.external_turn_id) } : {}),
    } : undefined;
  }

  private updateCursor(identity: MappingIdentity, expected: OwnershipRow, cursor: RolloutCursor, externalTurnId?: string): void {
    if (!expected.rolloutPath) throw ownershipUnclassified("managed rollout path is not materialized");
    const changed = this.db.prepare(`UPDATE session_rollout_ownership
      SET device = ?, inode = ?, byte_offset = ?, materialized = 1, external_turn_id = COALESCE(external_turn_id, ?), updated_at = ?
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ?
        AND rollout_path = ? AND device = ? AND inode = ? AND byte_offset = ? AND materialized = ? AND external_turn_id IS ?`).run(
      cursor.device, cursor.inode, cursor.offset, externalTurnId ?? null, Date.now(),
      identity.endpoint, identity.thread_id, identity.mapping_id,
      expected.rolloutPath, expected.device, expected.inode, expected.byteOffset, expected.materialized ? 1 : 0, expected.externalTurnId ?? null,
    ).changes;
    if (changed !== 1) throw new AppError("OPERATION_UNCERTAIN", "session ownership cursor changed concurrently");
  }

  private recordOwnedTurn(identity: MappingIdentity, turnId: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO session_rollout_owned_turns
      (endpoint_id, thread_id, mapping_id, turn_id, recorded_at) VALUES (?, ?, ?, ?, ?)`)
      .run(identity.endpoint, identity.thread_id, identity.mapping_id, turnId, Date.now());
  }

  private revokeAuthorizedTurn(identity: MappingIdentity, turnId: string): void {
    this.db.prepare(`DELETE FROM session_rollout_owned_turns
      WHERE endpoint_id = ? AND thread_id = ? AND mapping_id = ? AND turn_id = ?`)
      .run(identity.endpoint, identity.thread_id, identity.mapping_id, turnId);
  }

  private async scanMaterialized(
    identity: MappingIdentity,
    path: string,
    lease?: EndpointWorkLease,
    cursor?: RolloutCursor,
  ): Promise<RolloutMaterialization> {
    const [result] = await this.access.scan(identity.endpoint, [{ path, threadId: identity.thread_id, ...(cursor ? { cursor } : {}) }], lease);
    if (!result) throw ownershipUnclassified("rollout ownership scan returned no result");
    return { state: "present", result };
  }

  private async scanUnmaterialized(identity: MappingIdentity, path: string, lease?: EndpointWorkLease): Promise<RolloutMaterialization> {
    if (!this.access.scanUnmaterialized) throw ownershipUnclassified("rollout materialization cannot be checked safely");
    return this.access.scanUnmaterialized(identity.endpoint, { path, threadId: identity.thread_id }, lease);
  }
}

interface OwnershipRow {
  rolloutPath?: string;
  device: string;
  inode: string;
  byteOffset: number;
  materialized: boolean;
  externalTurnId?: string;
}

export async function scanLocalRollout(request: {
  path: string;
  threadId: string;
  cursor?: RolloutCursor;
  collectFromStart?: true;
}): Promise<RolloutScanResult> {
  if (!validRolloutPath(request.path, request.threadId)) {
    throw new Error("invalid rollout ownership scan request");
  }
  const offset = request.cursor?.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid rollout ownership cursor");
  const file = await open(request.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await file.stat({ bigint: true });
    if (!state.isFile() || state.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid rollout ownership cursor");
    const device = state.dev.toString(10);
    const inode = state.ino.toString(10);
    if (request.cursor && (request.cursor.device !== device || request.cursor.inode !== inode)) throw new Error("rollout identity changed");
    if (BigInt(offset) > state.size) throw new Error("rollout was truncated");
    const parsed = await parseRolloutFile(file, offset, Number(state.size), request.cursor !== undefined || request.collectFromStart === true);
    const after = await file.stat({ bigint: true });
    if (after.dev !== state.dev || after.ino !== state.ino) throw new Error("rollout identity changed");
    if (after.size < state.size) throw new Error("rollout was truncated");
    if (after.size > state.size) throw new Error(ROLLOUT_APPENDED_WHILE_SCANNING);
    if (after.mtimeNs !== state.mtimeNs) throw new Error("rollout changed while scanning");
    return parsed.result({ device, inode, offset });
  } finally {
    await file.close();
  }
}

function validRolloutPath(path: string, threadId: string): boolean {
  const name = basename(path);
  return isAbsolute(path) && safeThreadId(threadId) && name.startsWith("rollout-") && name.endsWith(`-${threadId}.jsonl`);
}

function exactThreadPath(response: unknown, threadId: string): string | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new AppError("OPERATION_UNCERTAIN", "rollout path lookup returned invalid data");
  }
  const thread = (response as Record<string, unknown>).thread;
  if (!thread || typeof thread !== "object" || Array.isArray(thread)
    || (thread as Record<string, unknown>).id !== threadId) {
    throw new AppError("OPERATION_UNCERTAIN", "rollout path lookup returned a different thread");
  }
  const path = (thread as Record<string, unknown>).path;
  if (path === null || path === undefined) return undefined;
  if (typeof path !== "string") throw new AppError("OPERATION_UNCERTAIN", "rollout path lookup returned invalid data");
  return path;
}

interface PendingTurn extends RolloutTurnStart { startOffset: number; sawUserMessage: boolean }

class RolloutParser {
  private readonly starts: RolloutTurnStart[] = [];
  private current: PendingTurn | undefined;
  private parsedEnd: number;
  private malformedOffset: number | undefined;

  constructor(baseOffset: number, private readonly collectStarts: boolean) { this.parsedEnd = baseOffset; }

  consume(raw: Buffer, lineStart: number, lineEnd: number): void {
    this.parsedEnd = lineEnd;
    if (raw.byteLength === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(raw.toString("utf8")) as unknown;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.malformedOffset ??= lineStart;
      if (this.current?.sawUserMessage) this.report(this.current);
      this.current = undefined;
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const payload = record.payload;
    if (record.type !== "event_msg" || typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const event = payload as Record<string, unknown>;
    const type = event.type;
    const turnId = typeof event.turn_id === "string" ? event.turn_id : undefined;
    if ((type === "task_started" || type === "turn_started") && turnId) {
      if (this.current) this.report(this.current);
      this.current = { turnId, startOffset: lineStart, sawUserMessage: false };
      return;
    }
    if (type === "user_message" && this.current) {
      this.current.sawUserMessage = true;
      if (typeof event.client_id === "string" && event.client_id.length > 0) this.current.clientId = event.client_id;
      return;
    }
    if ((type === "task_complete" || type === "turn_complete" || type === "turn_aborted")
      && this.current && (!turnId || turnId === this.current.turnId)) {
      this.report(this.current);
      this.current = undefined;
    }
  }

  result(identity: RolloutCursor): RolloutScanResult {
    if (this.current?.sawUserMessage) this.report(this.current);
    const semanticOffset = this.current && !this.current.sawUserMessage ? this.current.startOffset : this.parsedEnd;
    const cursorOffset = this.malformedOffset === undefined ? semanticOffset : Math.min(semanticOffset, this.malformedOffset);
    return {
      cursor: { ...identity, offset: cursorOffset },
      starts: this.starts,
      ...(this.current ? { openTurn: publicStart(this.current) } : {}),
      ...(this.malformedOffset === undefined ? {} : { malformed: true }),
    };
  }

  private report(turn: PendingTurn): void {
    if (!this.collectStarts) return;
    if (this.starts.length >= maxReportedStarts) throw new Error("rollout ownership scan contains too many turns");
    this.starts.push(publicStart(turn));
  }
}

async function parseRolloutFile(
  file: Awaited<ReturnType<typeof open>>,
  offset: number,
  size: number,
  collectStarts: boolean,
): Promise<RolloutParser> {
  const parser = new RolloutParser(offset, collectStarts);
  let position = offset;
  let carry = Buffer.alloc(0);
  let carryStart = offset;
  while (position < size) {
    const chunk = Buffer.allocUnsafe(Math.min(rolloutReadChunkBytes, size - position));
    const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) throw new Error("rollout was truncated");
    position += bytesRead;
    const bytes = carry.byteLength === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
    let lineStart = 0;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      parser.consume(bytes.subarray(lineStart, index), carryStart + lineStart, carryStart + index + 1);
      lineStart = index + 1;
    }
    carryStart += lineStart;
    carry = Buffer.from(bytes.subarray(lineStart));
    if (carry.byteLength > maxRolloutLineBytes) throw new Error("rollout line exceeds the maximum size");
  }
  return parser;
}

function publicStart(turn: PendingTurn): RolloutTurnStart {
  return {
    turnId: turn.turnId,
    ...(turn.clientId ? { clientId: turn.clientId } : {}),
    ...(turn.sawUserMessage ? { hasUserMessage: true as const } : {}),
  };
}

function safeThreadId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
}

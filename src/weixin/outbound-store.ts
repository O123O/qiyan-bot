import { createHash, randomBytes } from "node:crypto";
import type { ConversationBinding, JsonValue } from "../chat/binding.ts";
import type { UncertainDeliveryResolution } from "../chat/contracts.ts";
import type { DeliveryRecord, DeliveryStore } from "../storage/delivery-store.ts";
import type { Database } from "../storage/database.ts";
import { inTransaction } from "../storage/database.ts";
import type {
  WeixinSendMessageRequest,
  WeixinUploadRequest,
  WeixinUploadTarget,
} from "./api-client.ts";

const DEFAULT_TEXT_BYTES = 4_000;
const MAX_RECEIPT_BYTES = 16 * 1024;
const HEX_32 = /^[a-f0-9]{32}$/u;

export type WeixinOutboundStepState = "prepared" | "dispatching" | "succeeded" | "uncertain";
export type WeixinOutboundStepKind = "text" | "upload_parameters" | "upload" | "caption" | "image" | "file";

export interface WeixinFrozenDestination {
  generationId: string;
  botId: string;
  ownerUserId: string;
  routeTokenId?: string;
}

interface WeixinOutboundStepBase {
  id: string;
  deliveryId: string;
  generationId: string;
  ordinal: number;
  kind: WeixinOutboundStepKind;
  state: WeixinOutboundStepState;
  requestHash: string;
  clientId: string;
  botId: string;
  ownerUserId: string;
  routeTokenId?: string;
  receipt?: JsonValue;
}

export interface WeixinTextStep extends WeixinOutboundStepBase {
  kind: "text" | "caption";
  text: string;
}

export interface WeixinBinaryStep extends WeixinOutboundStepBase {
  kind: "upload_parameters" | "upload" | "image" | "file";
}

export type WeixinOutboundStep = WeixinTextStep | WeixinBinaryStep;

export interface WeixinAttachmentPlan {
  deliveryId: string;
  generationId: string;
  botId: string;
  ownerUserId: string;
  routeTokenId?: string;
  kind: "image" | "file";
  displayName: string;
  mediaType: string;
  aesKeyHex: string;
  fileKey: string;
  plaintextMd5: string;
  plaintextSize: number;
  ciphertextSize: number;
  steps: readonly WeixinOutboundStep[];
}

export interface WeixinAttachmentPlanInput {
  kind: "image" | "file";
  displayName: string;
  mediaType: string;
  plaintextMd5: string;
  plaintextSize: number;
}

interface StepRow {
  id: string;
  delivery_id: string;
  generation_id: string;
  ordinal: number;
  kind: string;
  state: WeixinOutboundStepState;
  request_hash: string;
  request_json: string;
  receipt_json: string | null;
  route_token_id: string | null;
  client_id: string | null;
  plan_json: string | null;
}

interface TextPlanDocument {
  version: 1;
  type: "text";
  botId: string;
  ownerUserId: string;
}

interface AttachmentPlanDocument {
  version: 1;
  type: "attachment";
  kind: "image" | "file";
  botId: string;
  ownerUserId: string;
  displayName: string;
  mediaType: string;
  aesKeyHex: string;
  fileKey: string;
  plaintextMd5: string;
  plaintextSize: number;
  ciphertextSize: number;
}

interface PlannedStep {
  step: WeixinOutboundStep;
  requestJson: string;
  planJson: string;
}

export class WeixinOutboundStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
    private readonly nextKey: () => Buffer = () => randomBytes(16),
  ) {}

  prepareText(delivery: DeliveryRecord, target: WeixinFrozenDestination): readonly WeixinTextStep[] {
    return inTransaction(this.db, () => {
      this.validateDelivery(delivery, target);
      const existing = this.list(delivery.id);
      if (existing.some((step) => step.kind !== "text")) throw immutablePlanError();
      const routeTokenId = existing.length > 0 ? existing[0]!.routeTokenId : this.selectRouteToken(target);
      const expected = splitWeixinText(delivery.body)
        .map((text, ordinal) => this.textBlueprint(delivery.id, target, routeTokenId, text, ordinal, "text"));
      if (existing.length > 0) {
        this.assertSamePlan(existing, expected);
        return existing as readonly WeixinTextStep[];
      }
      this.insertPlans(expected.map((step) => ({
        step,
        requestJson: JSON.stringify({ text: step.text }),
        planJson: JSON.stringify({
          version: 1, type: "text", botId: step.botId, ownerUserId: step.ownerUserId,
        } satisfies TextPlanDocument),
      })));
      return this.list(delivery.id) as readonly WeixinTextStep[];
    });
  }

  prepareAttachment(
    delivery: DeliveryRecord,
    target: WeixinFrozenDestination,
    input: WeixinAttachmentPlanInput,
  ): WeixinAttachmentPlan {
    return inTransaction(this.db, () => {
      this.validateDelivery(delivery, target);
      validateAttachmentInput(delivery, input);
      const existing = this.list(delivery.id);
      if (existing.length > 0) {
        const plan = this.attachmentPlan(delivery.id);
        const expected = this.attachmentBlueprints(delivery, target, plan.routeTokenId, input, plan.aesKeyHex, plan.fileKey);
        this.assertSamePlan(existing, expected.map(({ step }) => step));
        return plan;
      }
      const key = this.nextKey();
      if (key.length !== 16) throw new Error("WeChat attachment AES key is invalid");
      const routeTokenId = this.selectRouteToken(target);
      const aesKeyHex = key.toString("hex");
      const fileKey = digest32(["weixin-file-key", delivery.id]);
      this.insertPlans(this.attachmentBlueprints(delivery, target, routeTokenId, input, aesKeyHex, fileKey));
      return this.attachmentPlan(delivery.id);
    });
  }

  attachmentPlan(deliveryId: string): WeixinAttachmentPlan {
    const rows = this.rows(deliveryId);
    if (rows.length === 0 || rows.some((row) => row.kind === "text")) throw new Error("WeChat attachment plan is unavailable");
    const first = rows[0]!;
    const document = parseAttachmentPlan(first.plan_json);
    for (const row of rows) {
      if (row.plan_json !== first.plan_json || row.generation_id !== first.generation_id
        || row.route_token_id !== first.route_token_id) throw new Error("WeChat attachment plan is invalid");
    }
    return {
      deliveryId,
      generationId: first.generation_id,
      botId: document.botId,
      ownerUserId: document.ownerUserId,
      ...(first.route_token_id === null ? {} : { routeTokenId: first.route_token_id }),
      kind: document.kind,
      displayName: document.displayName,
      mediaType: document.mediaType,
      aesKeyHex: document.aesKeyHex,
      fileKey: document.fileKey,
      plaintextMd5: document.plaintextMd5,
      plaintextSize: document.plaintextSize,
      ciphertextSize: document.ciphertextSize,
      steps: rows.map((row) => this.toStep(row)),
    };
  }

  get(stepId: string): WeixinOutboundStep | undefined {
    const row = this.db.prepare("SELECT * FROM weixin_outbound_steps WHERE id = ?").get(stepId) as unknown as StepRow | undefined;
    return row ? this.toStep(row) : undefined;
  }

  list(deliveryId: string): readonly WeixinOutboundStep[] {
    return this.rows(deliveryId).map((row) => this.toStep(row));
  }

  begin(stepId: string): void {
    const changed = this.db.prepare(`UPDATE weixin_outbound_steps SET state = 'dispatching', updated_at = ?
      WHERE id = ? AND state = 'prepared'`).run(this.now(), stepId).changes;
    if (changed !== 1) throw new Error("WeChat outbound step state is not prepared");
  }

  succeed(stepId: string, receipt: JsonValue): void {
    const encoded = JSON.stringify(receipt);
    if (Buffer.byteLength(encoded) > MAX_RECEIPT_BYTES) throw new Error("WeChat outbound receipt exceeds limit");
    const changed = this.db.prepare(`UPDATE weixin_outbound_steps
      SET state = 'succeeded', receipt_json = ?, updated_at = ? WHERE id = ? AND state = 'dispatching'`)
      .run(encoded, this.now(), stepId).changes;
    if (changed !== 1) throw new Error("WeChat outbound step state is not dispatching");
  }

  markUncertain(stepId: string): void {
    const changed = this.db.prepare(`UPDATE weixin_outbound_steps SET state = 'uncertain', updated_at = ?
      WHERE id = ? AND state = 'dispatching'`).run(this.now(), stepId).changes;
    if (changed !== 1) throw new Error("WeChat outbound step state is not dispatching");
  }

  failTerminal(stepId: string, deliveries: DeliveryStore): void {
    inTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT delivery_id, state FROM weixin_outbound_steps WHERE id = ?`)
        .get(stepId) as { delivery_id: string; state: WeixinOutboundStepState } | undefined;
      if (!row || row.state !== "dispatching") throw new Error("WeChat outbound step state is not dispatching");
      if (!deliveries.failInTransaction(row.delivery_id)) throw new Error("WeChat delivery cannot fail terminally");
      const changed = this.db.prepare(`UPDATE weixin_outbound_steps SET state = 'prepared', updated_at = ?
        WHERE id = ? AND state = 'dispatching'`).run(this.now(), stepId).changes;
      if (changed !== 1) throw new Error("WeChat outbound step state changed unexpectedly");
    });
  }

  markDispatchingUncertain(): number {
    return Number(this.db.prepare(`UPDATE weixin_outbound_steps SET state = 'uncertain', updated_at = ?
      WHERE state = 'dispatching'`).run(this.now()).changes);
  }

  reconcile(deliveryId: string): UncertainDeliveryResolution {
    const steps = this.list(deliveryId);
    if (steps.some((step) => step.state === "dispatching" || step.state === "uncertain")) return { outcome: "unresolved" };
    let sawPrepared = false;
    for (const step of steps) {
      if (step.state === "prepared") sawPrepared = true;
      else if (step.state === "succeeded" && sawPrepared) return { outcome: "unresolved" };
    }
    if (steps.length > 0 && steps.every((step) => step.state === "succeeded")) {
      return { outcome: "confirmed", receipt: { kind: "weixin", stepCount: steps.length } };
    }
    return { outcome: "resume_safe" };
  }

  resolveRouteToken(step: Pick<WeixinOutboundStep, "generationId" | "routeTokenId">): string | undefined {
    if (step.routeTokenId === undefined) return undefined;
    const row = this.db.prepare(`SELECT token FROM weixin_route_tokens WHERE generation_id = ? AND id = ?`)
      .get(step.generationId, step.routeTokenId) as { token: string } | undefined;
    if (!row) throw new Error("WeChat outbound route token is unavailable");
    return row.token;
  }

  messageRequest(step: WeixinTextStep): WeixinSendMessageRequest {
    const contextToken = this.resolveRouteToken(step);
    return { msg: {
      from_user_id: "",
      to_user_id: step.ownerUserId,
      client_id: step.clientId,
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: step.text } }],
      ...(contextToken === undefined ? {} : { context_token: contextToken }),
    } };
  }

  uploadRequest(plan: WeixinAttachmentPlan): WeixinUploadRequest {
    return {
      fileKey: plan.fileKey,
      mediaType: plan.kind === "image" ? 1 : 3,
      ownerUserId: plan.ownerUserId,
      plaintextSize: plan.plaintextSize,
      plaintextMd5: plan.plaintextMd5,
      ciphertextSize: plan.ciphertextSize,
      aesKeyHex: plan.aesKeyHex,
    };
  }

  uploadTarget(plan: WeixinAttachmentPlan): WeixinUploadTarget {
    const step = plan.steps.find((candidate) => candidate.kind === "upload_parameters");
    const receipt = step?.receipt === undefined ? undefined : record(step.receipt);
    const url = receipt?.url;
    if (step?.state !== "succeeded" || typeof url !== "string" || Buffer.byteLength(url) > MAX_RECEIPT_BYTES) {
      throw new Error("WeChat upload target checkpoint is unavailable");
    }
    return { url: new URL(url) };
  }

  mediaRequest(plan: WeixinAttachmentPlan, step: WeixinBinaryStep): WeixinSendMessageRequest {
    if (step.kind !== plan.kind) throw new Error("WeChat media step is inconsistent");
    const upload = plan.steps.find((candidate) => candidate.kind === "upload");
    const receipt = upload?.receipt === undefined ? undefined : record(upload.receipt);
    const encryptedQueryParameter = receipt?.encryptedQueryParameter;
    if (upload?.state !== "succeeded" || typeof encryptedQueryParameter !== "string"
      || Buffer.byteLength(encryptedQueryParameter) > MAX_RECEIPT_BYTES) {
      throw new Error("WeChat upload receipt checkpoint is unavailable");
    }
    const media = {
      encrypt_query_param: encryptedQueryParameter,
      aes_key: Buffer.from(plan.aesKeyHex, "ascii").toString("base64"),
      encrypt_type: 1,
    };
    const item = plan.kind === "image"
      ? { type: 2, image_item: { media, mid_size: plan.ciphertextSize } }
      : { type: 4, file_item: { media, file_name: plan.displayName, len: String(plan.plaintextSize) } };
    const contextToken = this.resolveRouteToken(step);
    return { msg: {
      from_user_id: "",
      to_user_id: plan.ownerUserId,
      client_id: step.clientId,
      message_type: 2,
      message_state: 2,
      item_list: [item],
      ...(contextToken === undefined ? {} : { context_token: contextToken }),
    } };
  }

  private validateDelivery(delivery: DeliveryRecord, target: WeixinFrozenDestination): void {
    if (delivery.binding.adapterId !== "weixin") throw new Error("WeChat outbound delivery adapter is inconsistent");
    validateDestination(target);
    const account = this.db.prepare(`SELECT bot_id, owner_user_id FROM weixin_account_generations
      WHERE generation_id = ? AND active = 1 AND authorization_state = 'active'`).get(target.generationId) as
      { bot_id: string; owner_user_id: string } | undefined;
    if (!account || account.bot_id !== target.botId || account.owner_user_id !== target.ownerUserId) {
      throw new Error("WeChat outbound destination is inactive or inconsistent");
    }
    const bindingTarget = parseWeixinDestination(delivery.binding);
    if (bindingTarget.generationId !== target.generationId || bindingTarget.botId !== target.botId
      || bindingTarget.ownerUserId !== target.ownerUserId || bindingTarget.routeTokenId !== target.routeTokenId) {
      throw new Error("WeChat outbound destination is inconsistent");
    }
  }

  private selectRouteToken(target: WeixinFrozenDestination): string | undefined {
    const row = target.routeTokenId === undefined
      ? this.db.prepare(`SELECT id FROM weixin_route_tokens WHERE generation_id = ? AND is_current = 1`).get(target.generationId)
      : this.db.prepare(`SELECT id FROM weixin_route_tokens WHERE generation_id = ? AND id = ?`)
        .get(target.generationId, target.routeTokenId);
    if (target.routeTokenId !== undefined && !row) throw new Error("WeChat outbound route token is unavailable");
    return (row as { id: string } | undefined)?.id;
  }

  private textBlueprint(
    deliveryId: string,
    target: WeixinFrozenDestination,
    routeTokenId: string | undefined,
    text: string,
    ordinal: number,
    kind: "text" | "caption",
  ): WeixinTextStep {
    const clientId = digest32([`weixin-${kind}-client`, deliveryId, ordinal]);
    const id = `weixin-step-${digest32([`weixin-${kind}-step`, deliveryId, ordinal])}`;
    const requestHash = hashPlan({
      version: 1, kind, generationId: target.generationId, botId: target.botId,
      ownerUserId: target.ownerUserId, routeTokenId: routeTokenId ?? null, clientId, text,
    });
    return {
      id, deliveryId, generationId: target.generationId, ordinal, kind, state: "prepared", requestHash,
      clientId, botId: target.botId, ownerUserId: target.ownerUserId, text,
      ...(routeTokenId === undefined ? {} : { routeTokenId }),
    };
  }

  private attachmentBlueprints(
    delivery: DeliveryRecord,
    target: WeixinFrozenDestination,
    routeTokenId: string | undefined,
    input: WeixinAttachmentPlanInput,
    aesKeyHex: string,
    fileKey: string,
  ): readonly PlannedStep[] {
    const ciphertextSize = paddedSize(input.plaintextSize);
    const plan: AttachmentPlanDocument = {
      version: 1,
      type: "attachment",
      kind: input.kind,
      botId: target.botId,
      ownerUserId: target.ownerUserId,
      displayName: input.displayName,
      mediaType: input.mediaType,
      aesKeyHex,
      fileKey,
      plaintextMd5: input.plaintextMd5,
      plaintextSize: input.plaintextSize,
      ciphertextSize,
    };
    const specifications: Array<{ kind: WeixinOutboundStepKind; request: Record<string, unknown>; text?: string }> = [
      { kind: "upload_parameters", request: { ...this.uploadRequest({
        deliveryId: delivery.id, generationId: target.generationId, botId: target.botId, ownerUserId: target.ownerUserId,
        ...(routeTokenId === undefined ? {} : { routeTokenId }), ...input, aesKeyHex, fileKey, ciphertextSize, steps: [],
      }) } },
      { kind: "upload", request: { fileKey } },
      ...splitCaption(delivery.body).map((text) => ({ kind: "caption" as const, request: { text }, text })),
      { kind: input.kind, request: { kind: input.kind, displayName: input.displayName, plaintextSize: input.plaintextSize } },
    ];
    const planJson = JSON.stringify(plan);
    return specifications.map((specification, ordinal) => {
      const clientId = digest32([`weixin-${specification.kind}-client`, delivery.id, ordinal]);
      const id = `weixin-step-${digest32([`weixin-${specification.kind}-step`, delivery.id, ordinal])}`;
      const common = {
        id,
        deliveryId: delivery.id,
        generationId: target.generationId,
        ordinal,
        state: "prepared" as const,
        requestHash: hashPlan({ plan, routeTokenId: routeTokenId ?? null, clientId, request: specification.request }),
        clientId,
        botId: target.botId,
        ownerUserId: target.ownerUserId,
        ...(routeTokenId === undefined ? {} : { routeTokenId }),
      };
      const step: WeixinOutboundStep = specification.kind === "caption"
        ? { ...common, kind: "caption", text: specification.text! }
        : { ...common, kind: specification.kind as WeixinBinaryStep["kind"] };
      return { step, requestJson: JSON.stringify(specification.request), planJson };
    });
  }

  private insertPlans(plans: readonly PlannedStep[]): void {
    const now = this.now();
    for (const { step, requestJson, planJson } of plans) {
      this.db.prepare(`INSERT INTO weixin_outbound_steps
        (id, delivery_id, generation_id, ordinal, kind, state, request_hash, request_json, route_token_id,
          client_id, plan_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?)`).run(
        step.id, step.deliveryId, step.generationId, step.ordinal, step.kind, step.requestHash, requestJson,
        step.routeTokenId ?? null, step.clientId, planJson, now, now,
      );
    }
  }

  private assertSamePlan(existing: readonly WeixinOutboundStep[], expected: readonly WeixinOutboundStep[]): void {
    if (existing.length !== expected.length) throw immutablePlanError();
    for (let index = 0; index < existing.length; index += 1) {
      const left = existing[index]!;
      const right = expected[index]!;
      if (left.id !== right.id || left.deliveryId !== right.deliveryId || left.generationId !== right.generationId
        || left.ordinal !== right.ordinal || left.kind !== right.kind || left.requestHash !== right.requestHash
        || left.clientId !== right.clientId || left.botId !== right.botId || left.ownerUserId !== right.ownerUserId
        || textOf(left) !== textOf(right) || left.routeTokenId !== right.routeTokenId) throw immutablePlanError();
    }
  }

  private rows(deliveryId: string): readonly StepRow[] {
    return this.db.prepare(`SELECT * FROM weixin_outbound_steps WHERE delivery_id = ? ORDER BY ordinal`)
      .all(deliveryId) as unknown as StepRow[];
  }

  private toStep(row: StepRow): WeixinOutboundStep {
    if (!isStepKind(row.kind) || !row.client_id || !HEX_32.test(row.client_id) || !row.plan_json) {
      throw new Error("WeChat outbound plan is invalid");
    }
    const document = parseObject(row.plan_json);
    const expectedType = row.kind === "text" ? "text" : "attachment";
    if (document.version !== 1 || document.type !== expectedType || typeof document.botId !== "string"
      || typeof document.ownerUserId !== "string") throw new Error("WeChat outbound plan is invalid");
    const receipt = row.receipt_json === null ? undefined : JSON.parse(row.receipt_json) as JsonValue;
    const common = {
      id: row.id,
      deliveryId: row.delivery_id,
      generationId: row.generation_id,
      ordinal: row.ordinal,
      state: row.state,
      requestHash: row.request_hash,
      clientId: row.client_id,
      botId: document.botId,
      ownerUserId: document.ownerUserId,
      ...(row.route_token_id === null ? {} : { routeTokenId: row.route_token_id }),
      ...(receipt === undefined ? {} : { receipt }),
    };
    if (row.kind === "text" || row.kind === "caption") {
      const request = parseObject(row.request_json);
      if (typeof request.text !== "string") throw new Error("WeChat outbound plan is invalid");
      return { ...common, kind: row.kind, text: request.text };
    }
    return { ...common, kind: row.kind };
  }
}

export function splitWeixinText(value: string, maxUtf8Bytes = DEFAULT_TEXT_BYTES): readonly string[] {
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes <= 0) throw new TypeError("WeChat text byte limit is invalid");
  if (value.length === 0) return [""];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const codePoint of value) {
    const bytes = Buffer.byteLength(codePoint);
    if (bytes > maxUtf8Bytes) throw new TypeError("WeChat text code point exceeds byte limit");
    if (currentBytes + bytes > maxUtf8Bytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += bytes;
  }
  chunks.push(current);
  return chunks;
}

export function parseWeixinDestination(binding: ConversationBinding): WeixinFrozenDestination {
  const value = binding.destination;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("WeChat destination is invalid");
  const generationId = value.generationId;
  const botId = value.botId;
  const ownerUserId = value.ownerUserId;
  const routeTokenId = value.routeTokenId;
  const keys = Object.keys(value);
  if (keys.some((key) => !["generationId", "botId", "ownerUserId", "routeTokenId"].includes(key))
    || typeof generationId !== "string" || typeof botId !== "string" || typeof ownerUserId !== "string"
    || (routeTokenId !== undefined && typeof routeTokenId !== "string")) {
    throw new TypeError("WeChat destination is invalid");
  }
  const target = { generationId, botId, ownerUserId, ...(routeTokenId === undefined ? {} : { routeTokenId }) };
  validateDestination(target);
  return target;
}

function validateDestination(value: WeixinFrozenDestination): void {
  for (const item of [value.generationId, value.botId, value.ownerUserId, value.routeTokenId]) {
    if (item !== undefined && (item.length === 0 || Buffer.byteLength(item) > 16 * 1024)) {
      throw new TypeError("WeChat destination is invalid");
    }
  }
}

function validateAttachmentInput(delivery: DeliveryRecord, input: WeixinAttachmentPlanInput): void {
  if (!delivery.attachmentId || !delivery.attachmentScopeId) throw new TypeError("WeChat attachment delivery is invalid");
  if (!HEX_32.test(input.plaintextMd5) || !Number.isSafeInteger(input.plaintextSize) || input.plaintextSize < 0
    || input.displayName.length === 0 || Buffer.byteLength(input.displayName) > 1024
    || input.mediaType.length === 0 || Buffer.byteLength(input.mediaType) > 1024) {
    throw new TypeError("WeChat attachment plan input is invalid");
  }
}

function parseAttachmentPlan(value: string | null): AttachmentPlanDocument {
  if (!value) throw new Error("WeChat attachment plan is invalid");
  const plan = parseObject(value);
  if (plan.version !== 1 || plan.type !== "attachment" || (plan.kind !== "image" && plan.kind !== "file")
    || typeof plan.botId !== "string" || typeof plan.ownerUserId !== "string" || typeof plan.displayName !== "string"
    || typeof plan.mediaType !== "string" || typeof plan.aesKeyHex !== "string" || !HEX_32.test(plan.aesKeyHex)
    || typeof plan.fileKey !== "string" || !HEX_32.test(plan.fileKey)
    || typeof plan.plaintextMd5 !== "string" || !HEX_32.test(plan.plaintextMd5)
    || !Number.isSafeInteger(plan.plaintextSize) || Number(plan.plaintextSize) < 0
    || !Number.isSafeInteger(plan.ciphertextSize) || Number(plan.ciphertextSize) !== paddedSize(Number(plan.plaintextSize))) {
    throw new Error("WeChat attachment plan is invalid");
  }
  return plan as unknown as AttachmentPlanDocument;
}

function paddedSize(size: number): number {
  const result = (Math.floor(size / 16) + 1) * 16;
  if (!Number.isSafeInteger(result)) throw new TypeError("WeChat attachment size is invalid");
  return result;
}

function splitCaption(value: string): readonly string[] {
  return value.length === 0 ? [] : splitWeixinText(value);
}

function isStepKind(value: string): value is WeixinOutboundStepKind {
  return ["text", "upload_parameters", "upload", "caption", "image", "file"].includes(value);
}

function textOf(step: WeixinOutboundStep): string | undefined {
  return step.kind === "text" || step.kind === "caption" ? step.text : undefined;
}

function digest32(value: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function hashPlan(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function immutablePlanError(): Error {
  return new Error("WeChat outbound plan is immutable and inconsistent");
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("WeChat outbound plan is invalid");
  return parsed as Record<string, unknown>;
}

function record(value: JsonValue): { [key: string]: JsonValue } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

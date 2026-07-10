import { createHash } from "node:crypto";
import type { JsonValue } from "../shared/binding.ts";
import type { ChatDeliveryAdapter, UncertainDeliveryContext, UncertainDeliveryResolution } from "../shared/contracts.ts";
import { AppError } from "../../core/errors.ts";
import type { DeliveryRecord, DeliveryStore } from "../../storage/delivery-store.ts";
import type { WeixinAccountStore, WeixinAuthorizationIncidentSink } from "./account-store.ts";
import {
  WeixinApiError,
  type WeixinApiClient,
  type WeixinSendMessageRequest,
  type WeixinUploadRequest,
  type WeixinUploadTarget,
} from "./api-client.ts";
import { classifyWeixinOutboundMedia, encryptWeixinMedia, safeWeixinFileName } from "./media.ts";
import {
  parseWeixinDestination,
  type WeixinAttachmentPlan,
  type WeixinOutboundStep,
  type WeixinOutboundStore,
} from "./outbound-store.ts";

interface WeixinDeliveryApi {
  sendMessage(request: WeixinSendMessageRequest, signal?: AbortSignal): Promise<{ messageId?: string }>;
  getUploadUrl?(request: WeixinUploadRequest, signal?: AbortSignal): Promise<WeixinUploadTarget>;
  upload?(
    target: WeixinUploadTarget,
    body: AsyncIterable<Uint8Array | string>,
    signal?: AbortSignal,
  ): Promise<{ encryptedQueryParameter: string }>;
}

interface WeixinDeliveryAdapterOptions {
  api: WeixinDeliveryApi | Pick<WeixinApiClient, "sendMessage" | "getUploadUrl" | "upload">;
  outbound: WeixinOutboundStore;
  deliveries: DeliveryStore;
  accounts: WeixinAccountStore;
  incidentSink: WeixinAuthorizationIncidentSink;
}

interface WeixinDocumentInput {
  stream: AsyncIterable<Uint8Array | string>;
  size: number;
  displayName: string;
  mediaType: string;
  deliveryId: string;
  caption?: string;
}

class WeixinTerminalDeliveryError extends Error {
  readonly deterministic = true;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WeixinTerminalDeliveryError";
  }
}

export class WeixinDeliveryAdapter implements ChatDeliveryAdapter {
  readonly id = "weixin";

  constructor(private readonly options: WeixinDeliveryAdapterOptions) {}

  async sendMessage(
    destination: JsonValue,
    body: string,
    _reply?: JsonValue,
    call?: { deliveryId: string },
  ): Promise<JsonValue> {
    if (!call) throw new WeixinTerminalDeliveryError("WeChat delivery identity is required");
    const delivery = this.requiredDelivery(call.deliveryId, body, false);
    let steps;
    try {
      const target = parseWeixinDestination({ ...delivery.binding, destination });
      steps = this.options.outbound.prepareText(delivery, target);
    } catch (error) {
      throw this.failBeforeDispatch(delivery, "WeChat delivery plan is invalid or inactive", error);
    }
    for (const step of steps) {
      if (step.state === "succeeded") continue;
      if (step.state !== "prepared") throw unresolvedError();
      const request = this.options.outbound.messageRequest(step);
      await this.executeStep(delivery, step, () => this.options.api.sendMessage(request));
    }
    return completionReceipt(steps.length);
  }

  async sendDocument(destination: JsonValue, file: WeixinDocumentInput): Promise<JsonValue> {
    const delivery = this.requiredDelivery(file.deliveryId, file.caption ?? "", true);
    let bytes: Buffer;
    let plan: WeixinAttachmentPlan;
    try {
      bytes = await collectExact(file.stream, file.size);
      const displayName = safeWeixinFileName(file.displayName);
      const target = parseWeixinDestination({ ...delivery.binding, destination });
      plan = this.options.outbound.prepareAttachment(delivery, target, {
        kind: classifyWeixinOutboundMedia(bytes, displayName, file.mediaType),
        displayName,
        mediaType: file.mediaType.trim().toLowerCase(),
        plaintextSize: bytes.length,
        plaintextMd5: createHash("md5").update(bytes).digest("hex"),
      });
    } catch (error) {
      throw this.failBeforeDispatch(delivery, "WeChat attachment plan is invalid or unsupported", error);
    }

    const stepCount = plan.steps.length;
    for (let ordinal = 0; ordinal < stepCount; ordinal += 1) {
      plan = this.options.outbound.attachmentPlan(delivery.id);
      const step = plan.steps[ordinal]!;
      if (step.state === "succeeded") continue;
      if (step.state !== "prepared") throw unresolvedError();
      switch (step.kind) {
        case "upload_parameters": {
          const request = this.options.outbound.uploadRequest(plan);
          const api = this.attachmentApi();
          await this.executeStep(delivery, step, async () => {
            const target = await api.getUploadUrl(request);
            return { url: target.url.toString() };
          });
          break;
        }
        case "upload": {
          let target: WeixinUploadTarget;
          let encrypted: Buffer;
          try {
            target = this.options.outbound.uploadTarget(plan);
            encrypted = await encryptBytes(bytes, plan.aesKeyHex);
            if (encrypted.length !== plan.ciphertextSize) throw new Error("WeChat encrypted attachment size is inconsistent");
          } catch (error) {
            throw this.failBeforeDispatch(delivery, "WeChat upload checkpoint is invalid", error);
          }
          const api = this.attachmentApi();
          await this.executeStep(delivery, step, () => api.upload(target, bytesIterable(encrypted)));
          break;
        }
        case "caption": {
          const request = this.options.outbound.messageRequest(step);
          await this.executeStep(delivery, step, () => this.options.api.sendMessage(request));
          break;
        }
        case "image":
        case "file": {
          let request: WeixinSendMessageRequest;
          try { request = this.options.outbound.mediaRequest(plan, step); }
          catch (error) { throw this.failBeforeDispatch(delivery, "WeChat media checkpoint is invalid", error); }
          await this.executeStep(delivery, step, () => this.options.api.sendMessage(request));
          break;
        }
        case "text":
          throw this.failBeforeDispatch(delivery, "WeChat attachment plan is inconsistent");
      }
    }
    return completionReceipt(stepCount);
  }

  async reconcileUncertain(delivery: UncertainDeliveryContext): Promise<UncertainDeliveryResolution> {
    return this.options.outbound.reconcile(delivery.id);
  }

  isSafeToRetry(): boolean { return false; }

  private requiredDelivery(id: string, body: string, attachment: boolean): DeliveryRecord {
    const delivery = this.options.deliveries.get(id);
    if (!delivery || delivery.body !== body || Boolean(delivery.attachmentId) !== attachment) {
      throw new WeixinTerminalDeliveryError("WeChat delivery record is inconsistent");
    }
    return delivery;
  }

  private attachmentApi(): Required<Pick<WeixinDeliveryApi, "getUploadUrl" | "upload">> {
    const getUploadUrl = this.options.api.getUploadUrl;
    const upload = this.options.api.upload;
    if (!getUploadUrl || !upload) throw new WeixinTerminalDeliveryError("WeChat attachment API is unavailable");
    return { getUploadUrl: getUploadUrl.bind(this.options.api), upload: upload.bind(this.options.api) };
  }

  private async executeStep(
    delivery: DeliveryRecord,
    step: WeixinOutboundStep,
    action: () => Promise<JsonValue>,
  ): Promise<void> {
    try { this.options.accounts.requireActive(step.generationId); }
    catch (error) { throw this.failBeforeDispatch(delivery, "WeChat authorization is inactive", error); }
    this.options.outbound.begin(step.id);
    try {
      const receipt = await action();
      this.options.outbound.succeed(step.id, receipt);
    } catch (error) {
      if (isCredentialPinFailure(error)) {
        await this.transitionOrPreserveUncertainty(step.id, {
          generationId: step.generationId, state: "credential_changed", category: "credential_changed",
        });
        this.options.outbound.failTerminal(step.id, this.options.deliveries);
        throw new WeixinTerminalDeliveryError("WeChat credentials changed before dispatch", { cause: error });
      }
      if (error instanceof WeixinApiError && error.options.protocolCode === -14) {
        await this.transitionOrPreserveUncertainty(step.id, {
          generationId: step.generationId, state: "relogin_required", category: "authorization",
        });
        this.options.outbound.failTerminal(step.id, this.options.deliveries);
        throw new WeixinTerminalDeliveryError("WeChat authorization is no longer valid", { cause: error });
      }
      if (isProvenTerminalRejection(error)) {
        this.options.outbound.failTerminal(step.id, this.options.deliveries);
        throw new WeixinTerminalDeliveryError("WeChat rejected the delivery", { cause: error });
      }
      this.options.outbound.markUncertain(step.id);
      throw error;
    }
  }

  private failBeforeDispatch(delivery: DeliveryRecord, message: string, cause?: unknown): WeixinTerminalDeliveryError {
    this.options.deliveries.fail(delivery.id);
    return new WeixinTerminalDeliveryError(message, cause === undefined ? undefined : { cause });
  }

  private async transitionOrPreserveUncertainty(
    stepId: string,
    event: Parameters<WeixinAuthorizationIncidentSink["transition"]>[0],
  ): Promise<void> {
    try { await this.options.incidentSink.transition(event); }
    catch (error) {
      this.options.outbound.markUncertain(stepId);
      throw error;
    }
  }
}

function completionReceipt(stepCount: number): JsonValue {
  return { kind: "weixin", stepCount };
}

function unresolvedError(): WeixinApiError {
  return new WeixinApiError("unknown", "WeChat delivery result is unresolved", { uncertain: true });
}

function isCredentialPinFailure(error: unknown): boolean {
  return error instanceof AppError && error.code === "CONFIGURATION_ERROR"
    && error.message.startsWith("WeChat credential");
}

function isProvenTerminalRejection(error: unknown): boolean {
  return error instanceof WeixinApiError && error.options.protocolCode !== undefined && error.uncertain === false;
}

async function collectExact(source: AsyncIterable<Uint8Array | string>, expectedSize: number): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new TypeError("WeChat attachment size is invalid");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of source) {
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > expectedSize) throw new TypeError("WeChat attachment grew during delivery");
    chunks.push(chunk);
  }
  if (total !== expectedSize) throw new TypeError("WeChat attachment size changed during delivery");
  return Buffer.concat(chunks, total);
}

async function encryptBytes(value: Buffer, aesKeyHex: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of encryptWeixinMedia(bytesIterable(value), Buffer.from(aesKeyHex, "hex"), value.length)) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function* bytesIterable(value: Buffer): AsyncIterable<Uint8Array> {
  yield value;
}

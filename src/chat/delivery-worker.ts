import type { AttachmentStore, FileHandleId } from "../attachments/store.ts";
import { AppError } from "../core/errors.ts";
import type { DeliveryRecord, DeliveryStore } from "../storage/delivery-store.ts";
import type { JsonValue } from "./binding.ts";
import type { ChatDeliveryAdapter } from "./contracts.ts";
import type { ChatAdapterRegistry } from "./adapter-registry.ts";

export class DeliveryWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining: Promise<void> | undefined;

  constructor(
    private readonly store: DeliveryStore,
    private readonly adapters: ChatAdapterRegistry,
    private readonly attachments?: AttachmentStore,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly onStateChange: (delivery: DeliveryRecord, error?: unknown) => Promise<void> | void = () => undefined,
    private readonly onOperationalFailure: (delivery: DeliveryRecord) => Promise<void> | void = () => undefined,
  ) {}

  async processOne(id: string): Promise<void> {
    const delivery = this.store.get(id);
    if (!delivery || (delivery.state !== "prepared" && delivery.state !== "uncertain")) return;
    const adapter = this.adapters.delivery(delivery.binding.adapterId);
    if (delivery.state === "uncertain" && adapter.reconcileUncertain) {
      const resolution = await adapter.reconcileUncertain({
        id: delivery.id,
        binding: delivery.binding,
        mandatory: delivery.mandatory,
        hasAttachment: delivery.attachmentId !== undefined,
      });
      if (resolution.outcome === "confirmed") {
        this.store.confirm(id, resolution.receipt);
        await this.notify(this.store.get(id)!);
        return;
      }
      if (resolution.outcome === "resume_safe") {
        if (!this.store.resumeUncertain(id)) throw new AppError("DELIVERY_UNCERTAIN", `delivery ${id} reconciliation changed concurrently`);
        await this.notify(this.store.get(id)!);
        return;
      }
      throw new AppError("DELIVERY_UNCERTAIN", `delivery ${id} may already have been sent`);
    }
    if (delivery.state === "uncertain" && !delivery.mandatory) {
      this.store.abandonUncertain(id);
      this.prepareUncertainWarning(delivery);
      throw new AppError("DELIVERY_UNCERTAIN", `optional delivery ${id} may already have been sent`);
    }
    const body = delivery.state === "uncertain" ? this.recoveryEnvelope(delivery.body, delivery.id) : delivery.body;
    if (!this.store.markDispatched(id)) return;
    try {
      const receipt = delivery.attachmentId
        ? await this.sendAttachment(adapter, delivery, body)
        : await adapter.sendMessage(delivery.binding.destination, body, delivery.binding.reply, { deliveryId: delivery.id });
      this.store.confirm(id, receipt);
      await this.notify(this.store.get(id)!);
    } catch (error) {
      const safeToRetry = adapter.isSafeToRetry?.(error) ?? isRateLimitError(error);
      if (safeToRetry) this.store.markPrepared(id);
      else if (isDeterministicDeliveryError(error)) this.store.fail(id);
      else this.store.markUncertain(id);
      if (!delivery.mandatory && !safeToRetry && !adapter.reconcileUncertain) {
        this.store.abandonUncertain(id);
        this.prepareUncertainWarning(delivery);
      }
      await this.notifyOperationalFailure(this.store.get(id)!);
      if (!safeToRetry) await this.notify(this.store.get(id)!, error);
      throw error;
    }
  }

  async drain(): Promise<void> {
    for (const delivery of this.store.listReady()) {
      try { await this.processOne(delivery.id); }
      catch (error) {
        if (!(error instanceof AppError && error.code === "DELIVERY_UNCERTAIN")) throw error;
        const warning = this.store.get(`delivery-warning:${delivery.id}`);
        if (warning?.state === "prepared") await this.processOne(warning.id);
      }
    }
  }

  start(intervalMs = 250): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.draining) return;
      this.draining = this.drain().catch(() => undefined).finally(() => { this.draining = undefined; });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  private recoveryEnvelope(body: string, id: string): string {
    const match = /^\[([^\]]+)\]\s?(.*)$/su.exec(body);
    return match ? `[${match[1]} · recovery retry ${id}] ${match[2]}` : `[recovery retry ${id}] ${body}`;
  }

  private prepareUncertainWarning(delivery: DeliveryRecord): void {
    this.store.prepare({
      id: `delivery-warning:${delivery.id}`,
      kind: "delivery_warning",
      binding: delivery.binding,
      body: `[system] delivery ${delivery.id} could not be confirmed and was not automatically retried`,
      mandatory: true,
    });
  }

  private async notify(delivery: DeliveryRecord, error?: unknown): Promise<void> {
    try { await this.onStateChange(delivery, error); }
    catch { /* delivery state is authoritative */ }
  }

  private async notifyOperationalFailure(delivery: DeliveryRecord): Promise<void> {
    try { await this.onOperationalFailure(delivery); }
    catch { /* delivery state remains authoritative */ }
  }

  private async sendAttachment(adapter: ChatDeliveryAdapter, delivery: DeliveryRecord, body: string): Promise<JsonValue> {
    if (!delivery.attachmentId || !delivery.attachmentScopeId || !this.attachments || !adapter.sendDocument) throw new AppError("ATTACHMENT_INVALID", "attachment delivery is not configured");
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const upload = await this.attachments.openForUpload(delivery.attachmentScopeId, delivery.attachmentId as FileHandleId);
      try {
        return await adapter.sendDocument(delivery.binding.destination, {
          stream: upload.stream,
          size: upload.size,
          displayName: upload.displayName,
          mediaType: upload.mediaType,
          deliveryId: delivery.id,
          ...(body ? { caption: body } : {}),
          ...(delivery.binding.reply === undefined ? {} : { reply: delivery.binding.reply }),
        });
      } catch (error) {
        lastError = error;
        const safeToRetry = adapter.isSafeToRetry?.(error) ?? isRateLimitError(error);
        if (!safeToRetry || attempt === 3) throw error;
        await this.sleep(retryAfterMs(error));
      } finally {
        await upload.close();
      }
    }
    throw lastError;
  }
}

function isDeterministicDeliveryError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "deterministic" in error && (error as { deterministic: unknown }).deterministic === true;
}

function isRateLimitError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error as { status: unknown }).status === 429;
}

function retryAfterMs(error: unknown): number {
  const direct = (error as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return Math.max(1, direct);
  const response = (error as { response?: { parameters?: { retry_after?: number } } }).response;
  return Math.max(1, response?.parameters?.retry_after ?? 1) * 1_000;
}

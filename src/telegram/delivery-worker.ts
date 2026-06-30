import { AppError } from "../core/errors.ts";
import type { AttachmentStore, FileHandleId } from "../attachments/store.ts";
import type { DeliveryRecord, DeliveryStore } from "../storage/delivery-store.ts";
import type { ChatDeliveryAdapter } from "../chat/contracts.ts";

export class DeliveryWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining: Promise<void> | undefined;

  constructor(
    private readonly store: DeliveryStore,
    private readonly api: ChatDeliveryAdapter,
    private readonly attachments?: AttachmentStore,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    private readonly onStateChange: (delivery: DeliveryRecord, error?: unknown) => Promise<void> | void = () => undefined,
  ) {}

  async processOne(id: string): Promise<void> {
    const delivery = this.store.get(id);
    if (!delivery || delivery.state === "confirmed") return;
    if (delivery.state === "uncertain" && !delivery.mandatory) {
      throw new AppError("DELIVERY_UNCERTAIN", `optional delivery ${id} may already have been sent`);
    }
    const body = delivery.state === "uncertain" ? this.recoveryEnvelope(delivery.body, delivery.id) : delivery.body;
    try {
      this.store.markDispatched(id);
      const result = delivery.attachmentId
        ? await this.sendAttachment(delivery, body)
        : await this.api.sendMessage(delivery.destination, body, delivery.replyTo);
      this.store.confirm(id, String(result.message_id));
      await this.notify(this.store.get(id)!);
    } catch (error) {
      if (isRateLimitError(error)) this.store.markPrepared(id);
      else if (isDeterministicDeliveryError(error)) this.store.fail(id);
      else this.store.markUncertain(id);
      if (!delivery.mandatory && !isRateLimitError(error)) {
        this.store.prepare({
          id: `delivery-warning:${id}`,
          kind: "delivery_warning",
          destination: delivery.destination,
          body: `[system] delivery ${id} could not be confirmed and was not automatically retried`,
          mandatory: true,
        });
      }
      if (!isRateLimitError(error)) await this.notify(this.store.get(id)!, error);
      throw error;
    }
  }

  async drain(): Promise<void> {
    for (const delivery of this.store.listReady()) {
      try { await this.processOne(delivery.id); }
      catch (error) { if (!(error instanceof AppError && error.code === "DELIVERY_UNCERTAIN")) throw error; }
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

  private async notify(delivery: DeliveryRecord, error?: unknown): Promise<void> {
    try { await this.onStateChange(delivery, error); }
    catch { /* delivery state is authoritative; maintenance can rebuild metadata */ }
  }

  private async sendAttachment(delivery: NonNullable<ReturnType<DeliveryStore["get"]>>, body: string): Promise<{ message_id: number }> {
    if (!delivery.attachmentId || !delivery.attachmentScopeId || !this.attachments || !this.api.sendDocument) throw new AppError("ATTACHMENT_INVALID", "attachment delivery is not configured");
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const upload = await this.attachments.openForUpload(delivery.attachmentScopeId, delivery.attachmentId as FileHandleId);
      try {
        return await this.api.sendDocument(delivery.destination, { stream: upload.stream, size: upload.size, displayName: upload.displayName, mediaType: upload.mediaType, ...(body ? { caption: body } : {}), ...(delivery.replyTo === undefined ? {} : { replyTo: delivery.replyTo }) });
      } catch (error) {
        lastError = error;
        if (!isRateLimitError(error) || attempt === 3) throw error;
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
  const response = (error as { response?: { parameters?: { retry_after?: number } } }).response;
  return Math.max(1, response?.parameters?.retry_after ?? 1) * 1_000;
}

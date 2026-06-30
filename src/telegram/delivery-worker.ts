import { AppError } from "../core/errors.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";
import { TelegramApiError } from "./api.ts";

interface DeliveryApi { sendMessage(chatId: string | number, body: string): Promise<{ message_id: number }> }

export class DeliveryWorker {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly store: DeliveryStore, private readonly api: DeliveryApi) {}

  async processOne(id: string): Promise<void> {
    const delivery = this.store.get(id);
    if (!delivery || delivery.state === "confirmed") return;
    if (delivery.state === "uncertain" && !delivery.mandatory) {
      throw new AppError("DELIVERY_UNCERTAIN", `optional delivery ${id} may already have been sent`);
    }
    const body = delivery.state === "uncertain" ? this.recoveryEnvelope(delivery.body, delivery.id) : delivery.body;
    this.store.markDispatched(id);
    try {
      const result = await this.api.sendMessage(delivery.destination, body);
      this.store.confirm(id, String(result.message_id));
    } catch (error) {
      if (error instanceof TelegramApiError && error.deterministic) this.store.fail(id);
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
    this.timer = setInterval(() => void this.drain().catch(() => undefined), intervalMs);
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private recoveryEnvelope(body: string, id: string): string {
    const match = /^\[([^\]]+)\]\s?(.*)$/su.exec(body);
    return match ? `[${match[1]} · recovery retry ${id}] ${match[2]}` : `[recovery retry ${id}] ${body}`;
  }
}

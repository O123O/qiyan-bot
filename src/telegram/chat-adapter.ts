import type { AttachmentStore } from "../attachments/store.ts";
import type { ChatAdapter, ChatDeliveryAdapter } from "../chat/contracts.ts";
import type { Database } from "../storage/database.ts";
import type { OperationStore } from "../storage/operation-store.ts";
import { TelegramPoller } from "./poller.ts";
import { createTelegramTransports, type TelegramTransports } from "./transport.ts";

interface TelegramChatAdapterDependencies {
  createTransports?: (token: string) => TelegramTransports;
}

export class TelegramChatAdapter implements ChatAdapter {
  readonly delivery: ChatDeliveryAdapter;
  private readonly poller: TelegramPoller;
  private readonly transports: TelegramTransports;
  private stopping: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private stopped = false;

  constructor(
    db: Database,
    operations: OperationStore,
    attachments: AttachmentStore,
    options: { token: string; ownerId: number; maxMessageBytes: number; onAccepted(contextId: string): Promise<void> },
    dependencies: TelegramChatAdapterDependencies = {},
  ) {
    this.transports = (dependencies.createTransports ?? createTelegramTransports)(options.token);
    this.delivery = this.transports.delivery;
    this.poller = new TelegramPoller(db, this.transports.polling, operations, attachments, {
      ownerId: options.ownerId,
      maxMessageBytes: options.maxMessageBytes,
      onAccepted: options.onAccepted,
    });
  }

  start(): void {
    if (this.stopped) throw new Error("Telegram adapter has stopped and cannot restart");
    this.poller.start();
  }

  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopped = true;
      this.stopping = (async () => {
        await this.poller.stop();
        await this.transports.closePolling();
      })();
    }
    return this.stopping;
  }

  close(): Promise<void> { return this.closing ??= this.transports.closeDelivery(); }
}

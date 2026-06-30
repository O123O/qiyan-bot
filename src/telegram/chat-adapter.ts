import type { AttachmentStore } from "../attachments/store.ts";
import type { ChatAdapter, ChatDeliveryAdapter } from "../chat/contracts.ts";
import type { Database } from "../storage/database.ts";
import type { OperationStore } from "../storage/operation-store.ts";
import { TelegramApi } from "./api.ts";
import { TelegramPoller } from "./poller.ts";

export class TelegramChatAdapter implements ChatAdapter {
  readonly delivery: ChatDeliveryAdapter;
  private readonly poller: TelegramPoller;

  constructor(
    db: Database,
    operations: OperationStore,
    attachments: AttachmentStore,
    options: { token: string; ownerId: number; maxMessageBytes: number; onAccepted(contextId: string): Promise<void> },
  ) {
    const api = new TelegramApi(options.token);
    this.delivery = api;
    this.poller = new TelegramPoller(db, api, operations, attachments, {
      ownerId: options.ownerId,
      maxMessageBytes: options.maxMessageBytes,
      onAccepted: options.onAccepted,
    });
  }

  start(): void { this.poller.start(); }
  stop(): Promise<void> { return this.poller.stop(); }
}

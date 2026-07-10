import type { AttachmentStore } from "../../attachments/store.ts";
import type { ChatAdapter, ChatDeliveryAdapter } from "../shared/contracts.ts";
import type { Database } from "../../storage/database.ts";
import type { CanonicalChatSource } from "../../core/types.ts";
import { TelegramPoller } from "./poller.ts";
import { createTelegramTransports, type TelegramTransports } from "./transport.ts";
import { TelegramDeliveryAdapter } from "./delivery-adapter.ts";
import type { OperationalEventSink } from "../../core/operational-log.ts";

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
    attachments: AttachmentStore,
    options: {
      token: string;
      ownerId: number;
      maxMessageBytes: number;
      onMessage(source: CanonicalChatSource, commitNativeCheckpoint: () => void): Promise<void>;
      onOperationalEvent?: OperationalEventSink;
    },
    dependencies: TelegramChatAdapterDependencies = {},
  ) {
    this.transports = (dependencies.createTransports ?? createTelegramTransports)(options.token);
    this.delivery = new TelegramDeliveryAdapter(this.transports.delivery);
    this.poller = new TelegramPoller(db, this.transports.polling, attachments, {
      ownerId: options.ownerId,
      maxMessageBytes: options.maxMessageBytes,
      onMessage: options.onMessage,
      ...(options.onOperationalEvent === undefined ? {} : { onOperationalEvent: options.onOperationalEvent }),
    });
  }

  async initialize(): Promise<void> { /* Telegram has no separate validation handshake. */ }

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

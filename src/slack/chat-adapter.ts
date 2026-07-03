import { SocketModeClient } from "@slack/socket-mode";
import type { AttachmentStore } from "../attachments/store.ts";
import type { ConversationBinding } from "../chat/binding.ts";
import type { ChatAdapter, ChatHistoryProvider } from "../chat/contracts.ts";
import type { SlackConfig } from "../config.ts";
import type { CanonicalChatSource } from "../core/types.ts";
import type { ConversationStore, ChatAcceptanceEffects } from "../storage/conversation-store.ts";
import type { Database } from "../storage/database.ts";
import type { DeliveryStore } from "../storage/delivery-store.ts";
import { createSlackClients, SlackApiError, validateSlackStartup, type SlackClients, type SlackStartupIdentity } from "./clients.ts";
import { SlackContextService } from "./context-service.ts";
import { SlackDeliveryAdapter } from "./delivery-adapter.ts";
import { SlackEnvelopeHandler } from "./envelope-handler.ts";
import { SlackInboxStore } from "./inbox-store.ts";
import { SlackIngressWorker } from "./ingress-worker.ts";

export interface SlackSocketModeClient {
  on(event: string, listener: (event: unknown) => void): unknown;
  off(event: string, listener: (event: unknown) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

interface SlackChatAdapterDependencies {
  clients?: SlackClients;
  createSocketModeClient?: (options: { appToken: string }) => SlackSocketModeClient;
  now?: () => number;
}

export class SlackChatAdapter implements ChatAdapter {
  readonly delivery: SlackDeliveryAdapter;
  readonly history: ChatHistoryProvider;
  primaryBinding: ConversationBinding | undefined;

  private readonly clients: SlackClients;
  private readonly socket: SlackSocketModeClient;
  private readonly inbox: SlackInboxStore;
  private readonly worker: SlackIngressWorker;
  private readonly now: () => number;
  private contextService: SlackContextService | undefined;
  private handler: SlackEnvelopeHandler | undefined;
  private identity: SlackStartupIdentity | undefined;
  private initializing: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private socketStarted = false;
  private subscribed = false;

  private readonly socketListener = (value: unknown): void => {
    const event = record(value);
    const ack = event?.ack;
    if (!this.handler || typeof ack !== "function") return;
    const body = reduceEnvelopeBody(event?.body);
    void this.handler.handle({ body, ack: () => Promise.resolve(ack()) })
      .then(() => this.worker.drain())
      .catch(() => undefined);
  };

  constructor(
    db: Database,
    attachments: AttachmentStore,
    conversations: ConversationStore,
    deliveries: DeliveryStore,
    private readonly options: {
      config: SlackConfig;
      maxMessageBytes: number;
      onMessage(source: CanonicalChatSource, effects: ChatAcceptanceEffects): Promise<void>;
    },
    dependencies: SlackChatAdapterDependencies = {},
  ) {
    this.clients = dependencies.clients ?? createSlackClients(options.config);
    this.socket = (dependencies.createSocketModeClient ?? ((value) => new SocketModeClient({ appToken: value.appToken })))(
      { appToken: options.config.appToken },
    );
    this.now = dependencies.now ?? Date.now;
    this.delivery = new SlackDeliveryAdapter(options.config.teamId, this.clients.bot);
    this.history = { getHistory: (binding, request) => this.context.getHistory(binding, request) };
    this.inbox = new SlackInboxStore(db);
    this.worker = new SlackIngressWorker(this.inbox, attachments, conversations, deliveries, {
      downloadFile: (url) => this.clients.bot.downloadFile(url),
      isTransient: transientSlackFailure,
      onMessage: options.onMessage,
      maxMessageBytes: options.maxMessageBytes,
    });
  }

  get context(): SlackContextService {
    if (!this.contextService) throw new Error("Slack adapter must initialize before context is used");
    return this.contextService;
  }

  initialize(): Promise<void> {
    return this.initializing ??= (async () => {
      const identity = await validateSlackStartup(this.options.config, this.clients);
      this.identity = identity;
      this.primaryBinding = {
        adapterId: "slack",
        conversationKey: `slack:${identity.teamId}:dm:${identity.ownerDmChannelId}`,
        destination: { workspaceId: identity.teamId, channelId: identity.ownerDmChannelId },
      };
      this.contextService = new SlackContextService(this.clients.bot, identity.teamId, {
        search: this.clients.search,
        ownerUserId: identity.ownerUserId,
        coverage: identity.coverage,
        now: this.now,
      });
      this.handler = new SlackEnvelopeHandler(this.inbox, {
        teamId: identity.teamId,
        ownerUserId: identity.ownerUserId,
        botUserId: identity.botUserId,
        now: this.now,
      });
    })();
  }

  start(): Promise<void> {
    if (!this.identity || !this.handler) return Promise.reject(new Error("Slack adapter must initialize before start"));
    if (this.stopping) return Promise.reject(new Error("Slack adapter has stopped and cannot restart"));
    return this.starting ??= (async () => {
      await this.worker.recoverAndDrain();
      this.socket.on("slack_event", this.socketListener);
      this.subscribed = true;
      this.worker.start();
      try {
        this.socketStarted = true;
        await this.socket.start();
      } catch (error) {
        this.unsubscribe();
        await this.worker.stop();
        if (this.socketStarted) await this.socket.disconnect().catch(() => undefined);
        this.socketStarted = false;
        this.starting = undefined;
        throw error;
      }
    })();
  }

  stop(): Promise<void> {
    return this.stopping ??= (async () => {
      this.unsubscribe();
      await this.worker.stop();
      if (this.socketStarted) await this.socket.disconnect();
      this.socketStarted = false;
    })();
  }

  close(): Promise<void> { return this.stop(); }

  private unsubscribe(): void {
    if (!this.subscribed) return;
    this.socket.off("slack_event", this.socketListener);
    this.subscribed = false;
  }
}

function transientSlackFailure(error: unknown): boolean {
  if (!(error instanceof SlackApiError)) return true;
  return !error.deterministic || error.status === 429 || (error.status !== undefined && error.status >= 500);
}

function reduceEnvelopeBody(value: unknown): unknown {
  const body = record(value);
  const event = record(body?.event);
  if (!body || !event) return {};
  return {
    type: body.type,
    team_id: body.team_id,
    event_id: body.event_id,
    event_time: body.event_time,
    event: {
      type: event.type,
      channel: event.channel,
      channel_type: event.channel_type,
      user: event.user,
      ts: event.ts,
      thread_ts: event.thread_ts,
      text: event.text,
      bot_id: event.bot_id,
      app_id: event.app_id,
      subtype: event.subtype,
      hidden: event.hidden,
      ...(Array.isArray(event.files) ? { files: event.files.map(reduceFile) } : {}),
    },
  };
}

function reduceFile(value: unknown): unknown {
  const file = record(value);
  if (!file) return {};
  return {
    id: file.id,
    name: file.name,
    title: file.title,
    mimetype: file.mimetype,
    size: file.size,
    url_private: file.url_private,
    url_private_download: file.url_private_download,
  };
}

function record(value: unknown): Record<string, any> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

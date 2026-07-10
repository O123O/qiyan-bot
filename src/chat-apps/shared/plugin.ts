import type { AttachmentStore } from "../../attachments/store.ts";
import type { OperationalEventSink } from "../../core/operational-log.ts";
import type { CanonicalChatSource } from "../../core/types.ts";
import type { ConversationStore, ChatAcceptanceEffects } from "../../storage/conversation-store.ts";
import type { Database } from "../../storage/database.ts";
import type { DeliveryStore } from "../../storage/delivery-store.ts";
import type { ChatAdapter } from "./contracts.ts";

/**
 * App-agnostic dependencies handed to every chat app's factory. Deliberately narrow: it carries only
 * the shared infrastructure an app needs. App-specific runtime inputs (provider credentials, bespoke
 * routing) are NOT placed here — they stay inside the app, so the shared layer never depends on any app.
 */
export interface ChatAppDeps {
  db: Database;
  attachments: AttachmentStore;
  conversations: ConversationStore;
  deliveries: DeliveryStore;
  /** The one canonical inbound hand-off: parse a provider event into a source, then call this. */
  onMessage(source: CanonicalChatSource, effects: ChatAcceptanceEffects): Promise<void>;
  onOperationalEvent?: OperationalEventSink;
  maxMessageBytes: number;
}

/**
 * The result of constructing an app. `adapter` is the required surface (delivery + lifecycle + optional
 * history). `onAllReady` runs once, after every enabled app has initialized, for post-composition work an
 * app needs (e.g. reconciling deferred state). Apps that need to surface additional app-specific handles to
 * the host (rare) extend this via declaration merging in their own module rather than widening the core.
 */
export interface ChatAppInstance {
  adapter: ChatAdapter;
  onAllReady?(): Promise<void> | void;
}

/**
 * A chat app plugin. Implement this + register in `CHAT_APPS` to add a provider (Teams, Discord, …).
 * `create` is a plain factory: wire any app-specific stores/clients inside it; the host only sees the
 * returned `ChatAppInstance`. `Config` is the app's own parsed config section; it self-validates.
 */
export interface ChatApp<Config = unknown> {
  readonly id: string;
  readonly displayName: string;
  create(deps: ChatAppDeps, config: Config): ChatAppInstance;
}

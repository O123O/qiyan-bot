import type { TelegramConfig } from "../../config.ts";
import type { ChatApp, ChatAppDeps, ChatAppInstance } from "../shared/plugin.ts";
import { TelegramChatAdapter } from "./chat-adapter.ts";

export const telegramApp: ChatApp<TelegramConfig> = {
  id: "telegram",
  displayName: "Telegram",
  create(deps: ChatAppDeps, config: TelegramConfig): ChatAppInstance {
    const adapter = new TelegramChatAdapter(deps.db, deps.attachments, {
      token: config.token,
      ownerId: config.ownerId,
      maxMessageBytes: deps.maxMessageBytes,
      onMessage: (source, commitNativeCheckpoint) => deps.onMessage(source, { commitNativeCheckpoint }),
      ...(deps.onOperationalEvent ? { onOperationalEvent: deps.onOperationalEvent } : {}),
    });
    return { adapter };
  },
};

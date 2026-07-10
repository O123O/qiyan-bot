import type { ChatApp } from "./shared/plugin.ts";
import { telegramApp } from "./telegram/app.ts";

/**
 * Registered chat apps. To add a provider (Teams, Discord, …): implement `ChatApp` in its
 * `src/chat-apps/<id>/app.ts` and add it to this array. The composition constructs, registers, and
 * routes every entry whose `config.chat[<id>]` section is present — no other core edit is required.
 *
 * `ChatApp<any>` because the array is heterogeneous over each app's own config type; each app narrows
 * its config inside `create` (config parsing + cross-app invariants live in src/config.ts).
 *
 * Slack and WeChat are not yet entries here: their deep, app-specific composition (Slack's context
 * service feeding the MCP search tool; WeChat's credential handle, incident router, and owner-warning
 * routing) is migrated separately so the shared layer never has to carry app-specific handles.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const CHAT_APPS: readonly ChatApp<any>[] = [telegramApp];

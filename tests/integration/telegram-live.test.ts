import assert from "node:assert/strict";
import test from "node:test";
import { TelegramApi } from "../../src/telegram/api.ts";

const enabled = process.env.RUN_TELEGRAM_LIVE === "1"
  && Boolean(process.env.TELEGRAM_BOT_TOKEN)
  && Boolean(process.env.TELEGRAM_DESTINATION_CHAT_ID);

test("opt-in Telegram destination round trip", { skip: !enabled, timeout: 30_000 }, async () => {
  const api = new TelegramApi(process.env.TELEGRAM_BOT_TOKEN!);
  const response = await api.sendMessage(process.env.TELEGRAM_DESTINATION_CHAT_ID!, "[codex-bot] live integration check");
  assert.ok(response.message_id > 0);
});


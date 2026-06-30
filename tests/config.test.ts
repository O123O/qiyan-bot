import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("loadConfig requires the Telegram token", () => {
  assert.throws(() => loadConfig({}), /TELEGRAM_BOT_TOKEN/);
});

test("loadConfig applies bounded defaults", () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: "secret",
    TELEGRAM_OWNER_ID: "42",
    TELEGRAM_DESTINATION_CHAT_ID: "42",
  });
  assert.equal(config.maxConcurrentTurns, 4);
  assert.equal(config.maxCollectCount, 20);
  assert.equal(config.mcpHost, "127.0.0.1");
});

test("loadConfig rejects unsafe MCP binding", () => {
  assert.throws(() => loadConfig({
    TELEGRAM_BOT_TOKEN: "secret",
    TELEGRAM_OWNER_ID: "42",
    TELEGRAM_DESTINATION_CHAT_ID: "42",
    MCP_HOST: "0.0.0.0",
  }), /MCP_HOST/);
});

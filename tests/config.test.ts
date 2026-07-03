import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadConfig, loadAssistantLoginConfig } from "../src/config.ts";

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    TELEGRAM_BOT_TOKEN: "secret",
    TELEGRAM_OWNER_ID: "42",
    TELEGRAM_DESTINATION_CHAT_ID: "42",
    HOME: "/home/test-user",
    ...overrides,
  };
}

const qiyanHome = "/home/test-user/private-qiyan";

test("loadConfig requires at least one complete chat adapter", () => {
  assert.throws(() => loadConfig({ HOME: "/home/test-user" }, { qiyanHome }), /chat adapter/i);
  assert.throws(() => loadConfig({ HOME: "/home/test-user", TELEGRAM_BOT_TOKEN: "partial" }, { qiyanHome }), /Telegram.*group/i);
  assert.throws(() => loadConfig({ HOME: "/home/test-user", SLACK_APP_TOKEN: "xapp-partial" }, { qiyanHome }), /Slack.*group/i);
});

test("loadConfig accepts Telegram-only and Slack-only adapter groups", () => {
  assert.deepEqual(loadConfig(baseEnv(), { qiyanHome }).chat, {
    primary: "telegram",
    telegram: { token: "secret", ownerId: 42, destinationChatId: 42 },
  });
  assert.deepEqual(loadConfig({
    HOME: "/home/test-user",
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_USER_TOKEN: "xoxp-test",
    SLACK_TEAM_ID: "T123",
    SLACK_OWNER_USER_ID: "U123",
  }, { qiyanHome }).chat, {
    primary: "slack",
    slack: {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      userToken: "xoxp-test",
      teamId: "T123",
      ownerUserId: "U123",
    },
  });
});

test("loadConfig requires an exact configured primary when both adapters exist", () => {
  const both = baseEnv({
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_USER_TOKEN: "xoxp-test",
    SLACK_TEAM_ID: "T123",
    SLACK_OWNER_USER_ID: "U123",
  });
  assert.throws(() => loadConfig(both, { qiyanHome }), /PRIMARY_CHAT_APP/);
  assert.equal(loadConfig({ ...both, PRIMARY_CHAT_APP: "slack" }, { qiyanHome }).chat.primary, "slack");
  assert.equal(loadConfig({ ...both, PRIMARY_CHAT_APP: "telegram" }, { qiyanHome }).chat.primary, "telegram");
  assert.throws(() => loadConfig({
    HOME: "/home/test-user",
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_USER_TOKEN: "xoxp-test",
    SLACK_TEAM_ID: "T123",
    SLACK_OWNER_USER_ID: "U123",
    PRIMARY_CHAT_APP: "telegram",
  }, { qiyanHome }), /PRIMARY_CHAT_APP/);
});

test("loadConfig rejects malformed Slack credential identities", () => {
  const slack = {
    HOME: "/home/test-user",
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_USER_TOKEN: "xoxp-test",
    SLACK_TEAM_ID: "T123",
    SLACK_OWNER_USER_ID: "U123",
  };
  for (const [key, value] of [
    ["SLACK_APP_TOKEN", "xoxb-wrong"],
    ["SLACK_BOT_TOKEN", "xoxp-wrong"],
    ["SLACK_USER_TOKEN", "xoxb-wrong"],
    ["SLACK_TEAM_ID", "U123"],
    ["SLACK_OWNER_USER_ID", "T123"],
  ] as const) assert.throws(() => loadConfig({ ...slack, [key]: value }, { qiyanHome }), new RegExp(key));
});

test("loadConfig applies bounded defaults", () => {
  const config = loadConfig(baseEnv(), { qiyanHome });
  assert.equal(config.maxConcurrentTurns, 4);
  assert.equal(config.maxCollectCount, 20);
  assert.equal(config.mcpHost, "127.0.0.1");
  assert.equal(config.qiyanHome, qiyanHome);
  assert.equal(config.assistantWorkdir, "/home/test-user/private-qiyan/qiyan-workdir");
  assert.equal(config.userHome, "/home/test-user");
  assert.equal(config.dataDir, "/home/test-user/private-qiyan/data");
  assert.equal(config.sessionRegistryPath, "/home/test-user/private-qiyan/data/sessions.json");
  assert.equal(config.assistantSandboxMode, "danger-full-access");
});

test("loadConfig accepts an explicit execution sandbox", () => {
  const config = loadConfig(baseEnv({ ASSISTANT_SANDBOX_MODE: "read-only" }), { qiyanHome });
  assert.equal(config.assistantSandboxMode, "read-only");
});

test("a standalone worker sandbox variable cannot lower assistant security", () => {
  const removedWorkerSetting = ["SAND", "BOX_MODE"].join("");
  const config = loadConfig(baseEnv({ [removedWorkerSetting]: "read-only" }), { qiyanHome });
  assert.equal(config.assistantSandboxMode, "danger-full-access");
});

test("loadConfig rejects unsafe MCP binding", () => {
  assert.throws(() => loadConfig(baseEnv({ MCP_HOST: "0.0.0.0" }), { qiyanHome }), /MCP_HOST/);
});

test("loadConfig rejects an outbound chat other than the authorized owner's private chat", () => {
  assert.throws(() => loadConfig(baseEnv({ TELEGRAM_DESTINATION_CHAT_ID: "99" }), { qiyanHome }), /TELEGRAM_DESTINATION_CHAT_ID/);
});

test("CLI workdir overrides the environment and resolves from the launch directory", () => {
  const config = loadConfig(baseEnv({ ASSISTANT_WORKDIR: "from-env" }), { qiyanHome, assistantWorkdir: "from-cli" });
  assert.equal(config.assistantWorkdir, resolve("from-cli"));
});

test("CLI workdir takes precedence before an invalid environment workdir is validated", () => {
  const config = loadConfig(baseEnv({ ASSISTANT_WORKDIR: "" }), { qiyanHome, assistantWorkdir: "from-cli" });
  assert.equal(config.assistantWorkdir, resolve("from-cli"));
});

test("assistant login configuration needs only data and Codex paths", () => {
  assert.deepEqual(loadAssistantLoginConfig({ HOME: "/home/test-user", DATA_DIR: "private-data", CODEX_BINARY: "/opt/codex" }, qiyanHome), {
    dataDir: resolve("private-data"),
    codexBinary: "/opt/codex",
  });
  assert.deepEqual(loadAssistantLoginConfig({ HOME: "/home/test-user" }, qiyanHome), {
    dataDir: join(qiyanHome, "data"),
    codexBinary: "codex",
  });
  assert.throws(() => loadAssistantLoginConfig({}, qiyanHome), /HOME/);
});

test("the example environment preserves canonical full-access HOME defaults", async () => {
  const example = await import("node:fs/promises").then(({ readFile }) => readFile(resolve(".env.example"), "utf8"));
  assert.doesNotMatch(example, /^(?:DATA_DIR|SESSION_REGISTRY_PATH)=/mu);
  assert.doesNotMatch(example, /^ASSISTANT_SANDBOX_MODE=(?!danger-full-access$)/mu);
});

import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadConfig, loadAssistantLoginConfig, claudeLaunchPolicy, CLAUDE_DISABLED_TOOLS, CLAUDE_REDIRECT_PROMPT } from "../src/config.ts";

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
    SLACK_OWNER_USER_ID: "U123",
  }, { qiyanHome }).chat, {
    primary: "slack",
    slack: {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      userToken: "xoxp-test",
      ownerUserId: "U123",
    },
  });

  assert.deepEqual(loadConfig({
    HOME: "/home/test-user",
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_USER_TOKEN: "xoxp-test",
    SLACK_TEAM_ID: "E123",
    SLACK_OWNER_USER_ID: "U123",
  }, { qiyanHome }).chat.slack, {
    appToken: "xapp-test",
    botToken: "xoxb-test",
    userToken: "xoxp-test",
    ownerUserId: "U123",
  });
});

test("loadConfig accepts WeChat-only and requires an explicit configured primary with any multiple adapters", () => {
  assert.deepEqual(loadConfig({ HOME: "/home/test-user" }, { qiyanHome, weixinConfigured: true }).chat, {
    primary: "weixin",
    weixin: { configured: true },
  });

  const telegramAndWeixin = baseEnv();
  assert.throws(() => loadConfig(telegramAndWeixin, { qiyanHome, weixinConfigured: true }), /PRIMARY_CHAT_APP/u);
  assert.equal(loadConfig(
    { ...telegramAndWeixin, PRIMARY_CHAT_APP: "weixin" },
    { qiyanHome, weixinConfigured: true },
  ).chat.primary, "weixin");

  const allThree = baseEnv({
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_USER_TOKEN: "xoxp-test",
    SLACK_OWNER_USER_ID: "U123",
  });
  assert.throws(() => loadConfig(allThree, { qiyanHome, weixinConfigured: true }), /PRIMARY_CHAT_APP/u);
  for (const primary of ["telegram", "slack", "weixin"] as const) {
    assert.equal(loadConfig(
      { ...allThree, PRIMARY_CHAT_APP: primary },
      { qiyanHome, weixinConfigured: true },
    ).chat.primary, primary);
  }
  assert.throws(() => loadConfig(
    { HOME: "/home/test-user", PRIMARY_CHAT_APP: "weixin" },
    { qiyanHome },
  ), /configured chat adapter/u);
});

test("loadConfig requires an exact configured primary when both adapters exist", () => {
  const both = baseEnv({
    SLACK_APP_TOKEN: "xapp-test",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_USER_TOKEN: "xoxp-test",
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
    SLACK_OWNER_USER_ID: "U123",
  };
  for (const [key, value] of [
    ["SLACK_APP_TOKEN", "xoxb-wrong"],
    ["SLACK_BOT_TOKEN", "xoxp-wrong"],
    ["SLACK_USER_TOKEN", "xoxb-wrong"],
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
  assert.equal(config.endpointCatalogPath, "/home/test-user/private-qiyan/endpoints.json");
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
  assert.match(example, /all four Slack values/iu);
  assert.doesNotMatch(example, /SLACK_TEAM_ID/u);
});

test("claudeLaunchPolicy disables Claude's built-in scheduling and appends the redirect regardless of a local endpoint", () => {
  // The policy is unconditional — a remote-only deployment (no CLAUDE_CODE_ENDPOINT_ID) must still
  // apply it, so a remote worker never keeps the native Monitor/ScheduleWakeup/cron tools.
  for (const model of [undefined, "haiku"] as const) {
    const policy = claudeLaunchPolicy(model);
    assert.deepEqual([...policy.disallowedTools], [...CLAUDE_DISABLED_TOOLS]);
    for (const tool of ["Monitor", "ScheduleWakeup", "CronCreate", "CronList", "CronDelete"]) {
      assert.ok(policy.disallowedTools.includes(tool), `${tool} must be disabled`);
    }
    assert.equal(policy.appendSystemPrompt, CLAUDE_REDIRECT_PROMPT);
  }
  assert.equal(claudeLaunchPolicy().model, undefined);
  assert.equal(claudeLaunchPolicy("haiku").model, "haiku");
  assert.equal(claudeLaunchPolicy().effort, undefined);
  assert.equal(claudeLaunchPolicy("haiku", "high").effort, "high");
  assert.equal(claudeLaunchPolicy(undefined, "low").effort, "low");
});

test("web UI default host/port comes from WEB_HOST/WEB_PORT (default 127.0.0.1:9520)", () => {
  // The web UI is always available (toggled by `web-ui start|stop` + state, not a config flag);
  // WEB_HOST/WEB_PORT only set the default bind address.
  assert.deepEqual(loadConfig(baseEnv(), { qiyanHome }).webUi, { host: "127.0.0.1", port: 9520 });
  assert.deepEqual(loadConfig(baseEnv({ WEB_HOST: "0.0.0.0", WEB_PORT: "8080" }), { qiyanHome }).webUi, { host: "0.0.0.0", port: 8080 });
});

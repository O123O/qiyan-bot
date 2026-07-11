import { join, resolve } from "node:path";
import { z } from "zod";

const positiveInt = z.coerce.number().int().positive();

const configValueSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_OWNER_ID: z.coerce.number().int().optional(),
  TELEGRAM_DESTINATION_CHAT_ID: z.coerce.number().int().optional(),
  SLACK_APP_TOKEN: z.string().regex(/^xapp-.+/u).optional(),
  SLACK_BOT_TOKEN: z.string().regex(/^xoxb-.+/u).optional(),
  SLACK_USER_TOKEN: z.string().regex(/^xoxp-.+/u).optional(),
  SLACK_OWNER_USER_ID: z.string().regex(/^U[A-Z0-9]+$/u).optional(),
  PRIMARY_CHAT_APP: z.enum(["telegram", "slack", "weixin"]).optional(),
  HOME: z.string().min(1),
  ASSISTANT_WORKDIR: z.string().min(1).optional(),
  DATA_DIR: z.string().min(1).optional(),
  SESSION_REGISTRY_PATH: z.string().min(1).optional(),
  CODEX_BINARY: z.string().default("codex"),
  // Opt-in local Claude Code endpoint (Phase 1.4). Absent CLAUDE_CODE_ENDPOINT_ID,
  // no Claude endpoint is constructed and behavior is unchanged.
  CLAUDE_CODE_ENDPOINT_ID: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u).refine((v) => v !== "local" && v !== "assistant-local", "reserved endpoint id").optional(),
  CLAUDE_BINARY: z.string().default("claude"),
  CLAUDE_CODE_MODEL: z.string().min(1).optional(),
  MAX_CONCURRENT_TURNS: positiveInt.default(4),
  MAX_COLLECT_COUNT: positiveInt.max(100).default(20),
  MCP_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  MCP_PORT: z.coerce.number().int().min(0).max(65_535).default(43_721),
  ATTACHMENT_MAX_BYTES: positiveInt.default(20 * 1024 * 1024),
  ATTACHMENT_STORE_MAX_BYTES: positiveInt.default(1024 * 1024 * 1024),
  ASSISTANT_SANDBOX_MODE: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("danger-full-access"),
});

// Every env key the config schema reads. `HOME` is a system value, not a QiYan dotenv
// key; all others MUST be in SUPPORTED_DOTENV_KEYS or a .env carrying them is rejected
// at startup (guarded by a consistency test).
export const CONFIG_DOTENV_KEYS = Object.keys(configValueSchema.shape).filter((key) => key !== "HOME");

function configSchema(weixinConfigured: boolean) {
  return configValueSchema.superRefine((value, context) => {
    const telegramFields = [value.TELEGRAM_BOT_TOKEN, value.TELEGRAM_OWNER_ID, value.TELEGRAM_DESTINATION_CHAT_ID];
    const slackFields = [value.SLACK_APP_TOKEN, value.SLACK_BOT_TOKEN, value.SLACK_USER_TOKEN, value.SLACK_OWNER_USER_ID];
    const telegramPresent = telegramFields.filter((field) => field !== undefined).length;
    const slackPresent = slackFields.filter((field) => field !== undefined).length;
    const telegram = telegramPresent === telegramFields.length;
    const slack = slackPresent === slackFields.length;
    if (telegramPresent > 0 && !telegram) context.addIssue({ code: "custom", path: ["TELEGRAM_BOT_TOKEN"], message: "Telegram credential group must be complete" });
    if (slackPresent > 0 && !slack) context.addIssue({ code: "custom", path: ["SLACK_APP_TOKEN"], message: "Slack credential group must be complete" });
    if (!telegram && !slack && !weixinConfigured && telegramPresent === 0 && slackPresent === 0) {
      context.addIssue({ code: "custom", path: ["PRIMARY_CHAT_APP"], message: "at least one complete chat adapter is required" });
    }
    if (telegram && value.TELEGRAM_DESTINATION_CHAT_ID !== value.TELEGRAM_OWNER_ID) {
      context.addIssue({ code: "custom", path: ["TELEGRAM_DESTINATION_CHAT_ID"], message: "must equal TELEGRAM_OWNER_ID for the single-user private-chat MVP" });
    }
    if ([telegram, slack, weixinConfigured].filter(Boolean).length > 1 && value.PRIMARY_CHAT_APP === undefined) {
      context.addIssue({ code: "custom", path: ["PRIMARY_CHAT_APP"], message: "PRIMARY_CHAT_APP is required when multiple chat adapters are configured" });
    }
    if (value.PRIMARY_CHAT_APP === "telegram" && !telegram) {
      context.addIssue({ code: "custom", path: ["PRIMARY_CHAT_APP"], message: "PRIMARY_CHAT_APP must name a configured chat adapter" });
    }
    if (value.PRIMARY_CHAT_APP === "slack" && !slack) {
      context.addIssue({ code: "custom", path: ["PRIMARY_CHAT_APP"], message: "PRIMARY_CHAT_APP must name a configured chat adapter" });
    }
    if (value.PRIMARY_CHAT_APP === "weixin" && !weixinConfigured) {
      context.addIssue({ code: "custom", path: ["PRIMARY_CHAT_APP"], message: "PRIMARY_CHAT_APP must name a configured chat adapter" });
    }
  });
}

export interface TelegramConfig { token: string; ownerId: number; destinationChatId: number }
export interface SlackConfig { appToken: string; botToken: string; userToken: string; ownerUserId: string }
export interface ChatConfig {
  primary: "telegram" | "slack" | "weixin";
  telegram?: TelegramConfig;
  slack?: SlackConfig;
  weixin?: { configured: true };
}

// Fixed enforcement defaults for a managed Claude session (design §5): the native
// schedulers are disabled and the model is redirected to QiYan's tools.
export const CLAUDE_DISABLED_TOOLS = ["Monitor", "ScheduleWakeup", "CronCreate", "CronList", "CronDelete"] as const;
export const CLAUDE_REDIRECT_PROMPT =
  "You have NO built-in scheduling ability. For any scheduled, recurring, or condition-watching work you MUST use the QiYan MCP tools (schedule_wakeup, schedule_cron, monitor). Never use built-in Monitor/ScheduleWakeup/cron tools, the /loop skill, background tasks, or hooks.";

export interface ClaudeCodeConfig {
  endpointId: string;
  command: string;
  model?: string;
  disallowedTools: readonly string[];
  appendSystemPrompt: string;
}

export interface BotConfig {
  qiyanHome: string;
  chat: ChatConfig;
  claudeCode?: ClaudeCodeConfig;
  userHome: string;
  assistantWorkdir: string;
  dataDir: string;
  sessionRegistryPath: string;
  endpointCatalogPath: string;
  codexBinary: string;
  maxConcurrentTurns: number;
  maxCollectCount: number;
  mcpHost: "127.0.0.1";
  mcpPort: number;
  attachmentMaxBytes: number;
  attachmentStoreMaxBytes: number;
  assistantSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
}

export interface ConfigOverrides { qiyanHome: string; assistantWorkdir?: string; weixinConfigured?: boolean }

export interface AssistantLoginConfig { dataDir: string; codexBinary: string }

export function loadAssistantLoginConfig(env: Record<string, string | undefined>, qiyanHome: string): AssistantLoginConfig {
  const parsed = z.object({
    HOME: z.string().min(1),
    DATA_DIR: z.string().min(1).optional(),
    CODEX_BINARY: z.string().min(1).default("codex"),
  }).parse(env);
  return {
    dataDir: resolve(parsed.DATA_DIR ?? join(qiyanHome, "data")),
    codexBinary: parsed.CODEX_BINARY,
  };
}

export function loadConfig(env: Record<string, string | undefined>, overrides: ConfigOverrides): BotConfig {
  const parsed = configSchema(overrides.weixinConfigured ?? false).parse(overrides.assistantWorkdir === undefined
    ? env
    : { ...env, ASSISTANT_WORKDIR: overrides.assistantWorkdir });
  const home = resolve(parsed.HOME);
  const defaultRoot = resolve(overrides.qiyanHome);
  const dataDir = resolve(parsed.DATA_DIR ?? join(defaultRoot, "data"));
  const telegram: TelegramConfig | undefined = parsed.TELEGRAM_BOT_TOKEN === undefined ? undefined : {
    token: parsed.TELEGRAM_BOT_TOKEN,
    ownerId: parsed.TELEGRAM_OWNER_ID!,
    destinationChatId: parsed.TELEGRAM_DESTINATION_CHAT_ID!,
  };
  const slack: SlackConfig | undefined = parsed.SLACK_APP_TOKEN === undefined ? undefined : {
    appToken: parsed.SLACK_APP_TOKEN,
    botToken: parsed.SLACK_BOT_TOKEN!,
    userToken: parsed.SLACK_USER_TOKEN!,
    ownerUserId: parsed.SLACK_OWNER_USER_ID!,
  };
  const primary = parsed.PRIMARY_CHAT_APP ?? (telegram ? "telegram" : slack ? "slack" : "weixin");
  return {
    qiyanHome: defaultRoot,
    chat: {
      primary,
      ...(telegram ? { telegram } : {}),
      ...(slack ? { slack } : {}),
      ...(overrides.weixinConfigured ? { weixin: { configured: true as const } } : {}),
    },
    userHome: home,
    assistantWorkdir: resolve(parsed.ASSISTANT_WORKDIR ?? join(defaultRoot, "qiyan-workdir")),
    dataDir,
    sessionRegistryPath: resolve(parsed.SESSION_REGISTRY_PATH ?? join(dataDir, "sessions.json")),
    endpointCatalogPath: resolve(join(defaultRoot, "endpoints.json")),
    ...(parsed.CLAUDE_CODE_ENDPOINT_ID === undefined ? {} : {
      claudeCode: {
        endpointId: parsed.CLAUDE_CODE_ENDPOINT_ID,
        command: parsed.CLAUDE_BINARY,
        disallowedTools: CLAUDE_DISABLED_TOOLS,
        appendSystemPrompt: CLAUDE_REDIRECT_PROMPT,
        ...(parsed.CLAUDE_CODE_MODEL === undefined ? {} : { model: parsed.CLAUDE_CODE_MODEL }),
      } satisfies ClaudeCodeConfig,
    }),
    codexBinary: parsed.CODEX_BINARY,
    maxConcurrentTurns: parsed.MAX_CONCURRENT_TURNS,
    maxCollectCount: parsed.MAX_COLLECT_COUNT,
    mcpHost: parsed.MCP_HOST,
    mcpPort: parsed.MCP_PORT,
    attachmentMaxBytes: parsed.ATTACHMENT_MAX_BYTES,
    attachmentStoreMaxBytes: parsed.ATTACHMENT_STORE_MAX_BYTES,
    assistantSandboxMode: parsed.ASSISTANT_SANDBOX_MODE,
  };
}

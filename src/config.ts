import { join, resolve } from "node:path";
import { z } from "zod";

const positiveInt = z.coerce.number().int().positive();

const configSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_OWNER_ID: z.coerce.number().int(),
  TELEGRAM_DESTINATION_CHAT_ID: z.coerce.number().int(),
  HOME: z.string().min(1),
  ASSISTANT_WORKDIR: z.string().min(1).optional(),
  DATA_DIR: z.string().min(1).optional(),
  SESSION_REGISTRY_PATH: z.string().min(1).optional(),
  CODEX_BINARY: z.string().default("codex"),
  MAX_CONCURRENT_TURNS: positiveInt.default(4),
  MAX_COLLECT_COUNT: positiveInt.max(100).default(20),
  MCP_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  MCP_PORT: z.coerce.number().int().min(0).max(65_535).default(43_721),
  ATTACHMENT_MAX_BYTES: positiveInt.default(20 * 1024 * 1024),
  ATTACHMENT_STORE_MAX_BYTES: positiveInt.default(1024 * 1024 * 1024),
  ASSISTANT_SANDBOX_MODE: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("danger-full-access"),
}).refine((value) => value.TELEGRAM_DESTINATION_CHAT_ID === value.TELEGRAM_OWNER_ID, {
  path: ["TELEGRAM_DESTINATION_CHAT_ID"],
  message: "must equal TELEGRAM_OWNER_ID for the single-user private-chat MVP",
});

export interface BotConfig {
  telegramBotToken: string;
  telegramOwnerId: number;
  telegramDestinationChatId: number;
  assistantWorkdir: string;
  dataDir: string;
  sessionRegistryPath: string;
  codexBinary: string;
  maxConcurrentTurns: number;
  maxCollectCount: number;
  mcpHost: "127.0.0.1";
  mcpPort: number;
  attachmentMaxBytes: number;
  attachmentStoreMaxBytes: number;
  assistantSandboxMode: "read-only" | "workspace-write" | "danger-full-access";
}

export interface ConfigOverrides { assistantWorkdir?: string }

export interface AssistantLoginConfig { dataDir: string; codexBinary: string }

export function loadAssistantLoginConfig(env: Record<string, string | undefined>): AssistantLoginConfig {
  const parsed = z.object({
    HOME: z.string().min(1),
    DATA_DIR: z.string().min(1).optional(),
    CODEX_BINARY: z.string().min(1).default("codex"),
  }).parse(env);
  const home = resolve(parsed.HOME);
  return {
    dataDir: resolve(parsed.DATA_DIR ?? join(home, ".qiyan-bot", "data")),
    codexBinary: parsed.CODEX_BINARY,
  };
}

export function loadConfig(env: Record<string, string | undefined>, overrides: ConfigOverrides = {}): BotConfig {
  const parsed = configSchema.parse(overrides.assistantWorkdir === undefined
    ? env
    : { ...env, ASSISTANT_WORKDIR: overrides.assistantWorkdir });
  const home = resolve(parsed.HOME);
  const defaultRoot = join(home, ".qiyan-bot");
  const dataDir = resolve(parsed.DATA_DIR ?? join(defaultRoot, "data"));
  return {
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    telegramOwnerId: parsed.TELEGRAM_OWNER_ID,
    telegramDestinationChatId: parsed.TELEGRAM_DESTINATION_CHAT_ID,
    assistantWorkdir: resolve(parsed.ASSISTANT_WORKDIR ?? join(defaultRoot, "assistant")),
    dataDir,
    sessionRegistryPath: resolve(parsed.SESSION_REGISTRY_PATH ?? join(dataDir, "sessions.json")),
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

import { z } from "zod";
import { AppError, StartupPhaseError, type ErrorCode } from "./core/errors.ts";

export type CliHelpTopic = "root" | "assistant-login" | "weixin-login" | "config-check" | "service";
export type ServiceAction = "install" | "start" | "stop" | "restart" | "status" | "logs" | "uninstall";

export type CliCommand =
  | { command: "run"; assistantWorkdir?: string; qiyanHome?: string }
  | { command: "assistant-login"; qiyanHome?: string }
  | { command: "weixin-login"; qiyanHome?: string }
  | { command: "config-check"; qiyanHome?: string }
  | { command: "service"; action: ServiceAction; qiyanHome?: string }
  | { command: "help"; topic: CliHelpTopic }
  | { command: "update" }
  | { command: "version" };

export function parseCliArgs(argv: readonly string[]): CliCommand {
  if (argv[0] === "--help" || argv[0] === "-h") {
    if (argv.length !== 1) throw new AppError("CONFIGURATION_ERROR", "unknown argument");
    return { command: "help", topic: "root" };
  }
  if (argv[0] === "--update" || argv[0] === "--version") {
    if (argv.length !== 1) throw new AppError("CONFIGURATION_ERROR", "unknown argument");
    return { command: argv[0] === "--update" ? "update" : "version" };
  }
  if (argv[0] === "service") return parseServiceArgs(argv.slice(1));
  if (argv[0] === "assistant-login" || argv[0] === "weixin-login" || argv[0] === "config-check") {
    const command = argv[0];
    if (argv[1] === "--help" || argv[1] === "-h") {
      if (argv.length !== 2) throw new AppError("CONFIGURATION_ERROR", "unknown argument");
      return { command: "help", topic: command };
    }
    const options = parsePathOptions(argv.slice(1), false);
    return options.qiyanHome === undefined ? { command } : { command, qiyanHome: options.qiyanHome };
  }
  const options = parsePathOptions(argv, true);
  return {
    command: "run",
    ...(options.assistantWorkdir === undefined ? {} : { assistantWorkdir: options.assistantWorkdir }),
    ...(options.qiyanHome === undefined ? {} : { qiyanHome: options.qiyanHome }),
  };
}

export function formatCliHelp(topic: CliHelpTopic): string {
  if (topic === "service") {
    return "QiYan systemd user service\n\nUsage:\n  qiyan-bot service <install|start|stop|restart|status|logs|uninstall>\n  qiyan-bot service install [--home <path>]\n\nThe service runs the foreground bot under systemd; tmux is not required.\nUse `qiyan-bot service logs` to read the latest 100 journal entries.\n";
  }
  if (topic !== "root") {
    return `QiYan ${topic}\n\nUsage:\n  qiyan-bot ${topic} [--home <path>]\n\nOptions:\n  -h, --help     Show help\n  --home <path>  QiYan home directory\n`;
  }
  return `QiYan personal assistant bot\n\nUsage:\n  qiyan-bot [--home <path>] [--workdir <path>]\n  qiyan-bot assistant-login [--home <path>]\n  qiyan-bot weixin-login [--home <path>]\n  qiyan-bot config-check [--home <path>]\n  qiyan-bot service <action>\n  qiyan-bot --update\n  qiyan-bot --version\n\nRunning without a command starts the long-lived bot in the foreground.\n\nOptions:\n  -h, --help       Show help\n  --home <path>    QiYan home directory\n  --workdir <path> Assistant working directory (run only)\n  --update         Install the latest GitHub Release\n  --version        Print version\n\nRequires Node.js 24 or newer.\n`;
}

const serviceActions = new Set<ServiceAction>(["install", "start", "stop", "restart", "status", "logs", "uninstall"]);

function parseServiceArgs(argv: readonly string[]): CliCommand {
  if (argv[0] === "--help" || argv[0] === "-h") {
    if (argv.length !== 1) throw new AppError("CONFIGURATION_ERROR", "unknown argument");
    return { command: "help", topic: "service" };
  }
  if (argv[1] === "--help" || argv[1] === "-h") {
    if (argv.length !== 2) throw new AppError("CONFIGURATION_ERROR", "unknown argument");
    return { command: "help", topic: "service" };
  }
  const action = argv[0];
  if (action === undefined) throw new AppError("CONFIGURATION_ERROR", "service action is required");
  if (!serviceActions.has(action as ServiceAction)) throw new AppError("CONFIGURATION_ERROR", "unknown service action");
  if (action === "install") {
    const options = parsePathOptions(argv.slice(1), false);
    return options.qiyanHome === undefined
      ? { command: "service", action }
      : { command: "service", action, qiyanHome: options.qiyanHome };
  }
  if (argv.length !== 1) throw new AppError("CONFIGURATION_ERROR", "unknown argument");
  return { command: "service", action: action as Exclude<ServiceAction, "install"> };
}

function parsePathOptions(argv: readonly string[], allowWorkdir: boolean): { assistantWorkdir?: string; qiyanHome?: string } {
  let assistantWorkdir: string | undefined;
  let qiyanHome: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument !== "--home" && (argument !== "--workdir" || !allowWorkdir)) throw new AppError("CONFIGURATION_ERROR", "unknown argument");
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new AppError("CONFIGURATION_ERROR", `${argument} requires a path`);
    if (argument === "--workdir") {
      if (assistantWorkdir !== undefined) throw new AppError("CONFIGURATION_ERROR", "--workdir may be specified only once");
      assistantWorkdir = value;
    } else {
      if (qiyanHome !== undefined) throw new AppError("CONFIGURATION_ERROR", "--home may be specified only once");
      qiyanHome = value;
    }
    index += 1;
  }
  return {
    ...(assistantWorkdir === undefined ? {} : { assistantWorkdir }),
    ...(qiyanHome === undefined ? {} : { qiyanHome }),
  };
}

export function formatStartupError(error: unknown): string {
  if (error instanceof StartupPhaseError) {
    if (error.cause instanceof AppError && error.cause.code === "CONFIGURATION_ERROR") return formatStartupError(error.cause);
    const reason = startupPhaseReasons.get(error.phase) ?? "application startup failed";
    if (!(error.cause instanceof AppError)) return `STARTUP_ERROR: ${reason}`;
    if (detailedStartupCodes.has(error.cause.code)) return `STARTUP_ERROR: ${reason} (${error.cause.code}: ${error.cause.message})`;
    return `STARTUP_ERROR: ${reason} (${error.cause.code})`;
  }
  if (error instanceof AppError && error.code === "CONFIGURATION_ERROR") return `${error.code}: ${error.message}`;
  if (error instanceof z.ZodError) {
    const issues = error.issues.map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`).join("; ");
    return `CONFIGURATION_ERROR: ${issues}`;
  }
  return "startup failed";
}

const detailedStartupCodes = new Set<ErrorCode>([
  "ENDPOINT_UNAVAILABLE",
  "ENDPOINT_IDENTITY_CHANGED",
  "UNSUPPORTED_CAPABILITY",
  "PERMISSION_BLOCKED",
]);

const startupPhaseReasons: ReadonlyMap<string, string> = new Map([
  ["assistant-workspace", "assistant workspace initialization failed"],
  ["assistant-working-directory", "assistant working directory activation failed"],
  ["storage", "state database initialization failed"],
  ["registry", "session registry initialization failed"],
  ["dashboard", "session dashboard initialization failed"],
  ["attachments", "attachment store initialization failed"],
  ["chat-adapters", "chat adapter initialization failed; verify configured credentials"],
  ["mcp", "manager tool server startup failed"],
  ["subscriptions", "runtime subscription initialization failed"],
  ["endpoint", "Codex App Server startup failed; verify CODEX_BINARY, Codex version, and assistant authentication"],
  ["reconciliation", "startup reconciliation failed"],
  ["assistant", "assistant session initialization failed"],
  ["scheduler", "assistant scheduler startup failed"],
  ["delivery", "delivery recovery startup failed"],
  ["maintenance", "maintenance scheduler startup failed"],
  ["chat-ingress", "chat connection startup failed; verify credentials and network access"],
]);

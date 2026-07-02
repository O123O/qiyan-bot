import { z } from "zod";
import { AppError } from "./core/errors.ts";

export type CliCommand =
  | { command: "run"; assistantWorkdir?: string; qiyanHome?: string }
  | { command: "assistant-login"; qiyanHome?: string }
  | { command: "config-check"; qiyanHome?: string }
  | { command: "update" }
  | { command: "version" };

export function parseCliArgs(argv: readonly string[]): CliCommand {
  if (argv[0] === "--update" || argv[0] === "--version") {
    if (argv.length !== 1) throw new AppError("CONFIGURATION_ERROR", "unknown argument");
    return { command: argv[0] === "--update" ? "update" : "version" };
  }
  if (argv[0] === "assistant-login" || argv[0] === "config-check") {
    const command = argv[0];
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
  if (error instanceof AppError && error.code === "CONFIGURATION_ERROR") return `${error.code}: ${error.message}`;
  if (error instanceof z.ZodError) {
    const issues = error.issues.map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`).join("; ");
    return `CONFIGURATION_ERROR: ${issues}`;
  }
  return "startup failed";
}

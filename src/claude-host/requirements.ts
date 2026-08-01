// Deployment prerequisites for a Claude worker host: the Claude Agent SDK and the
// Claude CLI must both be installed on the machine that runs the host.
//
// Neither is bundled. The SDK resolves a ~264 MB platform-specific native Claude binary
// from its own package directory (traced: it execs
// `node_modules/@anthropic-ai/claude-agent-sdk-<platform>/claude`), which cannot be
// inlined into `dist/qiyan-bot`, so the SDK is marked external in the build and imported
// from the host's own installation. The CLI is required separately because the host
// launches sessions through it via `pathToClaudeCodeExecutable` rather than the SDK's
// vendored copy, which keeps one Claude on the machine rather than two.
//
// Both checks fail closed at startup with an actionable message. An endpoint that cannot
// satisfy them must report UNSUPPORTED_CAPABILITY rather than accepting turns it will
// drop later.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError } from "../core/errors.ts";

const run = promisify(execFile);

// The SDK's JS and the CLI are released together and its manifest pins an exact CLI
// build, so a host whose CLI predates the SDK can miss control-protocol capabilities the
// host relies on. Gate on the minimum proven by the capability spike.
export const MIN_CLAUDE_CLI_VERSION = "2.1.220";

export interface ClaudeRuntimeRequirements {
  sdkVersion: string;
  claudeVersion: string;
  claudeExecutable: string;
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    (value.match(/\d+/gu) ?? []).map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function parseClaudeVersion(output: string): string | undefined {
  // `claude --version` prints e.g. "2.1.220 (Claude Code)".
  return /(\d+\.\d+\.\d+)/u.exec(output)?.[1];
}

// Dynamic import so a deployment without the SDK fails with this message rather than an
// unresolvable-module crash at process start.
export async function loadAgentSdk(
  importer: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<Record<string, unknown>> {
  try {
    return await importer("@anthropic-ai/claude-agent-sdk") as Record<string, unknown>;
  } catch (error) {
    throw new AppError("CONFIGURATION_ERROR",
      "the Claude Agent SDK is not installed on this host. Install it alongside qiyan-bot "
      + "(npm i -g @anthropic-ai/claude-agent-sdk) — it is a deployment prerequisite, not a "
      + "bundled dependency, because it carries a platform-specific native binary.",
      { cause: error instanceof Error ? error.message : String(error) });
  }
}

export async function resolveClaudeCli(
  executable: string,
  options: { exec?: (file: string, args: string[]) => Promise<{ stdout: string }> } = {},
): Promise<string> {
  const exec = options.exec ?? ((file, args) => run(file, args));
  let stdout: string;
  try {
    ({ stdout } = await exec(executable, ["--version"]));
  } catch (error) {
    throw new AppError("CONFIGURATION_ERROR",
      `the Claude CLI is not runnable at "${executable}". Install Claude Code on this host, `
      + "or point the endpoint's `command` at it.",
      { cause: error instanceof Error ? error.message : String(error) });
  }
  const version = parseClaudeVersion(stdout);
  if (version === undefined) {
    throw new AppError("CONFIGURATION_ERROR",
      `could not read a version from "${executable} --version" (got ${JSON.stringify(stdout.slice(0, 120))})`);
  }
  if (compareVersions(version, MIN_CLAUDE_CLI_VERSION) < 0) {
    throw new AppError("UNSUPPORTED_CAPABILITY",
      `the Claude CLI at "${executable}" is ${version}, below the required ${MIN_CLAUDE_CLI_VERSION}. `
      + "Upgrade Claude Code on this host.");
  }
  return version;
}

export async function checkClaudeRuntimeRequirements(options: {
  claudeExecutable: string;
  importer?: (specifier: string) => Promise<unknown>;
  exec?: (file: string, args: string[]) => Promise<{ stdout: string }>;
}): Promise<ClaudeRuntimeRequirements> {
  const sdk = await loadAgentSdk(options.importer);
  const sdkVersion = typeof sdk.VERSION === "string" ? sdk.VERSION : "unknown";
  const claudeVersion = await resolveClaudeCli(options.claudeExecutable, options);
  return { sdkVersion, claudeVersion, claudeExecutable: options.claudeExecutable };
}

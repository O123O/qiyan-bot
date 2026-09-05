// Permission pass-through for a managed Claude session.
//
// QiYan sets no permission policy of its own — the worker's policy is the user's, exactly
// as for Codex. But the Agent SDK does not read `permissions.defaultMode` from settings
// files: with nothing passed, a session runs at `default` and every tool is denied
// (measured — foreground Bash, Write, and background Bash all blocked). `bypassPermissions`
// additionally requires an in-process opt-in that a config file cannot grant.
//
// So the host reads the user's own resolved `permissions.defaultMode` and forwards it,
// attaching the opt-in only when the user's config asked for bypass. A user who configures
// nothing still gets `default` and still sees tools denied; the fix remains their config.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Must track the SDK's own PermissionMode union. A mode missing here is not rejected loudly: the
// resolver skips it and falls through to `default`, where every tool is denied -- so a user who
// configured a perfectly valid mode sees a worker that cannot read, run, or reach the web, and
// nothing names the cause. "auto" was missing for exactly that reason on 2026-09-05: the CLI and
// SDK both accepted it, this list did not, and a worker ran denied under a correct config.
//
// "auto" is escalating in the same sense as bypassPermissions and acceptEdits, and like them needs
// no in-process opt-in -- that flag is specific to bypassPermissions.
export const CLAUDE_PERMISSION_MODES = [
  "default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto",
] as const;
export type ClaudePermissionMode = typeof CLAUDE_PERMISSION_MODES[number];

export interface ResolvedPermissions {
  permissionMode: ClaudePermissionMode;
  // Only ever true when the user's own settings asked for bypassPermissions.
  allowDangerouslySkipPermissions?: true;
  // Which settings file supplied the mode, for the actionable "your worker can't run
  // tools" diagnostic. "none" means no file set it and everything will be denied.
  source: string;
}

// Highest precedence first, mirroring Claude Code's own layering. Managed policy
// outranks the user because an administrator's lockdown must not be user-overridable.
function settingsCandidates(cwd: string, home: string): Array<{ path: string; source: string }> {
  return [
    { path: "/etc/claude-code/managed-settings.json", source: "managed" },
    { path: join(cwd, ".claude", "settings.local.json"), source: "local" },
    { path: join(cwd, ".claude", "settings.json"), source: "project" },
    { path: join(home, ".claude", "settings.json"), source: "user" },
  ];
}

async function readDefaultMode(path: string): Promise<string | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch { return undefined; }
  try {
    const parsed = JSON.parse(text) as { permissions?: { defaultMode?: unknown } };
    const mode = parsed.permissions?.defaultMode;
    return typeof mode === "string" ? mode : undefined;
  } catch {
    // A malformed settings file is the user's to fix; it must not crash the host or
    // silently escalate privilege, so it simply supplies no mode.
    return undefined;
  }
}

export async function resolveClaudePermissions(
  cwd: string,
  options: { home?: string } = {},
): Promise<ResolvedPermissions> {
  const home = options.home ?? homedir();
  for (const candidate of settingsCandidates(cwd, home)) {
    const mode = await readDefaultMode(candidate.path);
    if (mode === undefined) continue;
    if (!(CLAUDE_PERMISSION_MODES as readonly string[]).includes(mode)) continue;
    const resolved = mode as ClaudePermissionMode;
    return {
      permissionMode: resolved,
      ...(resolved === "bypassPermissions" ? { allowDangerouslySkipPermissions: true as const } : {}),
      source: candidate.source,
    };
  }
  return { permissionMode: "default", source: "none" };
}

// A worker at `default` will have every tool denied, which looks like a hung session
// rather than a configuration problem. The host surfaces this at open time.
export function permissionWarning(resolved: ResolvedPermissions): string | undefined {
  if (resolved.permissionMode !== "default") return undefined;
  return "Claude permission mode is 'default', so this worker's tool calls will be denied. "
    + "Set permissions.defaultMode in ~/.claude/settings.json (bypassPermissions for an "
    + "unattended worker).";
}

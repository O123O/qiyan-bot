import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Persisted control state for the web UI, toggled by `qiyan-bot web-ui start|stop [--host --port]`
// and read by the running bot when it reconciles. Lives under qiyanHome (stable + private 0700),
// not dataDir (which the bot may realpath-canonicalize at runtime).
//
// `host`/`port` are present only when set via a command flag (they override the env WEB_HOST/
// WEB_PORT defaults); absent means "fall back to env/default".

export interface WebUiState {
  enabled: boolean;
  host?: string;
  port?: number;
}

export function webUiStatePath(qiyanHome: string): string {
  return join(qiyanHome, "webui.json");
}

// Absent file ⇒ `{ enabled: false }` — the web UI is off by default (turned on with `web-ui start`).
// A corrupt / wrong-shape file THROWS so the caller keeps the current state instead of fail-opening
// the danger-full-access surface.
export function readWebUiState(statePath: string): WebUiState {
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false };
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`invalid web-ui state file: ${statePath}`);
  const record = parsed as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") throw new Error(`invalid web-ui state file: ${statePath}`);
  if (record.host !== undefined && typeof record.host !== "string") throw new Error(`invalid web-ui state host: ${statePath}`);
  if (record.port !== undefined && (typeof record.port !== "number" || !Number.isInteger(record.port) || record.port < 0 || record.port > 65_535)) throw new Error(`invalid web-ui state port: ${statePath}`);
  return {
    enabled: record.enabled,
    ...(record.host !== undefined ? { host: record.host as string } : {}),
    ...(record.port !== undefined ? { port: record.port as number } : {}),
  };
}

// Atomic write (temp file in the same dir + rename) so the bot never reads a torn file. The temp is
// removed if the write or rename fails, so a failure never leaves a stray .webui.*.tmp behind.
export function writeWebUiState(statePath: string, state: WebUiState): void {
  const body: WebUiState = {
    enabled: state.enabled,
    ...(state.host !== undefined ? { host: state.host } : {}),
    ...(state.port !== undefined ? { port: state.port } : {}),
  };
  const tmp = join(dirname(statePath), `.webui.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    renameSync(tmp, statePath);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

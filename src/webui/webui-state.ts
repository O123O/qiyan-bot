import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Persisted desired-listening state for the web UI, toggled by `qiyan-bot web-ui start|stop` and
// read by the running bot when it reconciles. Lives under qiyanHome (stable + private 0700),
// not dataDir (which the bot may realpath-canonicalize at runtime).

export function webUiStatePath(qiyanHome: string): string {
  return join(qiyanHome, "webui.json");
}

// The desired-enabled flag. Absent file ⇒ `true` (preserves "WEB_UI=1 ⇒ listens on startup").
// A corrupt / wrong-shape file THROWS so the caller keeps the current state instead of
// fail-opening the danger-full-access surface.
export function readWebUiEnabled(statePath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { enabled?: unknown }).enabled !== "boolean") {
    throw new Error(`invalid web-ui state file: ${statePath}`);
  }
  return (parsed as { enabled: boolean }).enabled;
}

// Atomic write (temp file in the same dir + rename) so the bot never reads a torn file. The temp is
// removed if the write or rename fails, so a failure never leaves a stray .webui.*.tmp behind.
export function writeWebUiEnabled(statePath: string, enabled: boolean): void {
  const tmp = join(dirname(statePath), `.webui.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify({ enabled })}\n`, { mode: 0o600 });
    renameSync(tmp, statePath);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

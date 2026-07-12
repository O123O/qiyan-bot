// Emulated archive state for Claude sessions. Claude Code has no native archive/delete (a
// session is just a `<id>.jsonl` transcript), so QiYan tombstones an archived thread here and
// the runtime's thread/list (discover) hides it — matching Codex, whose app-server archives the
// thread natively. A driven turn or a re-adopt (resume) clears the tombstone. Durable: it is
// registered in the recovery schema so a restart does not resurrect archived threads.
import type { Database } from "../storage/database.ts";

export class ClaudeArchiveStore {
  constructor(private readonly db: Database) {}

  add(endpointId: string, threadId: string, now?: number): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO claude_archived_threads(endpoint_id, thread_id, archived_at) VALUES (?, ?, ?)",
    ).run(endpointId, threadId, now ?? Date.now());
  }

  has(endpointId: string, threadId: string): boolean {
    return this.db.prepare(
      "SELECT 1 FROM claude_archived_threads WHERE endpoint_id = ? AND thread_id = ?",
    ).get(endpointId, threadId) !== undefined;
  }

  remove(endpointId: string, threadId: string): void {
    this.db.prepare("DELETE FROM claude_archived_threads WHERE endpoint_id = ? AND thread_id = ?").run(endpointId, threadId);
  }
}

import { AppError } from "../../core/errors.ts";
import type { Database } from "../../storage/database.ts";
import { inTransaction } from "../../storage/database.ts";

export class SlackWorkspaceStore {
  constructor(private readonly db: Database) {}

  bind(teamId: string): void {
    inTransaction(this.db, () => {
      const pinned = this.db.prepare("SELECT team_id FROM slack_workspace_identity WHERE singleton = 1")
        .get() as { team_id: string } | undefined;
      if (pinned) {
        if (pinned.team_id !== teamId) throw mismatch();
        return;
      }

      const legacy = this.db.prepare("SELECT DISTINCT team_id FROM slack_inbox").all() as Array<{ team_id: string }>;
      if (legacy.some((row) => row.team_id !== teamId)) throw mismatch();
      for (const { table, destination } of LEGACY_DESTINATIONS) {
        const rows = this.db.prepare(`SELECT ${destination} AS destination_json FROM ${table}
          WHERE adapter_id = 'slack' AND ${destination} IS NOT NULL`).all() as Array<{ destination_json: string }>;
        if (rows.some((row) => workspaceId(row.destination_json) !== teamId)) throw mismatch();
      }
      this.db.prepare("INSERT INTO slack_workspace_identity(singleton, team_id) VALUES (1, ?)").run(teamId);
    });
  }
}

const LEGACY_DESTINATIONS = [
  { table: "activated_chat_conversations", destination: "destination_json" },
  { table: "latest_owner_route", destination: "destination_json" },
  { table: "source_contexts", destination: "destination_json" },
  { table: "assistant_attempts", destination: "destination_json" },
  { table: "assistant_turn_lease", destination: "destination_json" },
  { table: "deliveries", destination: "destination_json" },
] as const;

function workspaceId(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const candidate = (parsed as Record<string, unknown>).workspaceId;
    return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function mismatch(): AppError {
  return new AppError("CONFIGURATION_ERROR", "persisted Slack workspace does not match the authenticated workspace");
}

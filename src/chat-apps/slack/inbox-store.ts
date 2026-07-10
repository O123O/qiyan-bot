import type { FileHandleId } from "../../attachments/store.ts";
import type { FailedAttachmentDescriptor } from "../../core/types.ts";
import type { Database } from "../../storage/database.ts";
import { inTransaction } from "../../storage/database.ts";
import type { NormalizedSlackEvent, SlackFileDescriptor } from "./types.ts";

export type SlackFileState =
  | { state: "completed"; attachmentId: FileHandleId }
  | { state: "failed"; descriptor: FailedAttachmentDescriptor };

export interface SlackInboxRecord extends NormalizedSlackEvent {
  state: "pending" | "processing" | "processed" | "retry";
  arrivalSequence: number;
  attemptCount: number;
  fileState: Record<string, SlackFileState>;
}

export class SlackInboxStore {
  constructor(private readonly db: Database) {}

  accept(event: NormalizedSlackEvent): "inserted" | "duplicate" {
    return inTransaction(this.db, () => {
      if (this.db.prepare("SELECT 1 FROM slack_inbox WHERE event_id = ?").get(event.eventId)) return "duplicate";
      const arrival = Number((this.db.prepare("SELECT next_value FROM slack_inbox_sequence WHERE singleton = 1").get() as { next_value: number }).next_value);
      this.db.prepare(`INSERT INTO slack_inbox
        (event_id, team_id, event_type, channel_id, message_ts, thread_ts, user_id, text, files_json, file_state_json,
          arrival_sequence, state, attempt_count, received_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 'pending', 0, ?, ?)`)
        .run(event.eventId, event.teamId, event.eventType, event.channelId, event.messageTs, event.threadTs ?? null,
          event.userId, event.rawText, JSON.stringify(event.files), arrival, event.receivedAt, Date.now());
      this.db.prepare("UPDATE slack_inbox_sequence SET next_value = ? WHERE singleton = 1").run(arrival + 1);
      if (event.activate) {
        this.db.prepare(`INSERT OR IGNORE INTO activated_chat_conversations
          (adapter_id, conversation_key, destination_json, activated_at) VALUES ('slack', ?, ?, ?)`)
          .run(event.binding.conversationKey, JSON.stringify(event.binding.destination), event.receivedAt);
      }
      return "inserted";
    });
  }

  isActivated(conversationKey: string): boolean {
    return this.db.prepare("SELECT 1 FROM activated_chat_conversations WHERE adapter_id = 'slack' AND conversation_key = ?")
      .get(conversationKey) !== undefined;
  }

  get(eventId: string): SlackInboxRecord | undefined {
    const row = this.db.prepare("SELECT * FROM slack_inbox WHERE event_id = ?").get(eventId) as Record<string, unknown> | undefined;
    return row ? this.parse(row) : undefined;
  }

  peekOldest(): SlackInboxRecord | undefined {
    const row = this.db.prepare("SELECT * FROM slack_inbox WHERE state <> 'processed' ORDER BY arrival_sequence LIMIT 1").get() as Record<string, unknown> | undefined;
    return row ? this.parse(row) : undefined;
  }

  claimNext(): SlackInboxRecord | undefined {
    return inTransaction(this.db, () => {
      const row = this.db.prepare("SELECT event_id, state FROM slack_inbox WHERE state <> 'processed' ORDER BY arrival_sequence LIMIT 1")
        .get() as { event_id: string; state: string } | undefined;
      if (!row || row.state === "processing") return undefined;
      const changed = this.db.prepare(`UPDATE slack_inbox SET state = 'processing', attempt_count = attempt_count + 1, updated_at = ?
        WHERE event_id = ? AND state IN ('pending', 'retry')`).run(Date.now(), row.event_id).changes;
      return changed === 1 ? this.get(row.event_id) : undefined;
    });
  }

  retry(eventId: string, _error: unknown): void {
    this.db.prepare(`UPDATE slack_inbox SET state = 'retry', last_error = 'Slack ingress retry', updated_at = ?
      WHERE event_id = ? AND state = 'processing'`).run(Date.now(), eventId);
  }

  recoverProcessing(): number {
    return Number(this.db.prepare(`UPDATE slack_inbox SET state = 'retry', last_error = 'Slack ingress recovered after restart', updated_at = ?
      WHERE state = 'processing'`).run(Date.now()).changes);
  }

  markProcessedInTransaction(eventId: string): void {
    const changed = this.db.prepare(`UPDATE slack_inbox SET state = 'processed', last_error = NULL, updated_at = ?
      WHERE event_id = ? AND state = 'processing'`).run(Date.now(), eventId).changes;
    if (changed !== 1) throw new Error("Slack inbox row is not processing");
  }

  markFileCompleted(eventId: string, slackFileId: string, attachmentId: string): void {
    this.updateFileState(eventId, slackFileId, { state: "completed", attachmentId: attachmentId as FileHandleId });
  }

  markFileFailed(eventId: string, slackFileId: string, descriptor: FailedAttachmentDescriptor): void {
    this.updateFileState(eventId, slackFileId, { state: "failed", descriptor });
  }

  private updateFileState(eventId: string, slackFileId: string, state: SlackFileState): void {
    inTransaction(this.db, () => {
      const row = this.db.prepare("SELECT file_state_json FROM slack_inbox WHERE event_id = ?").get(eventId) as { file_state_json: string } | undefined;
      if (!row) throw new Error("unknown Slack inbox row");
      const current = JSON.parse(row.file_state_json) as Record<string, SlackFileState>;
      current[slackFileId] = state;
      this.db.prepare("UPDATE slack_inbox SET file_state_json = ?, updated_at = ? WHERE event_id = ?")
        .run(JSON.stringify(current), Date.now(), eventId);
    });
  }

  private parse(row: Record<string, unknown>): SlackInboxRecord {
    const eventType = String(row.event_type) as NormalizedSlackEvent["eventType"];
    const teamId = String(row.team_id);
    const channelId = String(row.channel_id);
    const messageTs = String(row.message_ts);
    const threadTs = row.thread_ts ? String(row.thread_ts) : undefined;
    const root = threadTs ?? messageTs;
    const dm = eventType === "message.im";
    return {
      eventId: String(row.event_id),
      eventType,
      teamId,
      channelId,
      messageTs,
      ...(threadTs ? { threadTs } : {}),
      userId: String(row.user_id),
      rawText: String(row.text),
      files: JSON.parse(String(row.files_json)) as SlackFileDescriptor[],
      nativeSourceId: `${teamId}:${channelId}:${messageTs}`,
      sourceId: `slack:${teamId}:${channelId}:${messageTs}`,
      binding: dm ? {
        adapterId: "slack",
        conversationKey: `slack:${teamId}:dm:${channelId}`,
        destination: { workspaceId: teamId, channelId },
        reply: { messageTs },
      } : {
        adapterId: "slack",
        conversationKey: `slack:${teamId}:thread:${channelId}:${root}`,
        destination: { workspaceId: teamId, channelId, threadTs: root },
        reply: { messageTs },
      },
      activate: eventType === "app_mention",
      receivedAt: Number(row.received_at),
      state: String(row.state) as SlackInboxRecord["state"],
      arrivalSequence: Number(row.arrival_sequence),
      attemptCount: Number(row.attempt_count),
      fileState: JSON.parse(String(row.file_state_json)) as Record<string, SlackFileState>,
    };
  }
}

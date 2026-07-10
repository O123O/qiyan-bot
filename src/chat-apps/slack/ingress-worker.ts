import { createHash } from "node:crypto";
import type { AttachmentStore, FileHandleId } from "../../attachments/store.ts";
import type { ChatAcceptanceEffects, ConversationStore } from "../../storage/conversation-store.ts";
import type { DeliveryStore } from "../../storage/delivery-store.ts";
import type { CanonicalChatSource, FailedAttachmentDescriptor } from "../../core/types.ts";
import type { SlackInboxStore, SlackInboxRecord } from "./inbox-store.ts";
import type { SlackFileDescriptor } from "./types.ts";

interface DownloadedSlackFile { stream: AsyncIterable<Uint8Array | string>; size?: number }

export class SlackIngressWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining: Promise<void> | undefined;

  constructor(
    private readonly inbox: SlackInboxStore,
    private readonly attachments: AttachmentStore,
    private readonly conversations: ConversationStore,
    private readonly deliveries: DeliveryStore,
    private readonly options: {
      downloadFile(url: string): Promise<DownloadedSlackFile>;
      isTransient(error: unknown): boolean;
      onMessage(source: CanonicalChatSource, effects: ChatAcceptanceEffects): Promise<void>;
      maxMessageBytes?: number;
    },
  ) {}

  async processOne(): Promise<boolean> {
    const row = this.inbox.claimNext();
    if (!row) return false;
    try {
      if (this.conversations.hasChatSource("slack", row.nativeSourceId)) {
        await this.options.onMessage(this.source(row, [], []), { commitNativeCheckpoint: () => this.inbox.markProcessedInTransaction(row.eventId) });
        return true;
      }

      const attachmentIds: FileHandleId[] = [];
      const failures: FailedAttachmentDescriptor[] = [];
      let messageBytes = 0;
      for (const file of row.files) {
        const checkpoint = this.inbox.get(row.eventId)?.fileState[file.slackFileId];
        if (checkpoint?.state === "failed") {
          failures.push(checkpoint.descriptor);
          continue;
        }
        const attachmentId = checkpoint?.state === "completed" ? checkpoint.attachmentId : deterministicAttachmentId(row, file);
        let saved = this.attachments.get(row.sourceId, attachmentId);
        if (!saved) {
          if (!file.downloadUrl) {
            const descriptor = failedDescriptor(file, "download_unavailable");
            this.inbox.markFileFailed(row.eventId, file.slackFileId, descriptor);
            failures.push(descriptor);
            continue;
          }
          try {
            const download = await this.options.downloadFile(file.downloadUrl);
            const declaredSize = download.size ?? file.declaredSize;
            saved = await this.attachments.ingest(row.sourceId, download.stream, {
              displayName: file.displayName,
              mediaType: file.mediaType,
              ...(declaredSize === undefined ? {} : { declaredSize }),
            }, attachmentId);
            this.inbox.markFileCompleted(row.eventId, file.slackFileId, attachmentId);
          } catch (error) {
            if (this.options.isTransient(error)) {
              this.inbox.retry(row.eventId, error);
              return false;
            }
            const descriptor = failedDescriptor(file, "download_failed");
            this.inbox.markFileFailed(row.eventId, file.slackFileId, descriptor);
            failures.push(descriptor);
            continue;
          }
        }
        messageBytes += saved.size;
        if (messageBytes > (this.options.maxMessageBytes ?? Number.MAX_SAFE_INTEGER)) {
          const descriptor = failedDescriptor(file, "message_size_limit");
          this.inbox.markFileFailed(row.eventId, file.slackFileId, descriptor);
          failures.push(descriptor);
          continue;
        }
        attachmentIds.push(saved.id);
      }

      await this.options.onMessage(this.source(row, attachmentIds, failures), {
        commitNativeCheckpoint: () => {
          this.inbox.markProcessedInTransaction(row.eventId);
          for (const failed of failures) this.deliveries.prepare({
            id: `slack-attachment-warning:${row.sourceId}:${failed.nativeId}`,
            kind: "attachment_warning",
            binding: row.binding,
            body: `[system] Slack attachment ${failed.displayName} is unavailable (${failed.reasonCode})`,
            mandatory: true,
          });
        },
      });
      return true;
    } catch (error) {
      this.inbox.retry(row.eventId, error);
      return false;
    }
  }

  async recoverAndDrain(): Promise<void> {
    this.inbox.recoverProcessing();
    await this.drain();
  }

  async drain(): Promise<void> {
    while (await this.processOne()) { /* drain in committed order */ }
  }

  start(intervalMs = 250): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.draining) return;
      this.draining = this.drain().finally(() => { this.draining = undefined; });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  private source(row: SlackInboxRecord, attachmentIds: readonly string[], failures: readonly FailedAttachmentDescriptor[]): CanonicalChatSource {
    return {
      id: row.sourceId,
      nativeSourceId: row.nativeSourceId,
      binding: row.binding,
      rawText: row.rawText,
      attachmentIds,
      failedAttachments: failures,
      receivedAt: row.receivedAt,
    };
  }
}

function deterministicAttachmentId(row: SlackInboxRecord, file: SlackFileDescriptor): FileHandleId {
  const value = createHash("sha256").update(`${row.teamId}\0${row.channelId}\0${row.messageTs}\0${file.slackFileId}`).digest("hex");
  return `file_${value}`;
}

function failedDescriptor(file: SlackFileDescriptor, reasonCode: string): FailedAttachmentDescriptor {
  return { nativeId: file.slackFileId, displayName: file.displayName, reasonCode };
}

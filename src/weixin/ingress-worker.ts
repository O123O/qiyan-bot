import type { AttachmentStore, FileHandleId } from "../attachments/store.ts";
import type { ChatAcceptanceEffects, ConversationStore } from "../storage/conversation-store.ts";
import type { CanonicalChatSource, FailedAttachmentDescriptor } from "../core/types.ts";
import { validateTencentUrl } from "./endpoint-policy.ts";
import type { WeixinClassifiedItem } from "./event-classifier.ts";
import type { WeixinInboxRecord, WeixinInboxStore } from "./inbox-store.ts";
import { weixinNativeSourceId } from "./inbox-store.ts";
import {
  decodeWeixinAesKey,
  decryptWeixinMedia,
  deterministicWeixinAttachmentId,
  safeWeixinFileName,
  verifyWeixinMediaIntegrity,
} from "./media.ts";

interface IngressOptions {
  generationId: string;
  botId: string;
  ownerUserId: string;
  download(url: URL): Promise<AsyncIterable<Uint8Array | string>>;
  isTransient(error: unknown): boolean;
  onMessage(source: CanonicalChatSource, effects: ChatAcceptanceEffects): Promise<void>;
  maxMediaBytes: number;
}

export class WeixinIngressWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining: Promise<void> | undefined;

  constructor(
    private readonly inbox: WeixinInboxStore,
    private readonly attachments: AttachmentStore,
    private readonly conversations: ConversationStore,
    private readonly options: IngressOptions,
  ) {}

  async processOne(): Promise<boolean> {
    const row = this.inbox.claimHead(this.options.generationId);
    if (!row) return false;
    try {
      const attachmentIds: FileHandleId[] = [];
      const failures: FailedAttachmentDescriptor[] = [];
      const text: string[] = [];
      for (const [ordinal, item] of row.items.entries()) {
        if (item.kind === "text") {
          text.push(item.text);
          continue;
        }
        if (item.kind === "failed") {
          failures.push(failedDescriptor(ordinal, item.reason));
          continue;
        }
        const checkpoint = this.inbox.mediaCheckpoint(row.generationId, row.identity, ordinal);
        if (checkpoint?.state === "failed") {
          failures.push(checkpoint.descriptor as FailedAttachmentDescriptor);
          continue;
        }
        if (checkpoint?.state === "completed") {
          if (!this.attachments.get(checkpoint.scopeId, checkpoint.attachmentId)) throw new Error("WeChat media checkpoint attachment is unavailable");
          attachmentIds.push(checkpoint.attachmentId);
          continue;
        }
        try {
          const saved = await this.downloadAndStore(row, ordinal, item);
          attachmentIds.push(saved);
        } catch (error) {
          if (this.options.isTransient(error)) {
            this.inbox.retry(row.generationId, row.identity, "media_transient");
            return false;
          }
          const descriptor = failedDescriptor(ordinal, "media_invalid");
          this.inbox.markMediaFailed(row.generationId, row.identity, ordinal, descriptor);
          failures.push(descriptor);
        }
      }

      const source = this.source(row, text.join("\n"), attachmentIds, failures);
      await this.options.onMessage(source, {
        commitNativeCheckpoint: () => this.inbox.completeAndTransferHoldsInTransaction(
          row.generationId, row.identity, source.id, attachmentIds,
        ),
      });
      return true;
    } catch (error) {
      const committed = this.conversations.hasChatSource("weixin", weixinNativeSourceId(row.generationId, row.identity));
      if (committed && this.inbox.get(row.generationId, row.identity)?.state === "processed") return true;
      this.inbox.retry(row.generationId, row.identity, this.options.isTransient(error) ? "transient" : "processing_failed");
      return false;
    }
  }

  async recoverAndDrain(): Promise<void> {
    this.inbox.recoverProcessing(this.options.generationId);
    await this.drain();
  }

  async drain(): Promise<void> {
    while (await this.processOne()) { /* committed FIFO */ }
  }

  scheduleDrain(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => { this.draining = undefined; });
  }

  start(intervalMs = 250): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.scheduleDrain(); }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.draining;
  }

  private async downloadAndStore(
    row: WeixinInboxRecord,
    ordinal: number,
    item: Extract<WeixinClassifiedItem, { kind: "image" | "file" }>,
  ): Promise<FileHandleId> {
    const media = item.kind === "image" ? item.image.media : item.file.media;
    const urlValue = media?.fullUrl ?? (item.kind === "image" ? item.image.url : undefined);
    if (!urlValue) throw new TypeError("WeChat media download is unavailable");
    const url = validateTencentUrl(urlValue, "cdn-download");
    const key = item.kind === "image" && item.image.aesKeyHex !== undefined
      ? decodeImageHexKey(item.image.aesKeyHex)
      : media?.aesKey === undefined ? undefined : decodeWeixinAesKey(media.aesKey);
    if (item.kind === "file" && !key) throw new TypeError("WeChat file encryption key is unavailable");
    const source = await this.options.download(url);
    const bytes = key
      ? await collect(decryptWeixinMedia(source, key, {
        maxCiphertextBytes: this.options.maxMediaBytes,
        maxPlaintextBytes: this.options.maxMediaBytes,
      }))
      : await collectBounded(source, this.options.maxMediaBytes);
    const plaintextSize = item.kind === "file" && item.file.length !== undefined
      ? parseSize(item.file.length)
      : undefined;
    verifyWeixinMediaIntegrity({
      bytes,
      kind: item.kind,
      ...(item.kind === "file" && item.file.md5 !== undefined ? { md5: item.file.md5 } : {}),
      ...(plaintextSize === undefined ? {} : { plaintextSize }),
      ...(item.kind === "image" && key && (item.image.highDefinitionSize ?? item.image.mediumSize) !== undefined
        ? { ciphertextSize: item.image.highDefinitionSize ?? item.image.mediumSize }
        : {}),
    });
    const id = deterministicWeixinAttachmentId(row.generationId, row.identity, ordinal);
    const displayName = item.kind === "file" ? safeWeixinFileName(item.file.displayName) : `image-${ordinal + 1}`;
    const saved = await this.attachments.ingest(rowSourceId(row), bytesIterable(bytes), {
      displayName,
      mediaType: item.kind === "image" ? imageMediaType(bytes) : "application/octet-stream",
      declaredSize: bytes.length,
    }, id);
    this.inbox.checkpointAttachment(row.generationId, row.identity, ordinal, {
      scopeId: rowSourceId(row), attachment: saved, descriptor: { kind: item.kind },
    });
    return saved.id;
  }

  private source(
    row: WeixinInboxRecord,
    rawText: string,
    attachmentIds: readonly FileHandleId[],
    failures: readonly FailedAttachmentDescriptor[],
  ): CanonicalChatSource {
    const routeTokenId = row.routeTokenId;
    return {
      id: rowSourceId(row),
      nativeSourceId: weixinNativeSourceId(row.generationId, row.identity),
      binding: {
        adapterId: "weixin",
        conversationKey: `weixin:${row.generationId}:${this.options.ownerUserId}`,
        destination: {
          generationId: row.generationId,
          botId: this.options.botId,
          ownerUserId: this.options.ownerUserId,
          ...(routeTokenId === undefined ? {} : { routeTokenId }),
        },
      },
      rawText,
      attachmentIds,
      failedAttachments: failures,
      receivedAt: row.receivedAt,
    };
  }
}

function rowSourceId(row: WeixinInboxRecord): string {
  return weixinNativeSourceId(row.generationId, row.identity);
}

function failedDescriptor(ordinal: number, reasonCode: string): FailedAttachmentDescriptor {
  return { nativeId: `item-${ordinal}`, displayName: `WeChat item ${ordinal + 1}`, reasonCode };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function collectBounded(source: AsyncIterable<Uint8Array | string>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of source) {
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) throw new TypeError("WeChat media plaintext exceeds limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function* bytesIterable(value: Buffer): AsyncIterable<Uint8Array> { yield value; }

function parseSize(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new TypeError("WeChat file length is invalid");
  const size = Number(value);
  if (!Number.isSafeInteger(size)) throw new TypeError("WeChat file length is invalid");
  return size;
}

function imageMediaType(bytes: Buffer): string {
  if (bytes[0] === 0x89) return "image/png";
  if (bytes[0] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  return "image/webp";
}

function decodeImageHexKey(value: string): Buffer {
  if (!/^[a-fA-F0-9]{32}$/u.test(value)) throw new TypeError("WeChat image AES key is invalid");
  return Buffer.from(value, "hex");
}

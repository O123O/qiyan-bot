import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AttachmentStore } from "../../src/attachments/store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { TelegramChatAdapter } from "../../src/telegram/chat-adapter.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("adapter uses supplied transports without touching real Telegram", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "telegram-adapter-seam-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const db = createTestDatabase();
  context.after(() => db.close());
  const delivery = {
    sendMessage: async () => ({ message_id: 1 }),
    sendDocument: async () => ({ message_id: 2 }),
  };
  let closes = 0;
  let deliveryCloses = 0;
  const adapter = new TelegramChatAdapter(
    db,
    new AttachmentStore(db, root, { maxFileBytes: 100, maxStoreBytes: 1_000 }),
    { token: "token", ownerId: 42, maxMessageBytes: 100, onMessage: async () => undefined },
    {
      createTransports: () => ({
        polling: {
          getUpdates: async () => new Promise<never>(() => undefined),
          downloadFile: async () => ({ stream: Readable.from([]) }),
        },
        delivery,
        closePolling: async () => { closes += 1; },
        closeDelivery: async () => { deliveryCloses += 1; },
      }),
    },
  );

  assert.equal(adapter.delivery.id, "telegram");
  await adapter.initialize();
  await adapter.stop();
  assert.equal(closes, 1);
  await Promise.all([adapter.close(), adapter.close()]);
  assert.equal(deliveryCloses, 1);
  assert.throws(() => adapter.start(), /stopped/u);
});

test("adapter waits for polling-owned work and closes its dispatcher exactly once", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "telegram-adapter-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const db = createTestDatabase();
  context.after(() => db.close());
  const attachments = new AttachmentStore(db, root, { maxFileBytes: 100, maxStoreBytes: 1_000 });
  await attachments.initialize();
  const downloadStarted = deferred<void>();
  const releaseDownload = deferred<void>();
  let closes = 0;
  const transports = {
    polling: {
      getUpdates: async () => [{
        update_id: 1,
        message: {
          message_id: 2,
          date: 1,
          chat: { id: 10, type: "private" as const },
          from: { id: 42 },
          document: { file_id: "file", file_name: "note.txt", mime_type: "text/plain" },
        },
      }],
      downloadFile: async () => {
        downloadStarted.resolve();
        await releaseDownload.promise;
        return { stream: Readable.from(["content"]), size: 7 };
      },
    },
    delivery: {
      sendMessage: async () => ({ message_id: 1 }),
      sendDocument: async () => ({ message_id: 2 }),
    },
    closePolling: async () => { closes += 1; },
    closeDelivery: async () => undefined,
  };
  const adapter = new TelegramChatAdapter(db, attachments, {
    token: "token",
    ownerId: 42,
    maxMessageBytes: 100,
    onMessage: async () => undefined,
  }, { createTransports: () => transports });

  adapter.start();
  await downloadStarted.promise;
  const first = adapter.stop();
  const second = adapter.stop();
  await Promise.resolve();
  assert.equal(closes, 0);
  releaseDownload.resolve();
  await Promise.all([first, second, adapter.stop()]);
  assert.equal(closes, 1);
});

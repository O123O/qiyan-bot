import assert from "node:assert/strict";
import test from "node:test";
import { classifyUpdate, toTelegramCanonicalSource } from "../../src/chat-apps/telegram/adapter.ts";

test("accepts an ordinary owner message", () => {
  const result = classifyUpdate({
    update_id: 10,
    message: { message_id: 7, date: 100, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "hello" },
  }, 42);
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted") assert.equal(result.message.rawText, "hello");
});

test("ignores another sender without retaining content", () => {
  const result = classifyUpdate({
    update_id: 11,
    message: { message_id: 8, date: 100, chat: { id: -1, type: "group" }, from: { id: 99 }, text: "secret text" },
  }, 42);
  assert.deepEqual(result, { kind: "ignored", updateId: 11, reason: "unauthorized_sender" });
  assert.equal(JSON.stringify(result).includes("secret text"), false);
});

test("ignores edited, callback, channel, and service updates", () => {
  const updates = [
    { update_id: 12, edited_message: { from: { id: 42 }, text: "edit" } },
    { update_id: 13, callback_query: { from: { id: 42 }, data: "click" } },
    { update_id: 14, channel_post: { text: "post" } },
    { update_id: 15, message: { message_id: 9, date: 100, chat: { id: 42, type: "private" }, from: { id: 42 }, new_chat_members: [{ id: 2 }] } },
  ];
  for (const update of updates) assert.equal(classifyUpdate(update, 42).kind, "ignored");
});

test("accepts supported photo and document metadata", () => {
  const photo = classifyUpdate({
    update_id: 16,
    message: { message_id: 10, date: 100, chat: { id: 42, type: "private" }, from: { id: 42 }, caption: "look", photo: [{ file_id: "small", file_size: 10 }, { file_id: "large", file_size: 20 }] },
  }, 42);
  assert.equal(photo.kind, "accepted");
  if (photo.kind === "accepted") assert.equal(photo.pendingFiles[0]?.fileId, "large");
});

test("normalizes stable Telegram conversation identity and native reply metadata", () => {
  const first = classifyUpdate({
    update_id: 20,
    message: { message_id: 9, date: 100, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "hello" },
  }, 42);
  const second = classifyUpdate({
    update_id: 21,
    message: { message_id: 10, date: 101, chat: { id: 42, type: "private" }, from: { id: 42 }, text: "again" },
  }, 42);
  const other = classifyUpdate({
    update_id: 22,
    message: { message_id: 1, date: 102, chat: { id: 99, type: "private" }, from: { id: 42 }, text: "other" },
  }, 42);
  assert.equal(first.kind, "accepted");
  assert.equal(second.kind, "accepted");
  assert.equal(other.kind, "accepted");
  if (first.kind !== "accepted" || second.kind !== "accepted" || other.kind !== "accepted") return;
  const canonical = toTelegramCanonicalSource(first.message, ["file-one", "file-two"]);
  assert.deepEqual(canonical.binding, {
    adapterId: "telegram",
    conversationKey: "telegram:42",
    destination: { chatId: "42" },
    reply: { messageId: 9 },
  });
  assert.equal(canonical.id, "telegram:42:9");
  assert.equal(canonical.nativeSourceId, "20");
  assert.deepEqual(canonical.attachmentIds, ["file-one", "file-two"]);
  assert.equal(toTelegramCanonicalSource(second.message, []).binding.conversationKey, canonical.binding.conversationKey);
  assert.notEqual(toTelegramCanonicalSource(other.message, []).binding.conversationKey, canonical.binding.conversationKey);
});

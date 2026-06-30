import assert from "node:assert/strict";
import test from "node:test";
import { classifyUpdate } from "../../src/telegram/adapter.ts";

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

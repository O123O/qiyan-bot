import assert from "node:assert/strict";
import test from "node:test";
import { classifyWeixinMessage } from "../../src/weixin/event-classifier.ts";
import type { ParsedMessageCandidate } from "../../src/weixin/protocol.ts";

const owner = { botId: "bot", ownerUserId: "owner" };

function candidate(overrides: Partial<Extract<ParsedMessageCandidate, { status: "valid" }>> = {}): ParsedMessageCandidate {
  return {
    status: "valid",
    ordinal: 0,
    identity: { kind: "message", value: "1" },
    fromUserId: "owner",
    toUserId: "bot",
    items: [{ kind: "text", text: "hello" }],
    ...overrides,
  };
}

test("classifies only exact direct owner messages without retaining rejected content", () => {
  assert.deepEqual(classifyWeixinMessage(candidate(), owner), {
    ordinal: 0,
    identity: { kind: "message", value: "1" },
    items: [{ kind: "text", text: "hello" }],
  });
  for (const rejected of [
    { status: "malformed", ordinal: 0, reason: "invalid_shape" as const },
    candidate({ fromUserId: "stranger", items: [{ kind: "text", text: "private-stranger-body" }] }),
    candidate({ fromUserId: "bot", items: [{ kind: "text", text: "private-bot-echo" }] }),
    candidate({ messageType: 2, items: [{ kind: "text", text: "private-labeled-bot-echo" }] }),
    candidate({ messageType: 0 }),
    candidate({ toUserId: "another-bot" }),
    candidate({ groupId: "group" }),
  ] as ParsedMessageCandidate[]) assert.equal(classifyWeixinMessage(rejected, owner), undefined);
});

test("normalizes supported item order and makes unsupported media explicit", () => {
  const result = classifyWeixinMessage(candidate({
    contextToken: "private-context",
    items: [
      { kind: "text", text: "typed" },
      { kind: "voice", transcription: "spoken" },
      { kind: "voice" },
      { kind: "image", image: { url: "https://weixin.qq.com/image" } },
      { kind: "file", file: { displayName: "notes.txt" } },
      { kind: "video", video: {} },
      { kind: "unknown", type: 99 },
    ],
  }), owner);
  assert.deepEqual(result, {
    ordinal: 0,
    identity: { kind: "message", value: "1" },
    contextToken: "private-context",
    items: [
      { kind: "text", text: "typed" },
      { kind: "text", text: "spoken", source: "voice" },
      { kind: "failed", reason: "voice_without_transcription" },
      { kind: "image", image: { url: "https://weixin.qq.com/image" } },
      { kind: "file", file: { displayName: "notes.txt" } },
      { kind: "failed", reason: "video_unsupported" },
      { kind: "failed", reason: "item_unsupported" },
    ],
  });
});

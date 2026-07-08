import assert from "node:assert/strict";
import test from "node:test";
import { classifySlackEvent } from "../../src/slack/event-classifier.ts";

const context = (activated: readonly string[] = []) => ({
  teamId: "T1",
  ownerUserId: "U1",
  botUserId: "B1",
  now: () => 1_700_000_000_000,
  isActivated: (key: string) => activated.includes(key),
});

function envelope(event: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    type: "event_callback",
    team_id: "T1",
    event_id: "E1",
    event_time: 1_700_000_000,
    event,
    ...overrides,
  };
}

test("accepts an owner DM with stable DM identity", () => {
  const result = classifySlackEvent(envelope({ type: "message", channel_type: "im", channel: "D1", user: "U1", ts: "1710000000.000100", text: "hello" }), context());
  assert.equal(result.kind, "accept");
  if (result.kind !== "accept") return;
  assert.equal(result.event.nativeSourceId, "T1:D1:1710000000.000100");
  assert.equal(result.event.sourceId, "slack:T1:D1:1710000000.000100");
  assert.deepEqual(result.event.binding, {
    adapterId: "slack",
    conversationKey: "slack:T1:dm:D1",
    destination: { workspaceId: "T1", channelId: "D1" },
    reply: { messageTs: "1710000000.000100" },
  });
  assert.equal(result.event.activate, false);
});

test("accepts a forwarded owner DM from shared attachment content", () => {
  const result = classifySlackEvent(envelope({
    type: "message", channel_type: "im", channel: "D1", user: "U1", ts: "1710000000.000200", text: "",
    attachments: [{
      is_share: true,
      is_msg_unfurl: true,
      author_name: "Bob",
      text: "Forwarded hello",
    }],
  }), context());
  assert.equal(result.kind, "accept");
  if (result.kind !== "accept") return;
  assert.equal(result.event.rawText, "[Forwarded Slack message from Bob]\nForwarded hello");
  assert.deepEqual(result.event.files, []);
});

test("discards a genuinely empty owner DM", () => {
  const result = classifySlackEvent(envelope({
    type: "message", channel_type: "im", channel: "D1", user: "U1", ts: "1710000000.000200", text: "", blocks: [], attachments: [],
  }), context());
  assert.equal(result.kind, "discard");
});

test("discards a mention-only activation after removing the routing mention", () => {
  const result = classifySlackEvent(envelope({
    type: "app_mention", channel_type: "channel", channel: "C1", user: "U1", ts: "1710000000.000200",
    text: "<@B1>", blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "user", user_id: "B1" }] }] }],
  }), context());
  assert.equal(result.kind, "discard");
});

test("a top-level owner mention activates its own thread and preserves pass payload", () => {
  const result = classifySlackEvent(envelope({
    type: "app_mention", channel: "C1", user: "U1", ts: "1710000000.000100", text: "<@B1> /pass  exact",
  }), context());
  assert.equal(result.kind, "accept");
  if (result.kind !== "accept") return;
  assert.equal(result.event.rawText, "/pass  exact");
  assert.equal(result.event.activate, true);
  assert.deepEqual(result.event.binding, {
    adapterId: "slack",
    conversationKey: "slack:T1:thread:C1:1710000000.000100",
    destination: { workspaceId: "T1", channelId: "C1", threadTs: "1710000000.000100" },
    reply: { messageTs: "1710000000.000100" },
  });
});

test("a mention inside a thread retains the existing root", () => {
  const result = classifySlackEvent(envelope({
    type: "app_mention", channel: "G1", user: "U1", ts: "1710000001.000200", thread_ts: "1710000000.000100", text: "<@B1> continue",
  }), context());
  assert.equal(result.kind, "accept");
  if (result.kind !== "accept") return;
  assert.equal(result.event.binding.conversationKey, "slack:T1:thread:G1:1710000000.000100");
  assert.deepEqual(result.event.binding.destination, { workspaceId: "T1", channelId: "G1", threadTs: "1710000000.000100" });
});

test("only an activated owner thread follow-up is eligible without a mention", () => {
  const key = "slack:T1:thread:C1:1710000000.000100";
  const event = envelope({ type: "message", channel_type: "channel", channel: "C1", user: "U1", ts: "1710000002.0", thread_ts: "1710000000.000100", text: "/collect 3" });
  assert.equal(classifySlackEvent(event, context()).kind, "discard");
  const accepted = classifySlackEvent(event, context([key]));
  assert.equal(accepted.kind, "accept");
  if (accepted.kind === "accept") {
    assert.equal(accepted.event.rawText, "/collect 3");
    assert.equal(accepted.event.activate, false);
  }
});

test("rejects wrong workspace, wrong owner, bot, service, edit, and malformed events", () => {
  const base = { type: "message", channel_type: "im", channel: "D1", user: "U1", ts: "1.0", text: "secret" };
  for (const candidate of [
    envelope(base, { team_id: "T2" }),
    envelope({ ...base, user: "U2" }),
    envelope({ ...base, bot_id: "BOT" }),
    envelope({ ...base, subtype: "message_changed" }),
    envelope({ ...base, subtype: "bot_message" }),
    envelope({ ...base, ts: undefined }),
    { nope: true },
  ]) assert.equal(classifySlackEvent(candidate, context()).kind, "discard");
});

test("does not strip a bot mention that is not the leading activation mention", () => {
  const result = classifySlackEvent(envelope({ type: "app_mention", channel: "C1", user: "U1", ts: "1.0", text: "before <@B1> after" }), context());
  assert.equal(result.kind, "accept");
  if (result.kind === "accept") assert.equal(result.event.rawText, "before <@B1> after");
});

test("normalizes only bounded Slack file metadata", () => {
  const result = classifySlackEvent(envelope({
    type: "message",
    channel_type: "im",
    channel: "D1",
    user: "U1",
    ts: "1.0",
    text: "file",
    files: [{
      id: "F1",
      name: "../bad\nname.txt",
      mimetype: "text/plain",
      size: 12,
      url_private_download: "https://files.slack.com/files-pri/T1-F1/download/file.txt",
      action_token: "must-not-survive",
      shares: { private: { secret: true } },
    }],
  }), context());
  assert.equal(result.kind, "accept");
  if (result.kind !== "accept") return;
  assert.deepEqual(result.event.files, [{
    slackFileId: "F1",
    displayName: "bad_name.txt",
    mediaType: "text/plain",
    declaredSize: 12,
    downloadUrl: "https://files.slack.com/files-pri/T1-F1/download/file.txt",
  }]);
  assert.doesNotMatch(JSON.stringify(result), /action_token|shares|must-not-survive/u);
});

test("accepts owner file-share messages while still rejecting other message subtypes", () => {
  const file = {
    id: "F1",
    name: "report.txt",
    mimetype: "text/plain",
    size: 12,
    url_private_download: "https://files.slack.com/files-pri/T1-F1/download/report.txt",
  };
  const dm = classifySlackEvent(envelope({
    type: "message", subtype: "file_share", channel_type: "im", channel: "D1", user: "U1", ts: "2.0",
    text: "report", bot_id: null, app_id: null, files: [file],
  }), context());
  assert.equal(dm.kind, "accept");
  if (dm.kind === "accept") assert.equal(dm.event.files[0]?.slackFileId, "F1");

  const key = "slack:T1:thread:C1:1.0";
  const thread = classifySlackEvent(envelope({
    type: "message", subtype: "file_share", channel_type: "channel", channel: "C1", user: "U1", ts: "2.0",
    thread_ts: "1.0", text: "report", bot_id: null, app_id: null, files: [file],
  }), context([key]));
  assert.equal(thread.kind, "accept");

  for (const subtype of ["message_changed", "bot_message", "thread_broadcast"]) {
    assert.equal(classifySlackEvent(envelope({
      type: "message", subtype, channel_type: "im", channel: "D1", user: "U1", ts: "2.0", text: "ignore",
    }), context()).kind, "discard");
  }
});

test("overlapping app mention and message events share native source identity", () => {
  const mention = classifySlackEvent(envelope({ type: "app_mention", channel: "C1", user: "U1", ts: "1.0", text: "<@B1> hi" }), context());
  const message = classifySlackEvent(envelope({ type: "message", channel_type: "channel", channel: "C1", user: "U1", ts: "1.0", thread_ts: "1.0", text: "<@B1> hi" }, { event_id: "E2" }), context(["slack:T1:thread:C1:1.0"]));
  assert.equal(mention.kind, "accept");
  assert.equal(message.kind, "accept");
  if (mention.kind === "accept" && message.kind === "accept") {
    assert.equal(mention.event.nativeSourceId, message.event.nativeSourceId);
    assert.equal(mention.event.rawText, "hi");
    assert.equal(message.event.rawText, "hi");
  }
});

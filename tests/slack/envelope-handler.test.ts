import assert from "node:assert/strict";
import test from "node:test";
import { SlackEnvelopeHandler } from "../../src/chat-apps/slack/envelope-handler.ts";
import { SlackInboxStore } from "../../src/chat-apps/slack/inbox-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";

const mention = {
  type: "event_callback", team_id: "T1", event_id: "E1", event_time: 1,
  event: { type: "app_mention", channel: "C1", user: "U1", ts: "1.0", text: "<@B1> start" },
};
const followUp = {
  type: "event_callback", team_id: "T1", event_id: "E2", event_time: 1,
  event: { type: "message", channel_type: "channel", channel: "C1", user: "U1", ts: "2.0", thread_ts: "1.0", text: "continue" },
};

function handler(store: SlackInboxStore) {
  return new SlackEnvelopeHandler(store, { teamId: "T1", ownerUserId: "U1", botUserId: "B1", now: () => 1 });
}

test("mention activation and inbox commit happen before ack so an immediate follow-up is retained", async () => {
  const db = createTestDatabase();
  const store = new SlackInboxStore(db);
  const value = handler(store);
  const observations: string[] = [];
  await value.handle({ body: mention, ack: async () => { observations.push(`ack:${db.prepare("SELECT COUNT(*) AS count FROM slack_inbox").get()!.count}`); } });
  await value.handle({ body: followUp, ack: async () => { observations.push("ack:follow-up"); } });
  assert.deepEqual(observations, ["ack:1", "ack:follow-up"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM slack_inbox").get()!.count, 2);
  assert.equal(store.isActivated("slack:T1:thread:C1:1.0"), true);
});

test("unauthorized content is acknowledged without retention", async () => {
  const db = createTestDatabase();
  const store = new SlackInboxStore(db);
  let acked = 0;
  await handler(store).handle({ body: { ...mention, event: { ...mention.event, user: "U2", text: "private secret" } }, ack: async () => { acked += 1; } });
  assert.equal(acked, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM slack_inbox").get()!.count, 0);
  assert.doesNotMatch(JSON.stringify(db.prepare("SELECT * FROM slack_inbox").all()), /private secret/u);
});

test("malformed and empty content is acknowledged without poison retries or retention", async () => {
  const db = createTestDatabase();
  const store = new SlackInboxStore(db);
  let acked = 0;
  const base = { type: "message", channel_type: "im", channel: "D1", user: "U1", ts: "3.0", text: "" };
  await handler(store).handle({ body: { ...mention, event_id: "E-empty", event: { ...base, blocks: [], attachments: [] } }, ack: async () => { acked += 1; } });
  await handler(store).handle({ body: { ...mention, event_id: "E-malformed", event: { ...base, ts: "4.0", blocks: "bad", files: [{ nope: true }] } }, ack: async () => { acked += 1; } });
  assert.equal(acked, 2);
  assert.equal(store.get("E-empty"), undefined);
  assert.equal(store.get("E-malformed")?.state, "pending");
  assert.match(store.get("E-malformed")?.rawText ?? "", /Unsupported Slack content/u);
});

test("a mention-only event is acknowledged without activating its thread", async () => {
  const db = createTestDatabase();
  const store = new SlackInboxStore(db);
  let acked = 0;
  await handler(store).handle({
    body: { ...mention, event_id: "E-mention-only", event: { ...mention.event, text: "<@B1>" } },
    ack: async () => { acked += 1; },
  });
  assert.equal(acked, 1);
  assert.equal(store.get("E-mention-only"), undefined);
  assert.equal(store.isActivated("slack:T1:thread:C1:1.0"), false);
});

test("persistence failure prevents acknowledgement", async () => {
  const db = createTestDatabase();
  const store = new SlackInboxStore(db);
  db.exec("DROP TABLE slack_inbox");
  let acked = false;
  await assert.rejects(handler(store).handle({ body: mention, ack: async () => { acked = true; } }));
  assert.equal(acked, false);
});

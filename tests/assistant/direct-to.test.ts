import assert from "node:assert/strict";
import test from "node:test";
import { deliverDirectTo, type DirectToDeps } from "../../src/assistant/direct-to.ts";
import type { CanonicalChatSource } from "../../src/core/types.ts";
import type { InternalSource } from "../../src/storage/conversation-store.ts";
import type { OperationalEvent } from "../../src/core/operational-log.ts";

const source: CanonicalChatSource = {
  id: "src-1",
  nativeSourceId: "web:owner:42",
  binding: { adapterId: "web", conversationKey: "web:owner", destination: { kind: "web" } },
  rawText: "/to payments fix the flaky test",
  attachmentIds: [],
  receivedAt: 1000,
};

function harness(opts: { alreadyDelivered?: boolean; sendImpl?: DirectToDeps["send"] } = {}) {
  const calls = {
    sends: [] as unknown[],
    recorded: [] as Array<{ audit: InternalSource; ownerEcho?: CanonicalChatSource }>,
    checkpoints: 0,
    reports: [] as OperationalEvent[],
  };
  const deps: DirectToDeps = {
    alreadyDelivered: () => opts.alreadyDelivered ?? false,
    send: async (nickname, text, options) => { calls.sends.push({ nickname, text, options }); return (opts.sendImpl ?? (async () => undefined))(nickname, text, options); },
    recordAudit: (audit, ownerEcho) => { calls.recorded.push({ audit, ...(ownerEcho ? { ownerEcho } : {}) }); },
    commitCheckpoint: () => { calls.checkpoints += 1; },
    report: (event) => { calls.reports.push(event); },
  };
  return { deps, calls };
}

test("delivers /to directly and records an audit row without waking QiYan", async () => {
  const { deps, calls } = harness();
  const result = await deliverDirectTo(deps, source, "payments", "fix the flaky test", "→ @payments  fix the flaky test");

  assert.deepEqual(calls.sends, [{ nickname: "payments", text: "fix the flaky test", options: { mode: "auto", clientUserMessageId: "to:web:owner:42" } }]);
  assert.equal(calls.recorded.length, 1);
  const note = calls.recorded[0]!.audit;
  assert.equal(note.kind, "direct_to");
  assert.equal(note.sourceId, "direct_to:web:owner:42"); // idempotency key derived from the ingress message
  assert.match(note.rawText, /payments/u);
  assert.doesNotMatch(note.rawText, /awareness|reply|resend/u);
  assert.match(note.rawText, /fix the flaky test/u);
  assert.equal(calls.recorded[0]!.ownerEcho?.rawText, "→ @payments  fix the flaky test");
  assert.equal(calls.recorded[0]!.ownerEcho?.nativeSourceId, source.nativeSourceId);
  assert.equal(calls.checkpoints, 1);                    // ingress ack — no redelivery
  assert.deepEqual(calls.reports, [{ level: "info", code: "direct_to_delivered", adapter: "web" }]);
  assert.deepEqual(result, { delivered: true });
});

test("a redelivery of the same message is a no-op except re-acking the ingress checkpoint", async () => {
  const { deps, calls } = harness({ alreadyDelivered: true });
  await deliverDirectTo(deps, source, "payments", "fix the flaky test");

  assert.deepEqual(calls.sends, []);       // not re-sent to the worker
  assert.deepEqual(calls.recorded, []);    // not re-recorded
  assert.deepEqual(calls.reports, []);
  assert.equal(calls.checkpoints, 1);      // but still acked so the surface stops redelivering
});

test("a failed direct send is non-fatal: still records an audit row, acks, and reports warn", async () => {
  const { deps, calls } = harness({ sendImpl: async () => { throw new Error("unknown or unmanaged session: payments"); } });
  const result = await deliverDirectTo(deps, source, "payments", "fix the flaky test", "→ @payments  fix the flaky test"); // must not throw

  assert.equal(calls.recorded.length, 1);
  assert.match(calls.recorded[0]!.audit.rawText, /could NOT be delivered to worker "payments" \(unknown or unmanaged session: payments\)/u);
  assert.equal(calls.recorded[0]!.ownerEcho, undefined);
  assert.equal(calls.checkpoints, 1);
  assert.deepEqual(calls.reports, [{ level: "warn", code: "direct_to_failed", adapter: "web" }]);
  assert.deepEqual(result, { delivered: false, error: "unknown or unmanaged session: payments" });
});

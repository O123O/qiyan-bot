import assert from "node:assert/strict";
import test from "node:test";
import { EndpointCapacityRecovery, parseCapacityHint } from "../../src/endpoints/capacity-recovery.ts";

test("returns activation references without restoring capacity from durable state", () => {
  const quarantined: string[] = [];
  const recovery = new EndpointCapacityRecovery({
    registry: { snapshot: () => ({ version: 3, assistant: { endpoint: "assistant", thread_id: "a", project_dir: "/assistant" }, sessions: {
      worker: { endpoint: "devbox", thread_id: "thread-1", project_dir: "/project", mapping_id: "mapping-1", lifecycle_state: "managed" },
    } }) },
    operations: { listRecoverable: () => [{ id: "op-1", kind: "send_to_session", receipt: { capacityHint: { phase: "provisional-start", endpoint: "offline", threadId: "thread-2", mappingId: "mapping-2", clientUserMessageId: "message-2" } } }] },
    quarantine: (operation: { id: string }) => { quarantined.push(operation.id); },
  } as never);
  assert.deepEqual(recovery.restoreBeforeIngress().sort(), ["devbox", "offline"]);
  assert.deepEqual(quarantined, []);
});

test("strictly rejects malformed or extended capacity hints", () => {
  const valid = { phase: "provisional-start", endpoint: "devbox", threadId: "t", mappingId: "m", clientUserMessageId: "c" };
  assert.deepEqual(parseCapacityHint(valid), valid);
  assert.deepEqual(parseCapacityHint({ ...valid, baselineTurnId: null }), { ...valid, baselineTurnId: null });
  assert.equal(parseCapacityHint({ ...valid, unexpected: true }), undefined);
  assert.equal(parseCapacityHint({ ...valid, phase: "active" }), undefined);
});

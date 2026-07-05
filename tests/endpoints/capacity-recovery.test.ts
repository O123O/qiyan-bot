import assert from "node:assert/strict";
import test from "node:test";
import { EndpointCapacityRecovery, parseCapacityHint } from "../../src/endpoints/capacity-recovery.ts";

test("restores active mappings and strict provisional send hints before ingress", () => {
  const active: unknown[] = [];
  const provisional: unknown[] = [];
  const quarantined: string[] = [];
  const recovery = new EndpointCapacityRecovery({
    runtime: { listSessions: () => [{ endpointId: "devbox", threadId: "thread-1", mappingId: "mapping-1", managementState: "managed", nativeStatus: "active", activeTurnId: "turn-1" }] },
    registry: { getByIdentity: () => ({ nickname: "worker", session: { endpoint: "devbox", thread_id: "thread-1", project_dir: "/project", mapping_id: "mapping-1", lifecycle_state: "managed" } }) },
    operations: { listRecoverable: () => [{ id: "op-1", kind: "send_to_session", receipt: { capacityHint: { phase: "provisional-start", endpoint: "offline", threadId: "thread-2", mappingId: "mapping-2", clientUserMessageId: "message-2" } } }] },
    pool: {
      restoreObservedActiveTurn: (...args: unknown[]) => { active.push(args); return {} as never; },
      restoreProvisionalTurnCapacity: (...args: unknown[]) => { provisional.push(args); return {} as never; },
    },
    quarantine: (operation: { id: string }) => { quarantined.push(operation.id); },
  } as never);
  assert.deepEqual(recovery.restoreBeforeIngress().sort(), ["devbox", "offline"]);
  assert.deepEqual(active, [["devbox", "thread-1", "turn-1"]]);
  assert.deepEqual(provisional, [["offline", "thread-2", "recovered:op-1", "message-2"]]);
  assert.deepEqual(quarantined, []);
});

test("strictly rejects malformed or extended capacity hints", () => {
  const valid = { phase: "provisional-start", endpoint: "devbox", threadId: "t", mappingId: "m", clientUserMessageId: "c" };
  assert.deepEqual(parseCapacityHint(valid), valid);
  assert.equal(parseCapacityHint({ ...valid, unexpected: true }), undefined);
  assert.equal(parseCapacityHint({ ...valid, phase: "active" }), undefined);
});

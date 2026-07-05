import assert from "node:assert/strict";
import test from "node:test";
import { EndpointAdmissionGate } from "../../src/endpoints/admission-gate.ts";
import { AppError } from "../../src/core/errors.ts";

test("drain waits for admitted work and rejects new leases", async () => {
  const gate = new EndpointAdmissionGate("devbox");
  const lease = gate.acquire(3);
  const draining = gate.beginDrain();
  assert.throws(() => gate.acquire(3), (error: unknown) => error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE");
  assert.equal(gate.validate(lease, 3), true);
  gate.release(lease);
  const handle = await draining;
  handle.reopen();
  const next = gate.acquire(3);
  assert.notEqual(next.lifecycleGeneration, lease.lifecycleGeneration);
  gate.release(next);
});

test("leases are endpoint-, generation-, and lifetime-bound", async () => {
  const gate = new EndpointAdmissionGate("devbox");
  const lease = gate.acquire(4);
  assert.equal(gate.validate(lease, 4), true);
  assert.equal(gate.validate(lease, 5), false);
  gate.release(lease);
  assert.equal(gate.validate(lease, 4), false);
  const handle = await gate.beginDrain();
  handle.disconnect();
  assert.equal(gate.desiredState, "disconnected");
  assert.throws(() => gate.acquire(4), /disconnected/u);
  gate.requestAutomatic();
  const restored = gate.acquire(5);
  gate.release(restored);
});

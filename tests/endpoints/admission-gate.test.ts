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

// The discard and the close are one step on purpose: doing them as two statements is race-free only
// while they are adjacent, and on the forced paths an SSH round trip used to sit between them. A
// lease taken in that window parked the drain forever, which is the failure the discard removes.
test("a forced drain discards live work in the same step that closes the gate", async () => {
  const gate = new EndpointAdmissionGate("devbox");
  const stuck = gate.acquire(3);

  // Unforced, this lease parks the drain: nothing resolves until it is released.
  let settled = false;
  void gate.beginDrain().then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "the lease really does park an unforced drain");

  // Joining a drain already in progress still discards. Returning the predecessor's handle first
  // is the one way the two could come apart again. Bounded, because that regression hangs rather
  // than asserts, and a hung suite says nothing about the thing being fixed.
  const handle = await Promise.race([
    gate.beginDrain({ discardLive: true }),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("a forced drain parked on the lease it was meant to discard")), 2_000)),
  ]);
  assert.equal(gate.validate(stuck, 3), false, "a discarded lease cannot be used for further work");
  // And its eventual release is a safe no-op rather than a second resolution.
  gate.release(stuck);
  handle.reopen();
  const next = gate.acquire(3);
  gate.release(next);
});

test("a forced drain closes the gate against work taken from under it", async () => {
  const gate = new EndpointAdmissionGate("devbox");
  gate.acquire(3);
  const handle = await gate.beginDrain({ discardLive: true });
  // The gate is closed by the same call, so nothing can take a fresh lease behind the discard.
  assert.throws(() => gate.acquire(3), (error: unknown) => error instanceof AppError && error.code === "ENDPOINT_UNAVAILABLE");
  handle.reopen();
});

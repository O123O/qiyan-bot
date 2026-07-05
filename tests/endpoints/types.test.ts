import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimeIdentity } from "../../src/endpoints/types.ts";

test("validates strict serializable local and SSH runtime identities", () => {
  assert.deepEqual(parseRuntimeIdentity({ kind: "local", pid: 10, startTime: "20" }), { kind: "local", pid: 10, startTime: "20" });
  assert.deepEqual(parseRuntimeIdentity({ kind: "ssh", token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10 }), {
    kind: "ssh", token: "a".repeat(32), pid: 10, linuxStartTime: "20", processGroupId: 10,
  });
  assert.throws(() => parseRuntimeIdentity({ kind: "ssh", token: "secret", pid: 10, linuxStartTime: "20", processGroupId: 10 }));
  assert.throws(() => parseRuntimeIdentity({ kind: "local", pid: 10, startTime: "20", extra: true }));
});

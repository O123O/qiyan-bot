import assert from "node:assert/strict";
import test from "node:test";
import { EndpointBindingStore } from "../../src/endpoints/binding-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { AppError } from "../../src/core/errors.ts";

const one = { hostname: "one.example", user: "xin", port: 22 };
const two = { hostname: "two.example", user: "xin", port: 22 };

test("binding validation is read-only and commit happens only after activation", () => {
  const db = createTestDatabase();
  const store = new EndpointBindingStore(db);
  store.checkExisting("devbox", one, false);
  assert.equal(store.get("devbox"), undefined);
  store.commitAfterActivation("devbox", one, false);
  assert.match(store.get("devbox")!.destinationSha256, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(store.get("devbox")!.destinationSha256, /one\.example/u);
  db.close();
});

test("changed destinations are rejected while identity references exist", () => {
  const db = createTestDatabase();
  const store = new EndpointBindingStore(db);
  store.commitAfterActivation("devbox", one, false);
  assert.throws(
    () => store.checkExisting("devbox", two, true),
    (error: unknown) => error instanceof AppError && error.code === "ENDPOINT_IDENTITY_CHANGED",
  );
  assert.throws(() => store.commitAfterActivation("devbox", two, true), /destination identity changed/u);
  assert.doesNotThrow(() => store.checkExisting("devbox", two, false));
  store.commitAfterActivation("devbox", two, false);
  assert.notEqual(store.get("devbox")!.destinationSha256, new EndpointBindingStore(db).destinationHash(one));
  db.close();
});

test("the endpoint binding migration is installed", () => {
  const db = createTestDatabase();
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'endpoint_bindings'").get();
  assert.equal((row as { name?: string } | undefined)?.name, "endpoint_bindings");
  db.close();
});

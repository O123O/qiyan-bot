import assert from "node:assert/strict";
import test from "node:test";
import { runBackground } from "../../src/core/background.ts";

test("background task rejection is contained and reported", async () => {
  const failure = new Error("authoritative read failed");
  let reported: unknown;
  runBackground(async () => { throw failure; }, (error) => { reported = error; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reported, failure);
});

test("background error reporter rejection is also contained", async () => {
  runBackground(async () => { throw new Error("task"); }, () => { throw new Error("reporter"); });
  await new Promise((resolve) => setImmediate(resolve));
});

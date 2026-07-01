import assert from "node:assert/strict";
import test from "node:test";
import { formatStartupError, parseCliArgs } from "../src/cli.ts";
import { AppError } from "../src/core/errors.ts";

test("parses an explicit coordinator workdir", () => {
  assert.deepEqual(parseCliArgs([]), { command: "run" });
  assert.deepEqual(parseCliArgs(["--workdir", "./manager"]), { command: "run", coordinatorWorkdir: "./manager" });
  assert.deepEqual(parseCliArgs(["coordinator-login"]), { command: "coordinator-login" });
});

test("rejects missing, repeated, and unknown CLI arguments", () => {
  assert.throws(() => parseCliArgs(["--workdir"]), /requires a path/);
  assert.throws(() => parseCliArgs(["--workdir", "one", "--workdir", "two"]), /only once/);
  assert.throws(() => parseCliArgs(["--unknown"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["coordinator-login", "--workdir", "one"]), /unknown argument/);
});

test("does not echo an unknown argument into a startup error", () => {
  let failure: unknown;
  try { parseCliArgs(["--unknown=secret-token"]); } catch (error) { failure = error; }
  assert.equal(formatStartupError(failure), "CONFIGURATION_ERROR: unknown argument");
  assert.doesNotMatch(formatStartupError(failure), /secret-token/);
});

test("formats only known user-facing startup failures", () => {
  assert.equal(formatStartupError(new AppError("CONFIGURATION_ERROR", "managed file changed")), "CONFIGURATION_ERROR: managed file changed");
  assert.equal(formatStartupError(new Error("request contained secret-token")), "startup failed");
});

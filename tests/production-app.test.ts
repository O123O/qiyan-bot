import assert from "node:assert/strict";
import test from "node:test";
import { isUncertainCoordinatorTransportFailure } from "../src/production-app.ts";
import { AppError } from "../src/core/errors.ts";

test("coordinator uncertainty is preserved even while the endpoint still reports ready", () => {
  assert.equal(isUncertainCoordinatorTransportFailure(new AppError("OPERATION_UNCERTAIN", "shutdown"), "ready"), true);
  assert.equal(isUncertainCoordinatorTransportFailure(new Error("ordinary failure"), "ready"), false);
  assert.equal(isUncertainCoordinatorTransportFailure(new Error("transport failed"), "unavailable"), true);
});

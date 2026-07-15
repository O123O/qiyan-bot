import assert from "node:assert/strict";
import test from "node:test";
import { installWebUiSignalHandler, resetWebUiSignalHandlerForTest, setWebUiSignalHandler } from "../../src/webui/webui-signal.ts";

test("install is idempotent; the handler dispatches to the registered callback; cleared ⇒ safe no-op", () => {
  resetWebUiSignalHandlerForTest();
  const before = process.listenerCount("SIGUSR2");
  installWebUiSignalHandler();
  installWebUiSignalHandler(); // idempotent — must not accumulate process listeners
  assert.equal(process.listenerCount("SIGUSR2"), before + 1);

  let calls = 0;
  setWebUiSignalHandler(() => { calls += 1; });
  process.emit("SIGUSR2");
  assert.equal(calls, 1);

  setWebUiSignalHandler(undefined);
  process.emit("SIGUSR2"); // no registered callback ⇒ no-op (never terminates the process)
  assert.equal(calls, 1);

  resetWebUiSignalHandlerForTest();
  assert.equal(process.listenerCount("SIGUSR2"), before, "reset detaches our listener");
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { workerStatus } from "../../webui-client/src/worker-status.ts";

const session = (overrides: Partial<Parameters<typeof workerStatus>[0]> = {}) => ({
  lifecycleState: "managed",
  nativeStatus: "idle" as string | null,
  activeTurnId: null as string | null,
  ...overrides,
});

test("maps live worker state to explicit user-facing status", () => {
  assert.deepEqual(workerStatus(session({ activeTurnId: "turn-1" })), { label: "working", tone: "working" });
  assert.deepEqual(workerStatus(session({ nativeStatus: "active" })), { label: "working", tone: "working" });
  assert.deepEqual(workerStatus(session({ nativeStatus: "idle" })), { label: "idle", tone: "idle" });
  assert.deepEqual(workerStatus(session({ nativeStatus: "notLoaded" })), { label: "idle", tone: "idle" });
  assert.deepEqual(workerStatus(session({ nativeStatus: "systemError" })), { label: "error", tone: "error" });
  assert.deepEqual(workerStatus(session({ nativeStatus: null })), { label: "unavailable", tone: "unavailable" });
  assert.deepEqual(workerStatus(session({ lifecycleState: "unavailable", activeTurnId: "turn-1" })), { label: "unavailable", tone: "unavailable" });
});

test("renders small status text directly below each worker name", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /className="tab-name">\{s\.nickname\}<\/span>\s*<span className="tab-status">\{status\.label\}<\/span>/u);
  assert.match(source, /<span className=\{`dot \$\{status\.tone\}`\}/u);

  const styles = await readFile(new URL("../../webui-client/src/styles.ts", import.meta.url), "utf8");
  assert.match(styles, /\.tab-copy \{[^}]*flex-direction:column/u);
  assert.match(styles, /\.tab-status \{[^}]*font-size:10px/u);

  const shipped = await readFile(new URL("../../assets/webui/index.html", import.meta.url), "utf8");
  assert.match(shipped, /tab-status/u, "the shipped client contains worker status text");
});

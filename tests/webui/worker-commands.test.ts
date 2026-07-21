import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseWorkerCommand, WORKER_COMMAND_SUGGESTIONS, WORKER_GOAL_HELP } from "../../webui-client/src/worker-commands.ts";

test("parses the worker goal command namespace without consuming native slash commands", () => {
  assert.deepEqual(parseWorkerCommand("/goal ship the release"), { kind: "goal", action: "set", objective: "ship the release" });
  assert.deepEqual(parseWorkerCommand(" /goal set pause "), { kind: "goal", action: "set", objective: "pause" });
  assert.deepEqual(parseWorkerCommand("/goal pause"), { kind: "goal", action: "pause" });
  assert.deepEqual(parseWorkerCommand("/goal resume"), { kind: "goal", action: "resume" });
  assert.deepEqual(parseWorkerCommand("/goal cancel"), { kind: "goal", action: "cancel" });
  assert.deepEqual(parseWorkerCommand("/goal"), { kind: "help" });
  assert.deepEqual(parseWorkerCommand("/goal help"), { kind: "help" });
  assert.deepEqual(parseWorkerCommand("/goal set"), { kind: "error", message: "goal objective is required" });
  assert.equal(parseWorkerCommand("/compact"), null);
  assert.equal(parseWorkerCommand("/goalish leave this native"), null);
  assert.match(WORKER_GOAL_HELP, /\/goal <objective>/u);
  assert.match(WORKER_GOAL_HELP, /pause.*resume.*cancel/su);
  assert.ok(WORKER_COMMAND_SUGGESTIONS.every(({ insert }) => insert.startsWith("/goal")));
});

test("worker goal commands are intercepted before ordinary worker input and ship in the built client", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  const parse = source.indexOf("parseWorkerCommand(t)");
  const ordinaryInput = source.indexOf('api<{ ok: boolean; error?: string; clientUserMessageId?: string }>("/api/input"');
  assert.notEqual(parse, -1, "the composer parses worker commands");
  assert.ok(parse < ordinaryInput, "goal controls are handled before ordinary worker input");
  assert.match(source, /\/api\/sessions\/\$\{selected\}\/goal/u);

  const shipped = await readFile(new URL("../../assets/webui/index.html", import.meta.url), "utf8");
  assert.match(shipped, /goal objective is required/u, "the shipped client contains the worker goal parser");
});

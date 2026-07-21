import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ASSISTANT_COMMAND_SUGGESTIONS,
  filterCommandSuggestions,
} from "../../webui-client/src/command-suggestions.ts";
import { WORKER_COMMAND_SUGGESTIONS } from "../../webui-client/src/worker-commands.ts";

test("slash suggestions expose only commands supported by the active panel", () => {
  assert.deepEqual(
    filterCommandSuggestions("/", ASSISTANT_COMMAND_SUGGESTIONS).map(({ label }) => label),
    ["/pass <message>", "/collect [count]", "/to <worker> <message>"],
  );
  assert.deepEqual(
    filterCommandSuggestions("/", WORKER_COMMAND_SUGGESTIONS).map(({ label }) => label),
    ["/goal <objective>", "/goal set <objective>", "/goal pause", "/goal resume", "/goal cancel", "/goal help"],
  );
  assert.equal(filterCommandSuggestions("/goal", ASSISTANT_COMMAND_SUGGESTIONS).length, 0);
  assert.equal(filterCommandSuggestions("/pass", WORKER_COMMAND_SUGGESTIONS).length, 0);
});

test("slash suggestions filter incrementally and stop after free-form arguments", () => {
  assert.deepEqual(
    filterCommandSuggestions("/go", WORKER_COMMAND_SUGGESTIONS).map(({ label }) => label),
    ["/goal <objective>", "/goal set <objective>", "/goal pause", "/goal resume", "/goal cancel", "/goal help"],
  );
  assert.deepEqual(
    filterCommandSuggestions("/goal pa", WORKER_COMMAND_SUGGESTIONS).map(({ label }) => label),
    ["/goal pause"],
  );
  assert.deepEqual(
    filterCommandSuggestions("/co", ASSISTANT_COMMAND_SUGGESTIONS).map(({ label }) => label),
    ["/collect [count]"],
  );
  assert.deepEqual(filterCommandSuggestions("/goal ship release", WORKER_COMMAND_SUGGESTIONS), []);
  assert.deepEqual(filterCommandSuggestions("hello /goal", WORKER_COMMAND_SUGGESTIONS), []);
  assert.deepEqual(filterCommandSuggestions("", WORKER_COMMAND_SUGGESTIONS), []);
});

test("suggestions provide insertion text and the composer ships keyboard and mouse selection", async () => {
  assert.equal(WORKER_COMMAND_SUGGESTIONS[0]?.insert, "/goal ");
  assert.equal(ASSISTANT_COMMAND_SUGGESTIONS[2]?.insert, "/to ");

  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /filterCommandSuggestions/u);
  assert.match(source, /type \/ for commands/iu);
  assert.match(source, /role="listbox"/u);
  assert.match(source, /aria-selected/u);
  assert.match(source, /e\.key === "ArrowDown"/u);
  assert.match(source, /e\.key === "Enter" \|\| e\.key === "Tab"/u);

  const shipped = await readFile(new URL("../../assets/webui/index.html", import.meta.url), "utf8");
  assert.match(shipped, /set or replace the worker goal/iu);
  assert.match(shipped, /send exact text through QiYan/iu);
});

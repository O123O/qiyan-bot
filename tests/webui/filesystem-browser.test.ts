import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { joinFilesystemPath, parentFilesystemPath } from "../../webui-client/src/filesystem-path.ts";

test("filesystem paths stay absolute while navigating the QiYan explorer", () => {
  assert.equal(joinFilesystemPath("/home/user", "notes"), "/home/user/notes");
  assert.equal(joinFilesystemPath("/", "etc"), "/etc");
  assert.equal(parentFilesystemPath("/home/user"), "/home");
  assert.equal(parentFilesystemPath("/"), "/");
});

test("the QiYan tab loads the owner filesystem route and exposes a path field", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /\/api\/filesystem/u);
  assert.match(source, /placeholder="~\/ or absolute path"/u);
  assert.match(source, /Upload file/u);
  assert.match(source, /method: "PUT"/u);
  assert.match(source, /title="Download"/u);
});

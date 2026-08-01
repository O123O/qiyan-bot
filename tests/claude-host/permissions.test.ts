import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { permissionWarning, resolveClaudePermissions } from "../../src/claude-host/permissions.ts";

async function workspace(): Promise<{ cwd: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-perm-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  await mkdir(join(cwd, ".claude"), { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
  return { cwd, home };
}

test("the user's own bypassPermissions is forwarded with the required opt-in", async () => {
  const { cwd, home } = await workspace();
  await writeFile(join(home, ".claude", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));

  const resolved = await resolveClaudePermissions(cwd, { home });
  assert.equal(resolved.permissionMode, "bypassPermissions");
  assert.equal(resolved.allowDangerouslySkipPermissions, true);
  assert.equal(resolved.source, "user");
});

test("a non-bypass mode is forwarded without the opt-in", async () => {
  const { cwd, home } = await workspace();
  await writeFile(join(home, ".claude", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));

  const resolved = await resolveClaudePermissions(cwd, { home });
  assert.equal(resolved.permissionMode, "acceptEdits");
  assert.equal(resolved.allowDangerouslySkipPermissions, undefined,
    "the dangerous opt-in is never attached to a mode that did not ask for it");
});

test("project settings outrank user settings", async () => {
  const { cwd, home } = await workspace();
  await writeFile(join(home, ".claude", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
  await writeFile(join(cwd, ".claude", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "plan" } }));

  const resolved = await resolveClaudePermissions(cwd, { home });
  assert.equal(resolved.permissionMode, "plan");
  assert.equal(resolved.source, "project");
});

test("local settings outrank project settings", async () => {
  const { cwd, home } = await workspace();
  await writeFile(join(cwd, ".claude", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "plan" } }));
  await writeFile(join(cwd, ".claude", "settings.local.json"),
    JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));

  const resolved = await resolveClaudePermissions(cwd, { home });
  assert.equal(resolved.permissionMode, "acceptEdits");
  assert.equal(resolved.source, "local");
});

test("no configuration yields default and an actionable warning", async () => {
  const { cwd, home } = await workspace();
  const resolved = await resolveClaudePermissions(cwd, { home });
  assert.equal(resolved.permissionMode, "default");
  assert.equal(resolved.source, "none");
  assert.match(permissionWarning(resolved) ?? "", /denied/);
});

test("a malformed settings file neither crashes nor escalates", async () => {
  const { cwd, home } = await workspace();
  await writeFile(join(cwd, ".claude", "settings.json"), "{ not json");
  await writeFile(join(home, ".claude", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }));

  const resolved = await resolveClaudePermissions(cwd, { home });
  assert.equal(resolved.permissionMode, "acceptEdits", "falls through to the next layer");
});

test("an unrecognised mode is ignored rather than passed through", async () => {
  const { cwd, home } = await workspace();
  await writeFile(join(cwd, ".claude", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "yolo" } }));

  const resolved = await resolveClaudePermissions(cwd, { home });
  assert.equal(resolved.permissionMode, "default");
  assert.equal(resolved.source, "none");
});

test("a configured mode produces no warning", async () => {
  const { cwd, home } = await workspace();
  await writeFile(join(home, ".claude", "settings.json"),
    JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
  assert.equal(permissionWarning(await resolveClaudePermissions(cwd, { home })), undefined);
});

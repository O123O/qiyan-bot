import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalWorkspaceHost, SshHost } from "../../src/endpoints/ssh-host.ts";
import type { RemoteRuntimeClient } from "../../src/endpoints/ssh-runtime.ts";

test("SSH workspace paths are passed as encoded helper data, not command tokens", async () => {
  const values: unknown[] = [];
  const remote: RemoteRuntimeClient = {
    bootstrap: async () => undefined,
    invoke: async <T>(_operation: string, args: readonly string[]) => {
      values.push(JSON.parse(args[0]!));
      const action = (values.at(-1) as { action: string }).action;
      if (action === "home" || action === "realpath") return { path: "/home/xin/project" } as T;
      if (action === "lstat") return { kind: "directory", device: "1", inode: "2" } as T;
      return { ok: true } as T;
    },
  };
  const host = new SshHost("devbox", remote, "/tmp/qiyan-1000/abcdef0123456789abcdef01/qiyan-ssh-helper.mjs");
  const hostile = "/home/xin/line\n'\"$()` - 你好";
  assert.deepEqual(await host.lstat(hostile), { kind: "directory", device: "1", inode: "2" });
  await host.mkdir(hostile, { recursive: true, mode: 0o700 });
  await host.chmod(hostile, 0o700);
  assert.equal((values[0] as { path: string }).path, hostile);
});

test("SSH workspace structured errors preserve only safe filesystem codes", async () => {
  const responses: unknown[] = [
    { error: { code: "ENOENT" } },
    { error: { code: "private remote detail" } },
  ];
  const remote: RemoteRuntimeClient = {
    bootstrap: async () => undefined,
    invoke: async <T>() => responses.shift() as T,
  };
  const host = new SshHost("devbox", remote, "/tmp/qiyan-1000/abcdef0123456789abcdef01/qiyan-ssh-helper.mjs");

  await assert.rejects(host.realpath("/home/xin/missing"), (error: unknown) => {
    assert.equal(error instanceof Error && "code" in error && error.code === "ENOENT", true);
    assert.doesNotMatch(String(error), /xin|missing/u);
    return true;
  });
  await assert.rejects(host.realpath("/home/xin/private"), /invalid data/u);
});

test("local workspace creation never follows a symlinked parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-safe-mkdir-"));
  const outside = join(root, "outside");
  const project = join(root, "project");
  await Promise.all([mkdir(outside), mkdir(project)]);
  await writeFile(join(outside, "sentinel"), "safe");
  await symlink(outside, join(project, "swapped"), "dir");
  const host = new LocalWorkspaceHost(root);
  await assert.rejects(host.mkdir(join(project, "swapped", "created"), { recursive: true, mode: 0o700 }));
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "safe");
  await assert.rejects(readFile(join(outside, "created")));
});

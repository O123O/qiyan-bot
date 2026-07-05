import assert from "node:assert/strict";
import test from "node:test";
import { SshHost } from "../../src/endpoints/ssh-host.ts";
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

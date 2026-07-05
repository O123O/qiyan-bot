import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import test from "node:test";
import {
  REMOTE_HELPER_SHA256,
  REMOTE_LAUNCHER_SHA256,
  buildInstalledHelperCommand,
  encodeRemoteArgument,
} from "../../src/endpoints/ssh-runtime.ts";
import { runBoundedProcess } from "../../src/endpoints/ssh-process.ts";

const helperPath = new URL("../../assets/remote/qiyan-ssh-helper.mjs", import.meta.url);
const launcherPath = new URL("../../assets/remote/qiyan-app-server-launcher.sh", import.meta.url);

test("packaged remote assets match their pinned digests", async () => {
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest(await readFile(helperPath)), REMOTE_HELPER_SHA256);
  assert.equal(digest(await readFile(launcherPath)), REMOTE_LAUNCHER_SHA256);
});

test("installed helper commands contain only fixed safe tokens and encoded data", () => {
  const hostile = "folder/'\" $() `x`\n你好";
  const command = buildInstalledHelperCommand("/tmp/qiyan-1000/abcdef0123456789abcdef01/qiyan-ssh-helper.mjs", "inspect", [hostile]);
  assert.deepEqual(command.slice(0, 2), ["node", "/tmp/qiyan-1000/abcdef0123456789abcdef01/qiyan-ssh-helper.mjs"]);
  assert.equal(command.join(" ").includes(hostile), false);
  for (const token of command) assert.match(token, /^[A-Za-z0-9_./-]+$/u);
});

test("the helper hard-codes the isolated tmux server and disables user tmux config", async () => {
  const helper = await readFile(helperPath, "utf8");
  assert.match(helper, /"-L", "qiyan-bot", "-f", "\/dev\/null"/u);
  assert.doesNotMatch(helper, /kill-server/u);
  assert.doesNotMatch(helper, /shell:\s*true/u);
});

test("the packaged helper bootstraps owner-only assets and inspects an absent isolated session", async (t) => {
  const uid = process.getuid?.();
  assert.ok(uid);
  const runtimeDir = `/tmp/qiyan-${uid}/${randomBytes(12).toString("hex")}`;
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const helper = await readFile(helperPath);
  const launcher = await readFile(launcherPath);
  const bootstrap = encodeRemoteArgument(JSON.stringify({
    runtimeDir,
    helperBase64: helper.toString("base64url"),
    helperSha256: REMOTE_HELPER_SHA256,
    launcherBase64: launcher.toString("base64url"),
    launcherSha256: REMOTE_LAUNCHER_SHA256,
  }));
  await runBoundedProcess(process.execPath, [helperPath.pathname, "bootstrap", bootstrap], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
  assert.equal((await stat(runtimeDir)).mode & 0o777, 0o700);
  assert.equal((await stat(`${runtimeDir}/qiyan-ssh-helper.mjs`)).mode & 0o777, 0o700);
  assert.equal((await stat(`${runtimeDir}/qiyan-app-server-launcher.sh`)).mode & 0o777, 0o700);
  const inspectArg = encodeRemoteArgument(JSON.stringify({ runtimeDir, session: `qiyan-${runtimeDir.slice(-24)}` }));
  const inspected = await runBoundedProcess(process.execPath, [`${runtimeDir}/qiyan-ssh-helper.mjs`, "inspect", inspectArg], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
  assert.deepEqual(JSON.parse(inspected.stdout.toString("utf8")), { status: "absent" });
});

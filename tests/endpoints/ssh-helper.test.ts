import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  REMOTE_HELPER_SHA256,
  REMOTE_LAUNCHER_SHA256,
  buildInstalledHelperCommand,
  encodeRemoteBootstrapArgument,
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
  const launcher = await readFile(launcherPath, "utf8");
  assert.match(launcher, /QIYAN_RUNTIME_TOKEN/u);
  assert.match(helper, /processHasToken/u);
});

test("the packaged helper bootstraps owner-only assets and inspects an absent isolated session", async (t) => {
  const uid = process.getuid?.();
  assert.ok(uid);
  const runtimeDir = `/tmp/qiyan-${uid}/${randomBytes(12).toString("hex")}`;
  t.after(() => rm(runtimeDir, { recursive: true, force: true }));
  const helper = await readFile(helperPath);
  const launcher = await readFile(launcherPath);
  const bootstrap = encodeRemoteBootstrapArgument(JSON.stringify({
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

  const source = `${runtimeDir}/report.txt`;
  await writeFile(source, "descriptor-safe");
  const rootState = await stat(runtimeDir, { bigint: true });
  const rootIdentity = { rootDevice: rootState.dev.toString(10), rootInode: rootState.ino.toString(10) };
  const readArg = encodeRemoteArgument(JSON.stringify({ path: source, root: runtimeDir, ...rootIdentity, maxBytes: 1024 }));
  const read = await runBoundedProcess(process.execPath, [`${runtimeDir}/qiyan-ssh-helper.mjs`, "read-file", readArg], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
  assert.equal(Buffer.from(JSON.parse(read.stdout.toString("utf8")).dataBase64, "base64").toString(), "descriptor-safe");
  await symlink(source, `${runtimeDir}/report-link.txt`);
  const linkArg = encodeRemoteArgument(JSON.stringify({ path: `${runtimeDir}/report-link.txt`, root: runtimeDir, ...rootIdentity, maxBytes: 1024 }));
  await assert.rejects(
    runBoundedProcess(process.execPath, [`${runtimeDir}/qiyan-ssh-helper.mjs`, "read-file", linkArg], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }),
    /failed/u,
  );
  const rootLink = `${runtimeDir}/root-link`;
  await symlink(runtimeDir, rootLink, "dir");
  const replacedRootArg = encodeRemoteArgument(JSON.stringify({
    path: `${rootLink}/report.txt`, root: rootLink, ...rootIdentity, maxBytes: 1024,
  }));
  await assert.rejects(
    runBoundedProcess(process.execPath, [`${runtimeDir}/qiyan-ssh-helper.mjs`, "read-file", replacedRootArg], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }),
    /failed/u,
  );

  const outside = `${runtimeDir}/outside`;
  const swappedParent = `${runtimeDir}/swapped-parent`;
  await mkdir(outside);
  await symlink(outside, swappedParent, "dir");
  const mkdirArg = encodeRemoteArgument(JSON.stringify({ action: "mkdir", path: `${swappedParent}/escaped`, recursive: true, mode: 0o700 }));
  await assert.rejects(
    runBoundedProcess(process.execPath, [`${runtimeDir}/qiyan-ssh-helper.mjs`, "workspace", mkdirArg], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 }),
    /failed/u,
  );
  await assert.rejects(stat(`${outside}/escaped`));

  const upload = Buffer.from("streamed-upload");
  const uploadSha = createHash("sha256").update(upload).digest("hex");
  const uploadArg = encodeRemoteArgument(JSON.stringify({ runtimeDir, size: upload.byteLength, sha256: uploadSha }));
  const written = await runBoundedProcess(process.execPath, [`${runtimeDir}/qiyan-ssh-helper.mjs`, "write-file", uploadArg], {
    timeoutMs: 5_000, maxOutputBytes: 64 * 1024, input: Readable.from([upload]),
  });
  const uploaded = JSON.parse(written.stdout.toString("utf8")) as { path: string; size: number; sha256: string };
  assert.equal(uploaded.path, `${runtimeDir}/files/${uploadSha}`);
  assert.equal(await readFile(uploaded.path, "utf8"), "streamed-upload");
  assert.equal((await stat(uploaded.path)).mode & 0o777, 0o600);
});

test("published packages include both remote runtime assets", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { files: string[] };
  assert.ok(manifest.files.includes("assets/remote/qiyan-ssh-helper.mjs"));
  assert.ok(manifest.files.includes("assets/remote/qiyan-app-server-launcher.sh"));
});

test("the remote helper scans rollout ownership without returning message bodies", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-remote-rollout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "rollout-thread-remote.jsonl");
  const secret = "remote private message";
  await writeFile(path, "\n");
  const baselineArgument = encodeRemoteArgument(JSON.stringify({ requests: [{ path, threadId: "thread-remote" }] }));
  const baseline = await runBoundedProcess(process.execPath, [helperPath.pathname, "rollout-scan", baselineArgument], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
  const cursor = JSON.parse(baseline.stdout.toString("utf8")).results[0].cursor;
  await appendFile(path, [
    JSON.stringify({ timestamp: "now", type: "event_msg", payload: { type: "task_started", turn_id: "turn-remote" } }),
    JSON.stringify({ timestamp: "now", type: "event_msg", payload: { type: "user_message", message: secret, client_id: "ctx:call" } }),
    "",
  ].join("\n"));
  const argument = encodeRemoteArgument(JSON.stringify({ requests: [{ path, threadId: "thread-remote", cursor }] }));

  const result = await runBoundedProcess(process.execPath, [helperPath.pathname, "rollout-scan", argument], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
  const body = result.stdout.toString("utf8");
  assert.equal(body.includes(secret), false);
  assert.deepEqual(JSON.parse(body).results[0].starts, [{ turnId: "turn-remote", clientId: "ctx:call" }]);
});

test("the remote helper reports a malformed boundary and later independent external evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-remote-rollout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "rollout-thread-remote-malformed.jsonl");
  const secret = "remote body after malformed boundary";
  await writeFile(path, "\n");
  const baselineArgument = encodeRemoteArgument(JSON.stringify({ requests: [{ path, threadId: "thread-remote-malformed" }] }));
  const baseline = await runBoundedProcess(process.execPath, [helperPath.pathname, "rollout-scan", baselineArgument], {
    timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
  });
  const cursor = JSON.parse(baseline.stdout.toString("utf8")).results[0].cursor;
  await appendFile(path, Buffer.from([0x00, 0x00, 0x0a]));
  await appendFile(path, [
    JSON.stringify({ timestamp: "now", type: "event_msg", payload: { type: "task_started", turn_id: "external-remote" } }),
    JSON.stringify({ timestamp: "now", type: "event_msg", payload: { type: "user_message", message: secret, client_id: "ctx:remote" } }),
    "",
  ].join("\n"));
  const argument = encodeRemoteArgument(JSON.stringify({ requests: [{ path, threadId: "thread-remote-malformed", cursor }] }));

  const scanned = await runBoundedProcess(process.execPath, [helperPath.pathname, "rollout-scan", argument], {
    timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
  });
  const stdout = scanned.stdout.toString("utf8");
  const stderr = scanned.stderr.toString("utf8");
  assert.equal(stdout.includes(secret), false);
  assert.equal(stderr.includes(secret), false);
  assert.deepEqual(JSON.parse(stdout).results[0], {
    cursor,
    starts: [{ turnId: "external-remote", clientId: "ctx:remote" }],
    openTurn: { turnId: "external-remote", clientId: "ctx:remote" },
    malformed: true,
  });
});

test("the remote helper does not correlate turn records across a malformed boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-remote-rollout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "rollout-thread-remote-reset.jsonl");
  await writeFile(path, "\n");
  const baselineArgument = encodeRemoteArgument(JSON.stringify({ requests: [{ path, threadId: "thread-remote-reset" }] }));
  const baseline = await runBoundedProcess(process.execPath, [helperPath.pathname, "rollout-scan", baselineArgument], {
    timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
  });
  const cursor = JSON.parse(baseline.stdout.toString("utf8")).results[0].cursor;
  const start = `${JSON.stringify({ timestamp: "now", type: "event_msg", payload: { type: "task_started", turn_id: "not-correlated" } })}\n`;
  await appendFile(path, start);
  const malformedOffset = cursor.offset + Buffer.byteLength(start);
  await appendFile(path, Buffer.from([0x00, 0x0a]));
  await appendFile(path, `${JSON.stringify({ timestamp: "now", type: "event_msg", payload: { type: "user_message" } })}\n`);
  const argument = encodeRemoteArgument(JSON.stringify({ requests: [{ path, threadId: "thread-remote-reset", cursor }] }));

  const scanned = await runBoundedProcess(process.execPath, [helperPath.pathname, "rollout-scan", argument], {
    timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
  });
  assert.deepEqual(JSON.parse(scanned.stdout.toString("utf8")).results[0], {
    cursor: { ...cursor, offset: malformedOffset },
    starts: [],
    malformed: true,
  });
});

test("the remote helper ignores syntactically valid non-object JSON records", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-remote-rollout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "rollout-thread-remote-values.jsonl");
  await writeFile(path, "\n");
  const baselineArgument = encodeRemoteArgument(JSON.stringify({ requests: [{ path, threadId: "thread-remote-values" }] }));
  const baseline = await runBoundedProcess(process.execPath, [helperPath.pathname, "rollout-scan", baselineArgument], {
    timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
  });
  const cursor = JSON.parse(baseline.stdout.toString("utf8")).results[0].cursor;
  await appendFile(path, [
    "null", JSON.stringify("ignored"), "1", "true", "[]", "{}",
    JSON.stringify({ timestamp: "now", type: "event_msg", payload: { type: "task_started", turn_id: "after-values" } }),
    JSON.stringify({ timestamp: "now", type: "event_msg", payload: { type: "user_message" } }),
    "",
  ].join("\n"));
  const argument = encodeRemoteArgument(JSON.stringify({ requests: [{ path, threadId: "thread-remote-values", cursor }] }));

  const scanned = await runBoundedProcess(process.execPath, [helperPath.pathname, "rollout-scan", argument], {
    timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
  });
  const result = JSON.parse(scanned.stdout.toString("utf8")).results[0];
  assert.equal(result.malformed, undefined);
  assert.deepEqual(result.starts, [{ turnId: "after-values" }]);
  assert.deepEqual(result.openTurn, { turnId: "after-values" });
  assert.equal(result.cursor.offset, (await stat(path)).size);
});

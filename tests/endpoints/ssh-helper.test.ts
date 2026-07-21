import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { unlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  REMOTE_HELPER_SHA256,
  REMOTE_LAUNCHER_SHA256,
  REMOTE_APP_SERVER_PROXY_READY,
  SshRemoteClient,
  encodeRemoteBootstrapArgument,
  encodeRemoteArgument,
  parseRemoteHelperResponse,
  validateInstalledHelperPath,
} from "../../src/endpoints/ssh-runtime.ts";
import { openReadyProcessStream, runBoundedProcess } from "../../src/endpoints/ssh-process.ts";

const helperPath = new URL("../../assets/remote/qiyan-ssh-helper.mjs", import.meta.url);
const launcherPath = new URL("../../assets/remote/qiyan-app-server-launcher.sh", import.meta.url);

test("packaged remote assets match their pinned digests", async () => {
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest(await readFile(helperPath)), REMOTE_HELPER_SHA256);
  assert.equal(digest(await readFile(launcherPath)), REMOTE_LAUNCHER_SHA256);
});

test("installed helper locators accept normalized fallback and shared paths", () => {
  assert.doesNotThrow(() => validateInstalledHelperPath("/tmp/qiyan-1000/abcdef0123456789abcdef01/qiyan-ssh-helper.mjs"));
  assert.doesNotThrow(() => validateInstalledHelperPath("/run/user/1000/qiyan-bot/abcdef0123456789abcdef01/qiyan-ssh-helper.mjs"));
  assert.throws(
    () => validateInstalledHelperPath("/run/user/1000/qiyan-bot/../abcdef0123456789abcdef01/qiyan-ssh-helper.mjs"),
    /invalid/u,
  );
});

test("the helper uses explicit shared tmux sockets, retains legacy inspection, and disables user tmux config", async () => {
  const helper = await readFile(helperPath, "utf8");
  assert.match(helper, /"-S", paths\.tmuxSocketPath, "-f", "\/dev\/null"/u);
  assert.match(helper, /tmuxMode === "legacy"/u);
  assert.match(helper, /"-L", "qiyan-bot", "-f", "\/dev\/null"/u);
  assert.doesNotMatch(helper, /kill-server/u);
  assert.doesNotMatch(helper, /shell:\s*true/u);
  assert.match(helper, /command -v codex; command -v tmux; command -v tail/u);
  const launcher = await readFile(launcherPath, "utf8");
  assert.match(launcher, /QIYAN_RUNTIME_TOKEN/u);
  assert.match(helper, /processHasToken/u);
});

test("preflight selects a private XDG runtime and falls back when it is no longer private", async (t) => {
  const uid = process.getuid?.();
  assert.ok(uid);
  const xdg = await mkdtemp(join(tmpdir(), "qiyan-remote-xdg-"));
  t.after(() => rm(xdg, { recursive: true, force: true }));
  await chmod(xdg, 0o700);
  const preflight = async () => {
    const result = await runBoundedProcess("env", [`XDG_RUNTIME_DIR=${xdg}`, process.execPath, helperPath.pathname, "preflight"], {
      timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
    });
    return parseRemoteHelperResponse<{ runtimeBase: string }>(result.stdout, "preflight");
  };

  assert.equal((await preflight()).runtimeBase, `${xdg}/qiyan-bot`);
  await chmod(xdg, 0o755);
  assert.equal((await preflight()).runtimeBase, `/tmp/qiyan-${uid}`);
});

test("every shared runtime operation re-attests its XDG root", async (t) => {
  const xdg = await mkdtemp(join(tmpdir(), "qiyan-remote-attest-"));
  t.after(() => rm(xdg, { recursive: true, force: true }));
  await chmod(xdg, 0o700);
  const runtimeDir = `${xdg}/qiyan-bot/${randomBytes(12).toString("hex")}`;
  const helper = await readFile(helperPath);
  const launcher = await readFile(launcherPath);
  const bootstrap = encodeRemoteBootstrapArgument(JSON.stringify({
    runtimeDir,
    helperBase64: helper.toString("base64url"),
    helperSha256: REMOTE_HELPER_SHA256,
    launcherBase64: launcher.toString("base64url"),
    launcherSha256: REMOTE_LAUNCHER_SHA256,
  }));
  await runBoundedProcess("env", [`XDG_RUNTIME_DIR=${xdg}`, process.execPath, helperPath.pathname, "bootstrap", bootstrap], {
    timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
  });
  await chmod(xdg, 0o755);
  const inspect = encodeRemoteArgument(JSON.stringify({ runtimeDir, session: `qiyan-${runtimeDir.slice(-24)}`, tmuxMode: "explicit" }));
  await assert.rejects(
    runBoundedProcess("env", [`XDG_RUNTIME_DIR=${xdg}`, `${runtimeDir}/qiyan-ssh-helper.mjs`, "inspect", inspect], {
      timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
    }),
    /failed/u,
  );
});

test("an unsafe XDG replacement cannot execute cached helper bytes", async (t) => {
  const xdg = await mkdtemp(join(tmpdir(), "qiyan-trusted-helper-"));
  t.after(() => rm(xdg, { recursive: true, force: true }));
  await chmod(xdg, 0o700);
  const endpointHash = randomBytes(12).toString("hex");
  const runtimeDir = `${xdg}/qiyan-bot/${endpointHash}`;
  const controlPath = join(xdg, "control", "master");
  const helper = await readFile(helperPath);
  const launcher = await readFile(launcherPath);
  const remote = new SshRemoteClient({
    plan: {
      alias: "local-fixture",
      destination: { hostname: "localhost", user: "fixture", port: 22 },
      commonArgs: [],
      controlPath,
      ownsControlMaster: true,
    },
    helperSource: helper,
    run: async (_command, args, options) => {
      const alias = args.lastIndexOf("local-fixture");
      assert.notEqual(alias, -1);
      return runBoundedProcess("env", [
        `XDG_RUNTIME_DIR=${xdg}`,
        "sh", "-c", args.slice(alias + 1).join(" "),
      ], options);
    },
  });
  await remote.bootstrap({ runtimeDir, helper, launcher });
  const upload = Buffer.from("trusted-program-upload");
  const uploadSha = createHash("sha256").update(upload).digest("hex");
  const uploaded = await remote.invokeTransfer<{ path: string }>("write-file", [JSON.stringify({
    runtimeDir, size: upload.byteLength, sha256: uploadSha,
  })], { input: Readable.from([upload]), maxOutputBytes: 64 * 1024 }, join(runtimeDir, "qiyan-ssh-helper.mjs"));
  assert.equal(await readFile(uploaded.path, "utf8"), upload.toString());
  const marker = join(xdg, "cached-helper-executed");
  const installedHelper = join(runtimeDir, "qiyan-ssh-helper.mjs");
  await writeFile(installedHelper, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(marker)}, "executed");`,
    'process.stdout.write(`qiyan-helper-v1:{"status":"absent"}\\n`);',
  ].join("\n"), { mode: 0o700 });
  await chmod(xdg, 0o755);

  await assert.rejects(remote.invoke("inspect", [JSON.stringify({
    runtimeDir, session: `qiyan-${endpointHash}`, tmuxMode: "explicit",
  })], installedHelper), /failed|unsafe|invalid/iu);
  await assert.rejects(stat(marker));
});

test("the fallback rejects an untrusted-writable non-sticky temporary root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-unsafe-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o777);
  const source = await readFile(helperPath, "utf8");
  const rewritten = source.replace('const root = "/tmp";', `const root = ${JSON.stringify(root)};`);
  assert.notEqual(rewritten, source);
  const mockedHelper = join(root, "qiyan-ssh-helper.mjs");
  await writeFile(mockedHelper, rewritten, { mode: 0o700 });

  await assert.rejects(
    runBoundedProcess("env", ["-u", "XDG_RUNTIME_DIR", process.execPath, mockedHelper, "preflight"], {
      timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
    }),
    /failed/u,
  );
});

test("the remote app-server launcher retains one bounded owner-only diagnostic generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-launcher-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "codex"), [
    "#!/bin/sh",
    "printf 'stdout marker\\n'",
    "printf 'stderr marker\\n' >&2",
    "printf 'filter=%s\\n' \"$RUST_LOG\"",
    "printf 'args=%s\\n' \"$*\"",
    "",
  ].join("\n"), { mode: 0o700 });
  const token = "0123456789abcdef0123456789abcdef";
  const socketPath = join(root, "app-server.sock");
  const identityPath = join(root, "identity.json");
  const logPath = join(root, "app-server.log");
  const previousLogPath = join(root, "app-server.previous.log");
  await writeFile(logPath, Buffer.alloc(1024 * 1024 + 1, "x"), { mode: 0o644 });

  const launch = async () => {
    const result = await runBoundedProcess("env", [
      `PATH=${bin}:${process.env.PATH ?? ""}`,
      "sh", launcherPath.pathname, token, socketPath, identityPath,
    ], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
    assert.equal(result.stdout.byteLength, 0);
    assert.equal(result.stderr.byteLength, 0);
  };

  await launch();
  assert.equal((await stat(previousLogPath)).size, 1024 * 1024);
  assert.equal((await stat(previousLogPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(logPath, "utf8")).match(/stdout marker/gu)?.length, 1);

  await launch();
  const log = await readFile(logPath, "utf8");
  const previousLog = await readFile(previousLogPath, "utf8");
  assert.equal(log.match(/stdout marker/gu)?.length, 1);
  assert.equal(log.match(/stderr marker/gu)?.length, 1);
  assert.equal(previousLog.match(/stdout marker/gu)?.length, 1);
  assert.equal(previousLog.match(/stderr marker/gu)?.length, 1);
  assert.match(log, /filter=off,codex_app_server::app_server_tracing=info,codex_app_server::transport=info/u);
  assert.doesNotMatch(log, /codex_app_server_transport/u);
  assert.doesNotMatch(log, /filter=.*(?:^|,)warn(?:,|$)/mu);
  assert.doesNotMatch(log, /filter=.*codex_app_server=info/u);
  assert.match(log, /args=app-server --listen unix:\/\//u);
  assert.equal((await stat(logPath)).mode & 0o777, 0o600);
});

test("the helper emits one versioned response frame", async () => {
  const argument = encodeRemoteArgument(JSON.stringify({ action: "home" }));
  const result = await runBoundedProcess(process.execPath, [helperPath.pathname, "workspace", argument], {
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
  });
  assert.match(result.stdout.toString("utf8"), /^\nqiyan-helper-v1:\{.*\}\n$/u);
});

test("the helper returns a bounded filtered rollout slice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-helper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const threadId = "019f0000-0000-7000-8000-000000000001";
  const path = join(root, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`);
  await writeFile(path, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<subagent_notification>hidden</subagent_notification>" }] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "visible prompt", images: [] } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "hidden" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "visible" }] } }),
    JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "turn-1" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }),
    "",
  ].join("\n"), { mode: 0o600 });
  const argument = encodeRemoteArgument(JSON.stringify({ path, threadId, maxBytes: 8 * 1024 * 1024 }));
  const result = await runBoundedProcess(process.execPath, [helperPath.pathname, "read-rollout-slice", argument], {
    timeoutMs: 5_000, maxOutputBytes: 1024 * 1024,
  });
  const slice = parseRemoteHelperResponse<{ rows: Array<{ line: string }> }>(result.stdout, "read-rollout-slice");
  assert.equal(slice.rows.length, 5);
  assert.equal(slice.rows.some((item) => item.line.includes("hidden")), false);
});

test("the helper establishes a frame boundary after output without a trailing newline", async () => {
  const argument = encodeRemoteArgument(JSON.stringify({ action: "home" }));
  const result = await runBoundedProcess("sh", [
    "-c", "printf remote-shell-banner; exec \"$@\"", "sh", process.execPath, helperPath.pathname, "workspace", argument,
  ], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });

  assert.doesNotThrow(() => parseRemoteHelperResponse(result.stdout, "workspace"));
});

test("the helper proxies App Server bytes without response framing", async (t) => {
  const fixture = await proxyFixture(t);
  const stream = await openReadyProcessStream(process.execPath, [
    helperPath.pathname,
    "proxy-app-server",
    encodeRemoteArgument(JSON.stringify(fixture.request)),
  ], { readyMarker: REMOTE_APP_SERVER_PROXY_READY, timeoutMs: 2_000, maxPreludeBytes: 64 * 1024 });
  const received = once(stream.output, "data");

  stream.input.write("websocket-upgrade-bytes");

  assert.equal(String((await received)[0]), "websocket-upgrade-bytes");
  await stream.close();
});

test("the helper rejects an App Server socket replacement before readiness or byte copying", async (t) => {
  let accepted: Socket | undefined;
  let receivedBytes = 0;
  const replacement = createServer();
  const fixture = await proxyFixture(t, (socket, socketPath) => {
    accepted = socket;
    socket.on("data", (chunk) => { receivedBytes += Buffer.byteLength(chunk); });
    unlinkSync(socketPath);
    replacement.listen(socketPath);
  });
  t.after(async () => {
    accepted?.destroy();
    if (replacement.listening) await closeNetServer(replacement);
  });

  await assert.rejects(
    openReadyProcessStream(process.execPath, [
      helperPath.pathname,
      "proxy-app-server",
      encodeRemoteArgument(JSON.stringify(fixture.request)),
    ], { readyMarker: REMOTE_APP_SERVER_PROXY_READY, timeoutMs: 2_000, maxPreludeBytes: 64 * 1024 }),
    /before readiness|closed before readiness/u,
  );
  assert.equal(receivedBytes, 0);
});

test("helper response parsing fails closed without exposing output", () => {
  const invalid = /SSH inspect helper returned an invalid response/u;
  assert.throws(() => parseRemoteHelperResponse(Buffer.from("remote output only"), "inspect"), invalid);
  assert.throws(() => parseRemoteHelperResponse(Buffer.from('\nqiyan-helper-v1:{"ok":true}\nqiyan-helper-v1:{"ok":true}\n'), "inspect"), invalid);
  assert.throws(() => parseRemoteHelperResponse(Buffer.from("\nqiyan-helper-v1:{secret}\n"), "inspect"), invalid);
  try {
    parseRemoteHelperResponse(Buffer.from("\nqiyan-helper-v1:{secret}\n"), "inspect");
    assert.fail("malformed helper response should fail");
  } catch (error) {
    assert.equal(String(error).includes("secret"), false);
  }
});

async function proxyFixture(
  t: test.TestContext,
  onConnection: (socket: Socket, socketPath: string) => void = (socket) => socket.pipe(socket),
): Promise<{ request: Record<string, unknown> }> {
  const uid = process.getuid?.();
  assert.ok(uid);
  const base = `/tmp/qiyan-${uid}`;
  const runtimeDir = `${base}/${randomBytes(12).toString("hex")}`;
  await mkdir(base, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  await chmod(base, 0o700);
  await mkdir(runtimeDir, { mode: 0o700 });
  const token = randomBytes(16).toString("hex");
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 10000)"], {
    detached: true,
    env: { ...process.env, QIYAN_RUNTIME_TOKEN: token },
    stdio: "ignore",
  });
  assert.ok(holder.pid);
  let processState: { processGroupId: number; linuxStartTime: string } | undefined;
  for (let attempt = 0; attempt < 100 && !processState; attempt += 1) {
    processState = await readLinuxProcessState(holder.pid);
    if (!processState) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(processState);
  const expected = {
    kind: "ssh",
    token,
    pid: holder.pid,
    linuxStartTime: processState.linuxStartTime,
    processGroupId: processState.processGroupId,
  };
  await writeFile(`${runtimeDir}/identity.json`, `${JSON.stringify(expected)}\n`, { mode: 0o600 });
  const socketPath = `${runtimeDir}/app-server.sock`;
  const server = createServer((socket) => onConnection(socket, socketPath));
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  t.after(async () => {
    try { process.kill(-holder.pid!, "SIGKILL"); } catch { /* already stopped */ }
    await once(holder, "exit").catch(() => undefined);
    if (server.listening) await closeNetServer(server);
    await rm(runtimeDir, { recursive: true, force: true });
  });
  return {
    request: {
      runtimeDir,
      session: `qiyan-${runtimeDir.slice(-24)}`,
      tmuxMode: "explicit",
      expected,
    },
  };
}

async function readLinuxProcessState(pid: number): Promise<{ processGroupId: number; linuxStartTime: string } | undefined> {
  let raw: string;
  try { raw = await readFile(`/proc/${pid}/stat`, "utf8"); } catch { return undefined; }
  const close = raw.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = raw.slice(close + 2).trim().split(/\s+/u);
  const processGroupId = Number(fields[2]);
  const linuxStartTime = fields[19];
  return Number.isSafeInteger(processGroupId) && processGroupId > 1 && /^\d+$/u.test(linuxStartTime ?? "")
    ? { processGroupId, linuxStartTime: linuxStartTime! }
    : undefined;
}

async function closeNetServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

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
  const inspectArg = encodeRemoteArgument(JSON.stringify({
    runtimeDir, session: `qiyan-${runtimeDir.slice(-24)}`, tmuxMode: "explicit",
  }));
  const inspected = await runBoundedProcess(process.execPath, [`${runtimeDir}/qiyan-ssh-helper.mjs`, "inspect", inspectArg], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
  assert.deepEqual(parseRemoteHelperResponse(inspected.stdout, "inspect"), { status: "absent" });

  const source = `${runtimeDir}/report.txt`;
  await writeFile(source, "descriptor-safe");
  const rootState = await stat(runtimeDir, { bigint: true });
  const rootIdentity = { rootDevice: rootState.dev.toString(10), rootInode: rootState.ino.toString(10) };
  const readArg = encodeRemoteArgument(JSON.stringify({ path: source, root: runtimeDir, ...rootIdentity, maxBytes: 1024 }));
  const read = await runBoundedProcess(process.execPath, [`${runtimeDir}/qiyan-ssh-helper.mjs`, "read-file", readArg], { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
  assert.equal(Buffer.from(parseRemoteHelperResponse<{ dataBase64: string }>(read.stdout, "read-file").dataBase64, "base64").toString(), "descriptor-safe");
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
  const uploaded = parseRemoteHelperResponse<{ path: string; size: number; sha256: string }>(written.stdout, "write-file");
  assert.equal(uploaded.path, `${runtimeDir}/files/${uploadSha}`);
  assert.equal(await readFile(uploaded.path, "utf8"), "streamed-upload");
  assert.equal((await stat(uploaded.path)).mode & 0o777, 0o600);
});

test("published packages include both remote runtime assets", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { files: string[] };
  assert.ok(manifest.files.includes("assets/remote/qiyan-ssh-helper.mjs"));
  assert.ok(manifest.files.includes("assets/remote/qiyan-app-server-launcher.sh"));
});

test("the remote workspace helper returns a structured missing-path error", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-remote-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = join(root, "missing");
  const argument = encodeRemoteArgument(JSON.stringify({ action: "realpath", path: missing }));

  const result = await runBoundedProcess(process.execPath, [helperPath.pathname, "workspace", argument], {
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
  });

  assert.deepEqual(parseRemoteHelperResponse(result.stdout, "workspace"), { error: { code: "ENOENT" } });
  assert.equal(result.stderr.byteLength, 0);
});

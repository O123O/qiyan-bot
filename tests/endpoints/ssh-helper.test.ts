import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { unlinkSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  REMOTE_HELPER_SHA256,
  REMOTE_LAUNCHER_SHA256,
  REMOTE_CLAUDE_HOST_SHA256,
  REMOTE_CLAUDE_HOST_LAUNCHER_SHA256,
  REMOTE_APP_SERVER_PROXY_READY,
  REMOTE_CLAUDE_HOST_PROXY_READY,
  SshRemoteClient,
  encodeRemoteArgument,
  parseRemoteHelperResponse,
  validateInstalledHelperPath,
} from "../../src/endpoints/ssh-runtime.ts";
import { openReadyProcessStream, runBoundedProcess } from "../../src/endpoints/ssh-process.ts";
import { RemoteClaudeHost } from "../../src/claude-host/transport.ts";

const helperPath = new URL("../../assets/remote/qiyan-ssh-helper.mjs", import.meta.url);
const launcherPath = new URL("../../assets/remote/qiyan-app-server-launcher.sh", import.meta.url);
const claudeHostPath = new URL("../../assets/remote/qiyan-claude-host.mjs", import.meta.url);
const claudeHostLauncherPath = new URL("../../assets/remote/qiyan-claude-host-launcher.sh", import.meta.url);

test("packaged remote assets match their pinned digests", async () => {
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(digest(await readFile(helperPath)), REMOTE_HELPER_SHA256);
  assert.equal(digest(await readFile(launcherPath)), REMOTE_LAUNCHER_SHA256);
  assert.equal(digest(await readFile(claudeHostPath)), REMOTE_CLAUDE_HOST_SHA256);
  assert.equal(digest(await readFile(claudeHostLauncherPath)), REMOTE_CLAUDE_HOST_LAUNCHER_SHA256);
});

// The Claude host asset is generated, so a source change that is not rebuilt would ship a
// stale host — and `npm pack` rebuilds it during packaging, which would then contradict the
// digest pinned in src. Reproduce the build and require the committed bytes to match.
test("the packaged Claude host asset is the current build of its source", async (t) => {
  const target = join(await mkdtemp(join(tmpdir(), "qiyan-claude-host-build-")), "qiyan-claude-host.mjs");
  t.after(() => rm(dirname(target), { recursive: true, force: true }));

  await runBoundedProcess(process.execPath, ["scripts/build.mjs", "--claude-host", target], {
    timeoutMs: 120_000, maxOutputBytes: 1024 * 1024,
  });

  assert.equal(
    (await readFile(target)).equals(await readFile(claudeHostPath)),
    true,
    "run `npm run build` and commit assets/remote/qiyan-claude-host.mjs (and repin REMOTE_CLAUDE_HOST_SHA256)",
  );
});

// A remote Claude turn now runs inside the long-lived host, so the per-turn `claude -p`
// dispatch surface must be gone from what we ship: a leftover op is a second, divergent
// lifecycle a worker could still be driven through.
test("the packaged helper ships no per-turn Claude dispatch surface", async () => {
  const helper = await readFile(helperPath, "utf8");
  for (const removed of [
    "dispatch-claude-turn", "inspect-claude-turn", "watch-claude-turn", "interrupt-claude-turn",
    "configure-claude-thread", "release-claude-thread",
    "start-claude-runtime", "inspect-claude-runtime", "stop-claude-runtime", "watch-claude-runtime",
    "claude-watch.fifo", "qiyan-claude.mjs", "qiyan-claude-runtime-launcher.sh",
  ]) {
    assert.equal(helper.includes(removed), false, `helper still carries ${removed}`);
  }
  const staged = await readdir(new URL("../../assets/remote/", import.meta.url));
  assert.deepEqual(
    staged.filter((entry) => entry.startsWith("qiyan-claude")).sort(),
    ["qiyan-claude-host-launcher.sh", "qiyan-claude-host.mjs"],
  );
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
  const claudeHost = await readFile(claudeHostPath);
  const claudeHostLauncher = await readFile(claudeHostLauncherPath);
  const bootstrap = Buffer.from(JSON.stringify({
    runtimeDir,
    helperBase64: helper.toString("base64url"),
    helperSha256: REMOTE_HELPER_SHA256,
    launcherBase64: launcher.toString("base64url"),
    launcherSha256: REMOTE_LAUNCHER_SHA256,
    claudeHostBase64: claudeHost.toString("base64url"),
    claudeHostSha256: REMOTE_CLAUDE_HOST_SHA256,
    claudeHostLauncherBase64: claudeHostLauncher.toString("base64url"),
    claudeHostLauncherSha256: REMOTE_CLAUDE_HOST_LAUNCHER_SHA256,
  }), "utf8");
  await runBoundedProcess("env", [`XDG_RUNTIME_DIR=${xdg}`, process.execPath, helperPath.pathname, "bootstrap"], {
    input: bootstrap, timeoutMs: 15_000, maxOutputBytes: 64 * 1024,
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
  await remote.bootstrap({
    runtimeDir,
    helper,
    launcher,
    claudeHost: await readFile(claudeHostPath),
    claudeHostLauncher: await readFile(claudeHostLauncherPath),
  });
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

test("the helper reports a permitted never-materialized rollout as empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-rollout-helper-"));
  const threadId = "019f0000-0000-7000-8000-000000000003";
  const path = join(root, `rollout-2026-01-01T00-00-00-${threadId}.jsonl`);
  const argument = encodeRemoteArgument(JSON.stringify({
    path, threadId, maxBytes: 8 * 1024 * 1024, allowMissing: true,
  }));

  const result = await runBoundedProcess(process.execPath, [helperPath.pathname, "read-rollout-slice", argument], {
    timeoutMs: 5_000, maxOutputBytes: 1024 * 1024,
  });
  assert.deepEqual(parseRemoteHelperResponse(result.stdout, "read-rollout-slice"), {
    device: "unmaterialized", inode: threadId, size: 0, start: 0, end: 0, rows: [],
  });
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
  const claudeHost = await readFile(claudeHostPath);
  const claudeHostLauncher = await readFile(claudeHostLauncherPath);
  const bootstrap = Buffer.from(JSON.stringify({
    runtimeDir,
    helperBase64: helper.toString("base64url"),
    helperSha256: REMOTE_HELPER_SHA256,
    launcherBase64: launcher.toString("base64url"),
    launcherSha256: REMOTE_LAUNCHER_SHA256,
    claudeHostBase64: claudeHost.toString("base64url"),
    claudeHostSha256: REMOTE_CLAUDE_HOST_SHA256,
    claudeHostLauncherBase64: claudeHostLauncher.toString("base64url"),
    claudeHostLauncherSha256: REMOTE_CLAUDE_HOST_LAUNCHER_SHA256,
  }), "utf8");
  await runBoundedProcess(process.execPath, [helperPath.pathname, "bootstrap"], {
    input: bootstrap,
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
  });
  assert.equal((await stat(runtimeDir)).mode & 0o777, 0o700);
  assert.equal((await stat(`${runtimeDir}/qiyan-ssh-helper.mjs`)).mode & 0o777, 0o700);
  assert.equal((await stat(`${runtimeDir}/qiyan-app-server-launcher.sh`)).mode & 0o777, 0o700);
  assert.equal((await stat(`${runtimeDir}/qiyan-claude-host.mjs`)).mode & 0o777, 0o700);
  assert.equal((await stat(`${runtimeDir}/qiyan-claude-host-launcher.sh`)).mode & 0o777, 0o700);
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

// The whole remote Claude chain, with only the Claude CLI and the Agent SDK stubbed: the
// helper resolves the SDK and launches the packaged host under tmux, the launcher's identity
// describes the host process itself, and the proxied socket carries a real session whose turn
// completes. Everything between QiYan and the SDK is the production code path.
test("the remote Claude host serves proxied sessions from one supervised process", async (t) => {
  const xdg = await mkdtemp(join(tmpdir(), "qiyan-claude-host-xdg-"));
  const stubRoot = await mkdtemp(join(tmpdir(), "qiyan-claude-host-sdk-"));
  const cwd = await mkdtemp(join(tmpdir(), "qiyan-claude-host-cwd-"));
  t.after(() => Promise.all([
    rm(xdg, { recursive: true, force: true }),
    rm(stubRoot, { recursive: true, force: true }),
    rm(cwd, { recursive: true, force: true }),
  ]));
  await chmod(xdg, 0o700);
  const runtimeDir = `${xdg}/qiyan-bot/${randomBytes(12).toString("hex")}`;
  // The names QiYan derives for one endpoint: the Claude host and the Codex app-server share
  // this runtime directory and its tmux server, so they must not answer to the same session.
  const session = `qiyan-claude-${runtimeDir.slice(-24)}`;
  const codexSession = `qiyan-${runtimeDir.slice(-24)}`;
  const helper = await readFile(helperPath);
  const launcher = await readFile(launcherPath);
  const claudeHost = await readFile(claudeHostPath);
  const claudeHostLauncher = await readFile(claudeHostLauncherPath);
  const bootstrap = Buffer.from(JSON.stringify({
    runtimeDir,
    helperBase64: helper.toString("base64url"),
    helperSha256: REMOTE_HELPER_SHA256,
    launcherBase64: launcher.toString("base64url"),
    launcherSha256: REMOTE_LAUNCHER_SHA256,
    claudeHostBase64: claudeHost.toString("base64url"),
    claudeHostSha256: REMOTE_CLAUDE_HOST_SHA256,
    claudeHostLauncherBase64: claudeHostLauncher.toString("base64url"),
    claudeHostLauncherSha256: REMOTE_CLAUDE_HOST_LAUNCHER_SHA256,
  }), "utf8");
  await runBoundedProcess("env", [`XDG_RUNTIME_DIR=${xdg}`, process.execPath, helperPath.pathname, "bootstrap"], {
    input: bootstrap, timeoutMs: 30_000, maxOutputBytes: 64 * 1024,
  });

  // `npm root -g` must name a directory called node_modules for Node's own resolver to look
  // inside it, which is exactly the shape of a real global prefix.
  const globalRoot = join(stubRoot, "node_modules");
  const sdkDir = join(globalRoot, "@anthropic-ai", "claude-agent-sdk");
  await mkdir(sdkDir, { recursive: true });
  await writeFile(join(sdkDir, "package.json"), JSON.stringify({
    name: "@anthropic-ai/claude-agent-sdk", version: "0.3.220", type: "module", main: "sdk.mjs",
  }));
  await writeFile(join(sdkDir, "sdk.mjs"), [
    'export const VERSION = "9.9.9-stub";',
    "export function query({ prompt, options }) {",
    "  const pending = []; const waiters = []; let ended = false;",
    "  const push = (value) => { const waiter = waiters.shift(); if (waiter) waiter({ value, done: false }); else pending.push(value); };",
    "  void (async () => { for await (const message of prompt) {",
    "    push({ type: 'assistant', uuid: 'assistant-' + message.uuid, message: { content: [{ type: 'text', text: 'echo:' + message.message.content }] } });",
    "    push({ type: 'result', subtype: 'success', user_message_uuid: message.uuid, cwd: options.cwd });",
    "  } })();",
    "  return {",
    "    async interrupt() {}, async setModel() {}, async setPermissionMode() {},",
    "    async applyFlagSettings() {}, async stopTask() {},",
    "    async supportedModels() { return []; }, async initializationResult() { return {}; },",
    "    close() { ended = true; for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true }); },",
    "    [Symbol.asyncIterator]() { return { next: async () => {",
    "      const ready = pending.shift();",
    "      if (ready !== undefined) return { value: ready, done: false };",
    "      if (ended) return { value: undefined, done: true };",
    "      return await new Promise((resolve) => waiters.push(resolve));",
    "    } }; },",
    "  };",
    "}",
  ].join("\n"));

  const wrapperDir = join(xdg, "bin");
  await mkdir(wrapperDir);
  await writeFile(join(wrapperDir, "claude"), "#!/bin/sh\nprintf '2.9.9 (Claude Code)\\n'\n", { mode: 0o700 });
  await writeFile(join(wrapperDir, "npm"), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(globalRoot)}\n`, { mode: 0o700 });
  const capabilityShell = join(wrapperDir, "shell");
  await writeFile(capabilityShell, [
    "#!/bin/sh",
    'if [ "$1" = "-lc" ]; then',
    "  shift",
    '  exec /bin/bash -c "$1"',
    "fi",
    'exec /bin/bash "$@"',
  ].join("\n"), { mode: 0o700 });

  const installed = join(runtimeDir, "qiyan-ssh-helper.mjs");
  const base = { runtimeDir, session, tmuxMode: "explicit" as const };
  const environment = [
    `XDG_RUNTIME_DIR=${xdg}`,
    `PATH=${wrapperDir}:${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  ];
  const invoke = async <T>(operation: string, value: unknown, timeoutMs = 60_000): Promise<T> => {
    try {
      const result = await runBoundedProcess("env", [
        ...environment, process.execPath, installed, operation, encodeRemoteArgument(JSON.stringify(value)),
      ], { timeoutMs, maxOutputBytes: 64 * 1024 });
      return parseRemoteHelperResponse<T>(result.stdout, operation);
    } catch (error) {
      const log = await readFile(join(runtimeDir, "claude-host.log"), "utf8").catch(() => "<no host log>");
      throw new Error(`${operation} failed: ${log}`, { cause: error });
    }
  };

  // Stand in for the endpoint's Codex app-server generation: same runtime directory, same
  // tmux server, the name SshRuntime derives. A Claude host that answered to it would read
  // this live session as its own unhealthy host and refuse to activate for good.
  const tmux = (...args: string[]): Promise<unknown> => runBoundedProcess(
    "tmux", ["-S", join(runtimeDir, "tmux.sock"), "-f", "/dev/null", ...args],
    { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 },
  );
  await tmux("new-session", "-d", "-s", codexSession, "sleep 120");
  t.after(() => tmux("kill-session", "-t", codexSession).catch(() => undefined));
  assert.deepEqual(await invoke("inspect-claude-host", base), { status: "absent" },
    "the co-resident Codex session is not mistaken for a Claude host");

  let identity: { token: string; pid: number } | undefined;
  t.after(async () => {
    if (identity) await invoke("stop-claude-host", { ...base, expected: identity }, 15_000).catch(() => undefined);
    await rm(runtimeDir, { recursive: true, force: true });
  });
  const token = randomBytes(16).toString("hex");
  const started = await invoke<{ identity: any }>("start-claude-host", {
    ...base, shell: capabilityShell, token,
  });
  identity = started.identity;
  // `exec` in the launcher is what makes the recorded identity describe the server itself.
  assert.match(
    (await readFile(`/proc/${started.identity.pid}/cmdline`, "utf8")).replaceAll("\0", " "),
    /qiyan-claude-host\.mjs --socket .*claude\.sock/u,
  );
  assert.equal(
    (await readFile(`/proc/${started.identity.pid}/environ`, "utf8")).split("\0").includes(`QIYAN_RUNTIME_TOKEN=${token}`),
    true,
  );
  const socketState = await stat(join(runtimeDir, "claude.sock"));
  assert.equal(socketState.isSocket(), true);
  assert.equal(socketState.mode & 0o777, 0o600);
  assert.deepEqual(await invoke("inspect-claude-host", base), { status: "healthy", identity: started.identity });

  const stream = await openReadyProcessStream("env", [
    ...environment, process.execPath, installed,
    "proxy-claude-host", encodeRemoteArgument(JSON.stringify({ ...base, expected: started.identity })),
  ], { readyMarker: REMOTE_CLAUDE_HOST_PROXY_READY, timeoutMs: 15_000, maxPreludeBytes: 64 * 1024 });
  const client = new RemoteClaudeHost(async () => ({
    input: stream.input, output: stream.output, close: () => { void stream.close(); },
  }));
  t.after(async () => { await client.shutdown(); await stream.close(); });

  const status = await client.hostStatus();
  assert.equal(status.sdkVersion, "9.9.9-stub", "the host imported the SDK at the resolved path");
  assert.equal(status.claudeVersion, "2.9.9", "the host probed the Claude CLI on the worker's PATH");
  assert.equal(status.runtimeGeneration, token);

  const events: any[] = [];
  client.subscribe((event: unknown) => events.push(event));
  await client.open({ sessionId: "11111111-2222-3333-4444-555555555555", mode: "create", cwd });
  assert.equal(await client.send("11111111-2222-3333-4444-555555555555", "turn-1", "hello host"), true);
  const completed = await waitFor(() => events.find((event) => event.type === "turn/completed"));
  assert.equal(completed.uuid, "turn-1");
  assert.equal(
    events.find((event) => event.type === "content/assistant")?.message.message.content[0].text,
    "echo:hello host",
  );

  await invoke("stop-claude-host", { ...base, expected: started.identity }, 15_000);
  identity = undefined;
  assert.deepEqual(await invoke("inspect-claude-host", base), { status: "absent" });
  await assert.rejects(stat(join(runtimeDir, "claude.sock")));
  // Stopping the Claude host must leave the Codex generation — and the tmux socket serving
  // it — alone; unlinking that socket would strand a live app-server QiYan can no longer
  // reach or stop.
  await tmux("has-session", "-t", codexSession);
  assert.equal((await stat(join(runtimeDir, "tmux.sock"))).isSocket(), true);
});

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for a host event");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("published packages include every remote runtime asset", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { files: string[] };
  assert.ok(manifest.files.includes("assets/remote/qiyan-ssh-helper.mjs"));
  assert.ok(manifest.files.includes("assets/remote/qiyan-app-server-launcher.sh"));
  assert.ok(manifest.files.includes("assets/remote/qiyan-claude-host.mjs"));
  assert.ok(manifest.files.includes("assets/remote/qiyan-claude-host-launcher.sh"));
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

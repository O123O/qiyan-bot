import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, statfsSync, unlinkSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rm, stat, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";

const SAFE_PATH = /^\/[A-Za-z0-9_./+-]+$/u;
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const HEX_128 = /^[a-f0-9]{32}$/u;
const DECIMAL = /^\d+$/u;
const MAX_ARGUMENT_BYTES = 96 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 107;
const NFS_SUPER_MAGIC = 0x6969;
const RESPONSE_PREFIX = "qiyan-helper-v1:";
const APP_SERVER_PROXY_READY = "qiyan-app-server-proxy-v1-ready\n";
const CLAUDE_RUNTIME_WATCH_READY = "qiyan-claude-runtime-watch-v1-ready\n";
const CLAUDE_TURN_WATCH_READY = "qiyan-claude-turn-watch-v1-ready\n";
const MAX_CLAUDE_MARKER_SCAN_BYTES = 128 * 1024 * 1024;
const CLAUDE_MARKER_SCAN_CHUNK_BYTES = 256 * 1024;

const operation = process.argv[2];
const encoded = process.argv.slice(3);

try {
  if (operation === "proxy-app-server") {
    await proxyAppServer(decodeJson(encoded, 1));
  } else if (operation === "watch-claude-runtime") {
    await watchClaudeRuntime(decodeJson(encoded, 1));
  } else if (operation === "watch-claude-turn") {
    await watchClaudeTurn(decodeJson(encoded, 1));
  } else {
    let result;
    switch (operation) {
      case "preflight": result = preflight(); break;
      case "bootstrap": result = await bootstrap(encoded.length === 0 ? await decodeStdinJson(256 * 1024) : decodeJson(encoded, 1)); break;
      case "inspect": result = await inspect(decodeJson(encoded, 1)); break;
      case "start": result = await start(decodeJson(encoded, 1)); break;
      case "stop": result = await stop(decodeJson(encoded, 1)); break;
      case "inspect-claude-runtime": result = await inspectClaudeRuntime(decodeJson(encoded, 1)); break;
      case "start-claude-runtime": result = await startClaudeRuntime(decodeJson(encoded, 1)); break;
      case "stop-claude-runtime": result = await stopClaudeRuntime(decodeJson(encoded, 1)); break;
      case "configure-claude-thread": result = await configureClaudeThread(decodeJson(encoded, 1)); break;
      case "dispatch-claude-turn": result = await dispatchClaudeTurn(decodeJson(encoded, 1)); break;
      case "inspect-claude-turn": result = await inspectClaudeTurn(decodeJson(encoded, 1)); break;
      case "interrupt-claude-turn": result = await interruptClaudeTurn(decodeJson(encoded, 1)); break;
      case "release-claude-thread": result = await releaseClaudeThread(decodeJson(encoded, 1)); break;
      case "read-file": result = await readFileDescriptor(decodeJson(encoded, 1)); break;
      case "read-rollout-slice": result = await readRolloutSlice(decodeJson(encoded, 1)); break;
      case "write-file": result = await writeFileDescriptor(decodeJson(encoded, 1)); break;
      case "workspace": result = await workspace(decodeJson(encoded, 1)); break;
      default: throw new Error("unsupported helper operation");
    }
    process.stdout.write(`\n${RESPONSE_PREFIX}${JSON.stringify(result)}\n`);
  }
} catch {
  process.stderr.write("qiyan remote helper failed\n");
  process.exitCode = 1;
}

function decodeJson(values, count) {
  if (values.length !== count || !/^[A-Za-z0-9_-]+$/u.test(values[0] ?? "")) throw new Error("invalid helper arguments");
  const bytes = Buffer.from(values[0], "base64url");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARGUMENT_BYTES) throw new Error("invalid helper arguments");
  return JSON.parse(bytes.toString("utf8"));
}

async function decodeStdinJson(maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.from(value);
    size += chunk.byteLength;
    if (size < 1 || size > maxBytes) throw new Error("invalid helper input");
    chunks.push(chunk);
  }
  if (size === 0) throw new Error("invalid helper input");
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

function preflight() {
  if (process.platform !== "linux") throw new Error("Linux is required");
  const account = userInfo();
  const uid = process.getuid?.();
  const shell = account.shell || process.env.SHELL;
  if (!Number.isSafeInteger(uid) || uid < 1 || !isAbsolute(account.homedir) || !shell || !SAFE_PATH.test(shell)) throw new Error("invalid account environment");
  if (!SAFE_PATH.test(process.execPath)) throw new Error("invalid Node.js executable");
  // Host-preflight is provider-neutral: it validates only the coreutils every helper op needs
  // (cut/ps/tr/mv/chmod). Codex-specific tooling (codex, tmux, tail) is probed on the Codex `start`
  // path so a Claude-only host still bootstraps.
  const check = spawnSync(shell, ["-lc", "command -v cut; command -v ps; command -v tr; command -v mv; command -v chmod"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  if (check.status !== 0) throw new Error("required remote command is unavailable");
  const paths = check.stdout.split(/\r?\n/u).map((value) => value.trim()).filter((value) => SAFE_PATH.test(value));
  if (paths.slice(-5).length !== 5) throw new Error("required remote command is unavailable");
  return { uid, home: account.homedir, shell, runtimeBase: selectedRuntimeBase() };
}

async function bootstrap(value) {
  const {
    runtimeDir,
    helperBase64,
    helperSha256,
    launcherBase64,
    launcherSha256,
    claudeLauncherBase64,
    claudeLauncherSha256,
    claudeRuntimeLauncherBase64,
    claudeRuntimeLauncherSha256,
  } = value ?? {};
  requireRuntimeDir(runtimeDir, true);
  if (![helperSha256, launcherSha256, claudeLauncherSha256, claudeRuntimeLauncherSha256]
    .every((item) => typeof item === "string" && /^[a-f0-9]{64}$/u.test(item))) throw new Error("invalid asset digest");
  const helper = decodeAsset(helperBase64, helperSha256);
  const launcher = decodeAsset(launcherBase64, launcherSha256);
  const claudeLauncher = decodeAsset(claudeLauncherBase64, claudeLauncherSha256);
  const claudeRuntimeLauncher = decodeAsset(claudeRuntimeLauncherBase64, claudeRuntimeLauncherSha256);
  await ensurePrivateDirectory(dirname(runtimeDir));
  await ensurePrivateDirectory(runtimeDir);
  requireRuntimeDir(runtimeDir);
  await atomicWrite(join(runtimeDir, "qiyan-ssh-helper.mjs"), helper, 0o700);
  await atomicWrite(join(runtimeDir, "qiyan-app-server-launcher.sh"), launcher, 0o700);
  await atomicWrite(join(runtimeDir, "qiyan-claude.mjs"), claudeLauncher, 0o700);
  await atomicWrite(join(runtimeDir, "qiyan-claude-runtime-launcher.sh"), claudeRuntimeLauncher, 0o700);
  return { installed: true };
}

async function inspect(value) {
  const paths = runtimePaths(value, true);
  const tmux = await run("tmux", [...tmuxArgs(paths), "has-session", "-t", paths.session], true);
  const identityFile = await stat(paths.identityPath).catch(() => undefined);
  const socketFile = await stat(paths.socketPath).catch(() => undefined);
  const identity = await readIdentity(paths.identityPath);
  const group = identity ? membersOfGroup(identity.processGroupId) : [];
  const ownedGroup = identity ? group.filter((pid) => processHasToken(pid, identity.token)) : [];
  const groupAlive = group.length > 0;
  if (tmux.code !== 0) {
    if ((identityFile && !identity) || (!identity && socketFile) || groupAlive) return { status: "unhealthy", ...(identity ? { identity, ownedGroup, groupSize: group.length } : {}) };
    return { status: "absent" };
  }
  if (!identity || !identityMatches(identity)) return { status: "unhealthy", ...(identity ? { identity, ownedGroup, groupSize: group.length } : {}) };
  if (!socketFile?.isSocket() || socketFile.uid !== process.getuid?.() || (socketFile.mode & 0o077) !== 0) {
    return { status: "unhealthy", identity, ownedGroup, groupSize: group.length };
  }
  return { status: "healthy", identity };
}

async function start(value) {
  const paths = runtimePaths(value);
  if (!HEX_128.test(value?.token ?? "") || typeof value?.shell !== "string" || !SAFE_PATH.test(value.shell)) throw new Error("invalid start request");
  // Codex capability probe (moved off host-preflight): the app-server launcher execs `codex`
  // inside a `tmux` session and rotates its log with `tail`, so all three must be on the login PATH.
  const capability = spawnSync(value.shell, ["-lc", "command -v codex; command -v tmux; command -v tail"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  const capabilityPaths = (capability.stdout ?? "").split(/\r?\n/u).map((line) => line.trim()).filter((line) => SAFE_PATH.test(line));
  if (capability.status !== 0 || capabilityPaths.slice(-3).length !== 3) throw new Error("codex, tmux, and tail are required to start a remote runtime");
  const before = await inspect(value);
  if (before.status === "healthy") return { identity: before.identity };
  if (before.status === "unhealthy") throw new Error("existing runtime is unhealthy");
  await unlink(paths.socketPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  await unlink(paths.identityPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  const inner = `exec ${paths.launcherPath} ${value.token} ${paths.socketPath} ${paths.identityPath}`;
  if (![paths.launcherPath, paths.socketPath, paths.identityPath].every((item) => SAFE_PATH.test(item))) throw new Error("unsafe launcher path");
  const command = `${value.shell} -lc '${inner}'`;
  await run("tmux", [...tmuxArgs(paths), "new-session", "-d", "-s", paths.session, command]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await inspect(value);
    if (state.status === "healthy") return { identity: state.identity };
    if (state.status === "absent") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("runtime did not become healthy");
}

async function stop(value) {
  const paths = runtimePaths(value);
  const inspected = await inspect(value);
  const identity = await readIdentity(paths.identityPath);
  const expected = validIdentity(value?.expected);
  if (!identity || !expected || !sameIdentity(identity, expected)) throw new Error("runtime identity cannot be proven");
  if (identity) {
    let members = ownedGroupMembers(identity);
    if (members.length > 0) {
      try { process.kill(-identity.processGroupId, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
      await waitForEmptyGroup(identity.processGroupId, 2_000);
      members = ownedGroupMembers(identity);
      if (members.length > 0) {
        try { process.kill(-identity.processGroupId, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
        await waitForEmptyGroup(identity.processGroupId, 2_000);
      }
      if (ownedGroupMembers(identity).length > 0) throw new Error("runtime process group did not stop");
    }
  }
  await run("tmux", [...tmuxArgs(paths), "kill-session", "-t", paths.session], true);
  await rm(paths.socketPath, { force: true });
  await rm(paths.identityPath, { force: true });
  return { stopped: true };
}

async function inspectClaudeRuntime(value) {
  const paths = claudeRuntimePaths(value, true);
  const tmux = await run("tmux", [...tmuxArgs(paths), "has-session", "-t", paths.session], true);
  const identity = await readIdentity(paths.claudeIdentityPath);
  const identityFile = await stat(paths.claudeIdentityPath).catch(() => undefined);
  if (tmux.code !== 0) {
    if ((identityFile && !identity) || (identity && identityMatches(identity))) {
      return { status: "unhealthy", ...(identity ? { identity } : {}) };
    }
    return { status: "absent" };
  }
  if (!identity || !identityMatches(identity) || !processHasToken(identity.pid, identity.token)) {
    return { status: "unhealthy", ...(identity ? { identity } : {}) };
  }
  if (!await claudeWatchFifoIsValid(paths.claudeWatchPath)) return { status: "unhealthy", identity };
  return { status: "healthy", identity };
}

async function startClaudeRuntime(value) {
  const paths = claudeRuntimePaths(value);
  if (paths.tmuxMode !== "explicit" || !HEX_128.test(value?.token ?? "")
    || typeof value?.shell !== "string" || !SAFE_PATH.test(value.shell)) throw new Error("invalid Claude start request");
  const capability = spawnSync(value.shell, ["-lc", "command -v claude; command -v tmux; command -v tail; command -v setsid; command -v mkfifo"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
  });
  const capabilityPaths = (capability.stdout ?? "").split(/\r?\n/u).map((line) => line.trim()).filter((line) => SAFE_PATH.test(line));
  if (capability.status !== 0 || capabilityPaths.slice(-5).length !== 5) {
    throw new Error("claude, tmux, tail, setsid, and mkfifo are required to start a remote Claude runtime");
  }
  const before = await inspectClaudeRuntime(value);
  if (before.status === "healthy") {
    await sweepClaudeBuffers(paths);
    await sweepReleasedClaudePanes(paths, before.identity.token);
    return { identity: before.identity, claudePath: capabilityPaths.at(-5) };
  }
  if (before.status === "unhealthy") {
    const repaired = await repairClaudeAnchor(paths, value.shell, before.identity);
    if (!repaired) throw new Error("existing Claude runtime is unhealthy");
    await sweepClaudeBuffers(paths);
    await sweepReleasedClaudePanes(paths, repaired.token);
    return { identity: repaired, claudePath: capabilityPaths.at(-5) };
  }
  await unlink(paths.claudeIdentityPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  await createClaudeWatchFifo(paths.claudeWatchPath);
  const inner = `exec ${paths.claudeRuntimeLauncherPath} ${value.token} ${paths.claudeIdentityPath} ${paths.claudeWatchPath}`;
  if (![paths.claudeRuntimeLauncherPath, paths.claudeIdentityPath, paths.claudeWatchPath].every((item) => SAFE_PATH.test(item))) {
    throw new Error("unsafe Claude launcher path");
  }
  const command = `env QIYAN_RUNTIME_TOKEN=${value.token} ${value.shell} -lc '${inner}'`;
  await run("tmux", [...tmuxArgs(paths), "new-session", "-d", "-s", paths.session, "-n", "anchor", command]);
  await run("tmux", [...tmuxArgs(paths), "set-environment", "-t", paths.session, "QIYAN_RUNTIME_TOKEN", value.token]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await inspectClaudeRuntime(value);
    if (state.status === "healthy") {
      await sweepClaudeBuffers(paths);
      return { identity: state.identity, claudePath: capabilityPaths.at(-5) };
    }
    if (state.status === "absent") break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Claude runtime did not become healthy");
}

async function repairClaudeAnchor(paths, shell, candidate) {
  const identity = validIdentity(candidate);
  if (!identity || (identityMatches(identity) && processHasToken(identity.pid, identity.token))) return undefined;
  for (let attempt = 0; attempt < 40 && identityMatches(identity); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (identityMatches(identity) || ownedGroupMembers(identity).length > 0) return undefined;
  const tmux = await run("tmux", [...tmuxArgs(paths), "has-session", "-t", paths.session], true);
  if (tmux.code !== 0) return undefined;
  if (!await claudeWatchFifoIsValid(paths.claudeWatchPath)) return undefined;
  const listed = await run("tmux", [
    ...tmuxArgs(paths),
    "list-panes", "-s", "-t", paths.session, "-F",
    "#{pane_id}\t#{@qiyan_thread}\t#{@qiyan_runtime}",
  ]);
  let paneCount = 0;
  for (const line of listed.stdout.toString("utf8").split(/\r?\n/u)) {
    if (!line) continue;
    const [pane, threadId, runtimeToken, extra] = line.split("\t");
    if (extra !== undefined || !/^%[0-9]+$/u.test(pane ?? "")
      || runtimeToken !== identity.token) throw new Error("Claude pane ownership cannot be proven");
    requireClaudeId(threadId);
    await inspectClaudePane(paths, pane, identity.token);
    paneCount += 1;
  }
  if (paneCount === 0) return undefined;
  const inner = `exec ${paths.claudeRuntimeLauncherPath} ${identity.token} ${paths.claudeIdentityPath} ${paths.claudeWatchPath}`;
  if (![paths.claudeRuntimeLauncherPath, paths.claudeIdentityPath, paths.claudeWatchPath].every((item) => SAFE_PATH.test(item))) {
    throw new Error("unsafe Claude launcher path");
  }
  const command = `env QIYAN_RUNTIME_TOKEN=${identity.token} ${shell} -lc '${inner}'`;
  await run("tmux", [...tmuxArgs(paths), "new-window", "-d", "-t", paths.session, "-n", "anchor", command]);
  await run("tmux", [...tmuxArgs(paths), "set-environment", "-t", paths.session, "QIYAN_RUNTIME_TOKEN", identity.token]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await inspectClaudeRuntime({
      runtimeDir: paths.runtimeDir,
      session: paths.session,
      tmuxMode: paths.tmuxMode,
    });
    if (state.status === "healthy" && state.identity.token === identity.token) return state.identity;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Claude runtime anchor repair failed");
}

async function stopClaudeRuntime(value) {
  const paths = claudeRuntimePaths(value);
  const expected = validIdentity(value?.expected);
  const identity = await readIdentity(paths.claudeIdentityPath);
  if (!expected || !identity || !sameIdentity(identity, expected) || !identityMatches(identity)) {
    throw new Error("Claude runtime identity cannot be proven");
  }
  await run("tmux", [...tmuxArgs(paths), "kill-session", "-t", paths.session], true);
  await stopTokenOwnedProcesses(identity.token);
  if (tokenOwnedPids(identity.token).length > 0) throw new Error("Claude runtime processes did not stop");
  await rm(paths.claudeIdentityPath, { force: true });
  await rm(paths.claudeWatchPath, { force: true });
  await rm(paths.tmuxSocketPath, { force: true });
  return { stopped: true };
}

async function watchClaudeRuntime(value) {
  const paths = claudeRuntimePaths(value);
  const expected = validIdentity(value?.expected);
  if (!expected) throw new Error("invalid Claude runtime watch");
  const initial = await inspectClaudeRuntime(value);
  if (initial.status !== "healthy" || !sameIdentity(initial.identity, expected)) throw new Error("Claude runtime changed");
  const watch = await open(paths.claudeWatchPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await watch.stat();
    if (!state.isFIFO() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) {
      throw new Error("invalid Claude runtime watch");
    }
    if (!identityMatches(expected) || !processHasToken(expected.pid, expected.token)) {
      throw new Error("Claude runtime changed");
    }
    process.stdout.write(CLAUDE_RUNTIME_WATCH_READY);
    await watch.read(Buffer.alloc(1), 0, 1, null);
  } finally {
    await watch.close();
  }
}

async function configureClaudeThread(value) {
  const paths = claudeRuntimePaths(value);
  const thread = claudeThreadPaths(paths, value?.threadId);
  const expectedSize = value?.size;
  const expectedSha256 = value?.sha256;
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 2 || expectedSize > 256 * 1024
    || typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error("invalid Claude config request");
  }
  const runtime = await inspectClaudeRuntime(value);
  if (runtime.status !== "healthy") throw new Error("Claude runtime unavailable");
  const bytes = await readStdinBytes(expectedSize);
  if (sha256(bytes) !== expectedSha256) throw new Error("Claude config integrity mismatch");
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("invalid Claude config"); }
  if (parsed?.version !== 1 || parsed.threadId !== thread.threadId) throw new Error("invalid Claude config");
  await ensurePrivateDirectory(paths.claudeThreadsPath);
  await atomicWrite(thread.configPath, bytes, 0o600);
  return { path: thread.configPath };
}

async function dispatchClaudeTurn(value) {
  const paths = claudeRuntimePaths(value);
  const thread = claudeThreadPaths(paths, value?.threadId);
  const turnId = requireClaudeId(value?.turnId);
  const dispatchToken = value?.dispatchToken;
  const expectedSize = value?.size;
  const expectedSha256 = value?.sha256;
  const home = value?.home;
  const shell = value?.shell;
  if (!HEX_128.test(dispatchToken ?? "") || typeof home !== "string" || !SAFE_PATH.test(home) || !isAbsolute(home)
    || typeof shell !== "string" || !SAFE_PATH.test(shell) || !isAbsolute(shell)
    || value?.configPath !== thread.configPath
    || !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > 16 * 1024 * 1024
    || typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error("invalid Claude dispatch request");
  }
  const runtime = await inspectClaudeRuntime(value);
  if (runtime.status !== "healthy") throw new Error("Claude runtime unavailable");
  const prompt = await readStdinBytes(expectedSize);
  if (sha256(prompt) !== expectedSha256) throw new Error("Claude prompt integrity mismatch");
  const transcriptCursor = await createClaudeTranscriptCursor(home, thread.threadId);
  const pane = await ensureClaudePane(paths, thread, shell, runtime.identity.token);
  const before = await inspectClaudePane(paths, pane, runtime.identity.token);
  if (before.status === "running") throw new Error("Claude thread is already active");
  const buffer = `qiyan-${randomUUID().replaceAll("-", "")}`;
  const acknowledgement = `qiyan-${randomUUID().replaceAll("-", "")}`;
  try {
    await runWithInput("tmux", [...tmuxArgs(paths), "load-buffer", "-b", buffer, "-"], prompt);
    const env = [
      `QIYAN_CLAUDE_CONFIG=${shellQuote(thread.configPath)}`,
      `QIYAN_CLAUDE_TMUX_SOCKET=${shellQuote(paths.tmuxSocketPath)}`,
      `QIYAN_CLAUDE_PANE=${shellQuote(pane)}`,
      `QIYAN_CLAUDE_BUFFER=${shellQuote(buffer)}`,
      `QIYAN_CLAUDE_ACK=${shellQuote(acknowledgement)}`,
      `QIYAN_CLAUDE_TURN_ID=${shellQuote(turnId)}`,
      `QIYAN_CLAUDE_THREAD_ID=${shellQuote(thread.threadId)}`,
      `QIYAN_CLAUDE_DISPATCH_TOKEN=${shellQuote(dispatchToken)}`,
      `QIYAN_RUNTIME_TOKEN=${shellQuote(runtime.identity.token)}`,
    ].join(" ");
    const command = `tmux -S ${shellQuote(paths.tmuxSocketPath)} -f /dev/null save-buffer -b ${shellQuote(buffer)} - | env ${env} setsid ${shellQuote(paths.claudeLauncherPath)}`;
    await run("tmux", [...tmuxArgs(paths), "send-keys", "-t", pane, "-l", command]);
    await run("tmux", [...tmuxArgs(paths), "send-keys", "-t", pane, "Enter"]);
    const acknowledged = await waitForTmuxSignal(paths, acknowledgement, 30_000);
    const after = await inspectClaudePane(paths, pane, runtime.identity.token);
    const sameRunning = after.status === "running"
      && after.turnId === turnId
      && after.dispatchToken === dispatchToken;
    if (acknowledged && sameRunning) {
      return { status: "running", paneId: pane, turnId, dispatchToken, identity: after.identity };
    }
    if (await scanClaudeTranscriptBytes(transcriptCursor, home, thread.threadId, `qiyan-cid:${turnId}`)) {
      if (sameRunning) {
        return { status: "running", paneId: pane, turnId, dispatchToken, identity: after.identity };
      }
      if (after.status === "idle") return { status: "settled", paneId: pane, turnId, dispatchToken };
      throw new Error("Claude turn changed after materialization");
    }
    if (sameRunning) {
      await stopOwnedGroup(after.identity);
      await clearClaudeLiveOption(paths, pane);
    }
    throw new Error("Claude turn was not materialized");
  } finally {
    await run("tmux", [...tmuxArgs(paths), "delete-buffer", "-b", buffer], true);
  }
}

async function inspectClaudeTurn(value) {
  const paths = claudeRuntimePaths(value);
  const thread = claudeThreadPaths(paths, value?.threadId);
  const runtime = await inspectClaudeRuntime(value);
  if (runtime.status !== "healthy") return { status: "runtime-unavailable" };
  const pane = await findClaudePane(paths, thread.threadId, runtime.identity.token);
  if (!pane) return { status: "idle" };
  const inspected = await inspectClaudePane(paths, pane, runtime.identity.token);
  return { ...inspected, paneId: pane };
}

async function watchClaudeTurn(value) {
  const paths = claudeRuntimePaths(value);
  claudeThreadPaths(paths, value?.threadId);
  const pane = value?.paneId;
  const expected = validClaudeLive(value?.expected);
  if (typeof pane !== "string" || !/^%[0-9]+$/u.test(pane) || !expected) throw new Error("invalid Claude turn watch");
  const runtime = await inspectClaudeRuntime(value);
  if (runtime.status !== "healthy" || runtime.identity.token !== expected.runtimeToken) throw new Error("Claude runtime changed");
  const initial = await inspectClaudePane(paths, pane, runtime.identity.token);
  if (initial.status !== "running" || !sameClaudeLive(initial, expected)) throw new Error("Claude turn changed");
  process.stdout.write(CLAUDE_TURN_WATCH_READY);
  const identity = {
    kind: "ssh",
    token: expected.runtimeToken,
    pid: expected.pid,
    linuxStartTime: expected.linuxStartTime,
    processGroupId: expected.processGroupId,
  };
  while (identityMatches(identity) && processHasToken(identity.pid, identity.token)) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  await inspectClaudePane(paths, pane, runtime.identity.token);
}

async function interruptClaudeTurn(value) {
  const paths = claudeRuntimePaths(value);
  claudeThreadPaths(paths, value?.threadId);
  const pane = value?.paneId;
  const expected = validClaudeLive(value?.expected);
  if (typeof pane !== "string" || !/^%[0-9]+$/u.test(pane) || !expected) throw new Error("invalid Claude interrupt");
  const runtime = await inspectClaudeRuntime(value);
  if (runtime.status !== "healthy" || runtime.identity.token !== expected.runtimeToken) throw new Error("Claude runtime changed");
  const current = await inspectClaudePane(paths, pane, runtime.identity.token);
  if (current.status !== "running") return { interrupted: true };
  if (!sameClaudeLive(current, expected)) throw new Error("Claude turn identity changed");
  await stopOwnedGroup({
    kind: "ssh",
    token: expected.runtimeToken,
    pid: expected.pid,
    linuxStartTime: expected.linuxStartTime,
    processGroupId: expected.processGroupId,
  });
  await clearClaudeLiveOption(paths, pane);
  return { interrupted: true };
}

async function releaseClaudeThread(value) {
  const paths = claudeRuntimePaths(value);
  const thread = claudeThreadPaths(paths, value?.threadId);
  const runtime = await inspectClaudeRuntime(value);
  if (runtime.status !== "healthy") {
    await rm(thread.configPath, { force: true });
    return { status: "absent" };
  }
  const pane = await findClaudePane(paths, thread.threadId, runtime.identity.token);
  if (!pane) {
    await rm(thread.configPath, { force: true });
    return { status: "released" };
  }
  await run("tmux", [...tmuxArgs(paths), "set-option", "-p", "-t", pane, "@qiyan_release", runtime.identity.token]);
  const inspected = await inspectClaudePane(paths, pane, runtime.identity.token);
  if (inspected.status === "running") return { status: "deferred" };
  await cleanupClaudePane(paths, pane, thread.configPath);
  return { status: "released" };
}

async function proxyAppServer(value) {
  const paths = runtimePaths(value);
  const expected = validIdentity(value?.expected);
  if (!expected) throw new Error("invalid expected runtime identity");
  const beforeIdentity = await readIdentity(paths.identityPath);
  if (!beforeIdentity || !sameIdentity(beforeIdentity, expected) || !identityMatches(beforeIdentity)) {
    throw new Error("runtime identity changed");
  }
  const beforeSocket = await privateSocketIdentity(paths.socketPath);
  const socket = connect(paths.socketPath);
  try {
    await new Promise((resolveConnection, rejectConnection) => {
      const connected = () => { cleanup(); resolveConnection(); };
      const failed = () => { cleanup(); rejectConnection(new Error("app-server socket connection failed")); };
      const cleanup = () => { socket.off("connect", connected); socket.off("error", failed); };
      socket.once("connect", connected);
      socket.once("error", failed);
    });
    const [afterSocket, afterIdentity] = await Promise.all([
      privateSocketIdentity(paths.socketPath),
      readIdentity(paths.identityPath),
    ]);
    if (afterSocket.device !== beforeSocket.device || afterSocket.inode !== beforeSocket.inode
      || !afterIdentity || !sameIdentity(afterIdentity, expected) || !identityMatches(afterIdentity)) {
      throw new Error("runtime changed during connection");
    }
    await new Promise((resolveReady, rejectReady) => {
      process.stdout.write(APP_SERVER_PROXY_READY, (error) => error ? rejectReady(error) : resolveReady());
    });
    await new Promise((resolveProxy, rejectProxy) => {
      const failed = () => rejectProxy(new Error("app-server proxy failed"));
      process.stdin.once("error", failed);
      process.stdout.once("error", failed);
      socket.once("error", failed);
      socket.once("close", resolveProxy);
      process.stdin.pipe(socket);
      socket.pipe(process.stdout, { end: false });
    });
  } finally { socket.destroy(); }
}

async function privateSocketIdentity(path) {
  const state = await lstat(path, { bigint: true });
  const uid = process.getuid?.();
  if (!state.isSocket() || state.isSymbolicLink() || (state.mode & 0o077n) !== 0n
    || (uid !== undefined && state.uid !== BigInt(uid))) throw new Error("invalid app-server socket");
  return { device: state.dev.toString(10), inode: state.ino.toString(10) };
}

async function readFileDescriptor(value) {
  const path = value?.path;
  const root = value?.root;
  const rootDevice = value?.rootDevice;
  const rootInode = value?.rootInode;
  const maxBytes = value?.maxBytes;
  if (typeof path !== "string" || !isAbsolute(path) || typeof root !== "string" || !isAbsolute(root)
    || !DECIMAL.test(rootDevice ?? "") || !DECIMAL.test(rootInode ?? "")
    || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024) throw new Error("invalid read request");
  const projected = relative(root, path);
  if (projected === "" || projected === ".." || projected.startsWith("../") || isAbsolute(projected)) throw new Error("invalid read request");
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const rootBefore = await rootHandle.stat({ bigint: true });
    const canonicalRoot = await realpath(`/proc/self/fd/${rootHandle.fd}`);
    if (!rootBefore.isDirectory() || rootBefore.dev.toString(10) !== rootDevice || rootBefore.ino.toString(10) !== rootInode || canonicalRoot !== root) {
      throw new Error("project root changed");
    }
    const file = await open(`/proc/self/fd/${rootHandle.fd}/${projected}`, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error("invalid source file");
      const actual = await realpath(`/proc/self/fd/${file.fd}`);
      if (!pathWithin(canonicalRoot, actual)) throw new Error("source file escapes project root");
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await file.read(bytes, offset, bytes.byteLength - offset, offset);
        if (result.bytesRead === 0) throw new Error("source file changed");
        offset += result.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      const rootAfter = await rootHandle.stat({ bigint: true });
      const rootAfterPath = await realpath(`/proc/self/fd/${rootHandle.fd}`);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || rootAfter.dev !== rootBefore.dev || rootAfter.ino !== rootBefore.ino || rootAfterPath !== canonicalRoot) throw new Error("source file changed");
      return {
        device: before.dev.toString(10), inode: before.ino.toString(10), size: Number(before.size), mtimeNs: before.mtimeNs.toString(10),
        sha256: sha256(bytes), dataBase64: bytes.toString("base64"),
      };
    } finally { await file.close(); }
  } finally { await rootHandle.close(); }
}

async function readRolloutSlice(value) {
  const path = value?.path;
  const threadId = value?.threadId;
  const before = value?.before;
  const maxBytes = value?.maxBytes;
  const allowMissing = value?.allowMissing;
  if (typeof path !== "string" || !isAbsolute(path) || !SAFE_PATH.test(path)
    || typeof threadId !== "string" || !/^[A-Za-z0-9-]{1,128}$/u.test(threadId)
    || !basename(path).startsWith("rollout-") || !basename(path).endsWith(`-${threadId}.jsonl`)
    || (before !== undefined && (!Number.isSafeInteger(before) || before < 0))
    || (allowMissing !== undefined && typeof allowMissing !== "boolean")
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024) throw new Error("invalid rollout read request");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
    if (allowMissing === true && error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!file) return { device: "unmaterialized", inode: threadId, size: 0, start: 0, end: 0, rows: [] };
  try {
    const state = await file.stat({ bigint: true });
    const uid = process.getuid?.();
    if (!state.isFile() || state.size > BigInt(Number.MAX_SAFE_INTEGER)
      || (uid !== undefined && state.uid !== BigInt(uid))) throw new Error("invalid rollout file");
    const size = Number(state.size);
    const end = before === undefined ? size : before;
    if (end > size) throw new Error("invalid rollout offset");
    const start = Math.max(0, end - maxBytes);
    const bytes = Buffer.alloc(end - start);
    let filled = 0;
    while (filled < bytes.length) {
      const result = await file.read(bytes, filled, bytes.length - filled, start + filled);
      if (result.bytesRead === 0) throw new Error("rollout file changed");
      filled += result.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (after.dev !== state.dev || after.ino !== state.ino || after.size < BigInt(end)) throw new Error("rollout file changed");
    return {
      device: state.dev.toString(10), inode: state.ino.toString(10), size, start, end,
      rows: filteredRolloutLines(bytes, start, start === 0, end === size),
    };
  } finally { await file.close(); }
}

function filteredRolloutLines(bytes, absoluteStart, completeStart, completeEnd) {
  const rows = [];
  let start = completeStart ? 0 : bytes.indexOf(0x0a) + 1;
  if (start <= 0 && !completeStart) return rows;
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline >= 0 ? newline : completeEnd ? bytes.length : -1;
    if (end < 0) break;
    if (end > start) {
      const line = bytes.toString("utf8", start, end);
      const relevant = (line.includes('"type":"response_item"') && line.includes('"type":"message"') && line.includes('"role":"assistant"'))
        || (line.includes('"type":"event_msg"')
          && (line.includes('"type":"user_message"') || line.includes('"type":"task_started"') || line.includes('"type":"task_complete"')
            || line.includes('"type":"turn_aborted"') || line.includes('"type":"thread_rolled_back"')));
      if (relevant) rows.push({ offset: absoluteStart + start, line });
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return rows;
}

async function writeFileDescriptor(value) {
  const runtimeDir = value?.runtimeDir;
  const expectedSize = value?.size;
  const expectedSha256 = value?.sha256;
  requireRuntimeDir(runtimeDir);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > 64 * 1024 * 1024
    || typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error("invalid write request");
  const filesDir = join(runtimeDir, "files");
  await ensurePrivateDirectory(filesDir);
  const target = join(filesDir, expectedSha256);
  const existing = await verifyStoredFile(target, expectedSize, expectedSha256);
  if (existing) return { path: target, size: expectedSize, sha256: expectedSha256 };
  const temporary = `${target}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const value of process.stdin) {
      const chunk = Buffer.from(value);
      size += chunk.byteLength;
      if (size > expectedSize) throw new Error("uploaded file exceeds declared size");
      hash.update(chunk);
      await file.write(chunk);
    }
    if (size !== expectedSize || hash.digest("hex") !== expectedSha256) throw new Error("uploaded file integrity mismatch");
    await file.sync();
    await file.close();
    renameSync(temporary, target);
    return { path: target, size, sha256: expectedSha256 };
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

async function verifyStoredFile(path, expectedSize, expectedSha256) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  try {
    const state = await file.stat();
    if (!state.isFile() || state.size !== expectedSize || (state.mode & 0o077) !== 0 || state.uid !== process.getuid?.()) throw new Error("invalid staged file");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    if (hash.digest("hex") !== expectedSha256) throw new Error("invalid staged file");
    return true;
  } finally { await file.close(); }
}

function pathWithin(root, candidate) {
  const projected = relative(root, candidate);
  return projected === "" || (!projected.startsWith("..") && !isAbsolute(projected));
}

async function workspace(value) {
  try { return await workspaceOperation(value); }
  catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EEXIST") return { error: { code: error.code } };
    throw error;
  }
}

async function workspaceOperation(value) {
  const action = value?.action;
  const path = value?.path;
  if (action === "home") return { path: userInfo().homedir };
  if (typeof path !== "string" || !isAbsolute(path) || Buffer.byteLength(path) > 16 * 1024) throw new Error("invalid workspace path");
  if (action === "lstat") {
    let state;
    try { state = await import("node:fs/promises").then(({ lstat }) => lstat(path, { bigint: true })); }
    catch (error) { if (error?.code === "ENOENT") return { kind: "missing" }; throw error; }
    const kind = state.isSymbolicLink() ? "symlink" : state.isDirectory() ? "directory" : state.isFile() ? "file" : "other";
    return { kind, device: state.dev.toString(10), inode: state.ino.toString(10) };
  }
  if (action === "realpath") return { path: await import("node:fs/promises").then(({ realpath }) => realpath(path)) };
  if (action === "mkdir") {
    if (typeof value.recursive !== "boolean" || value.mode !== 0o700) throw new Error("invalid mkdir request");
    await mkdirAbsoluteNoFollow(path, { recursive: value.recursive, mode: value.mode }); return { ok: true };
  }
  if (action === "chmod") {
    if (value.mode !== 0o700) throw new Error("invalid chmod request");
    await chmod(path, value.mode); return { ok: true };
  }
  throw new Error("invalid workspace operation");
}

async function mkdirAbsoluteNoFollow(path, options) {
  if (!isAbsolute(path) || resolve(path) !== path || options.mode !== 0o700) throw new Error("invalid workspace mkdir request");
  const components = path.split("/").filter(Boolean);
  let parent = await open("/", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (components.length === 0 && !options.recursive) throw Object.assign(new Error("workspace exists"), { code: "EEXIST" });
    for (let index = 0; index < components.length; index += 1) {
      const childPath = `/proc/self/fd/${parent.fd}/${components[index]}`;
      const last = index === components.length - 1;
      let exists = true;
      try { await lstat(childPath); } catch (error) { if (error?.code === "ENOENT") exists = false; else throw error; }
      if (exists && last && !options.recursive) throw Object.assign(new Error("workspace exists"), { code: "EEXIST" });
      if (!exists) {
        if (!options.recursive && !last) throw Object.assign(new Error("workspace parent is missing"), { code: "ENOENT" });
        await mkdir(childPath, { mode: options.mode });
      }
      const child = await open(childPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await parent.close();
      parent = child;
    }
  } finally { await parent.close().catch(() => undefined); }
}

function runtimePaths(value, allowMissing = false) {
  const runtimeDir = value?.runtimeDir;
  const session = value?.session;
  const tmuxMode = value?.tmuxMode;
  requireRuntimeDir(runtimeDir, allowMissing);
  if (typeof session !== "string" || !SAFE_NAME.test(session)) throw new Error("invalid tmux session");
  if (tmuxMode !== "explicit" && tmuxMode !== "legacy") throw new Error("invalid tmux mode");
  return {
    runtimeDir,
    session,
    tmuxMode,
    tmuxSocketPath: join(runtimeDir, "tmux.sock"),
    socketPath: join(runtimeDir, "app-server.sock"),
    identityPath: join(runtimeDir, "identity.json"),
    launcherPath: join(runtimeDir, "qiyan-app-server-launcher.sh"),
  };
}

function claudeRuntimePaths(value, allowMissing = false) {
  const paths = runtimePaths(value, allowMissing);
  if (paths.tmuxMode !== "explicit") throw new Error("Claude requires an explicit tmux socket");
  return {
    ...paths,
    claudeIdentityPath: join(paths.runtimeDir, "claude-identity.json"),
    claudeWatchPath: join(paths.runtimeDir, "claude-watch.fifo"),
    claudeRuntimeLauncherPath: join(paths.runtimeDir, "qiyan-claude-runtime-launcher.sh"),
    claudeLauncherPath: join(paths.runtimeDir, "qiyan-claude.mjs"),
    claudeThreadsPath: join(paths.runtimeDir, "claude-threads"),
  };
}

async function claudeWatchFifoIsValid(path) {
  let state;
  try { state = await lstat(path); } catch { return false; }
  return state.isFIFO() && !state.isSymbolicLink() && state.uid === process.getuid?.()
    && (state.mode & 0o077) === 0;
}

async function createClaudeWatchFifo(path) {
  await rm(path, { force: true });
  await run("mkfifo", ["-m", "600", path]);
  if (!await claudeWatchFifoIsValid(path)) throw new Error("invalid Claude runtime watch");
}

function claudeThreadPaths(paths, value) {
  const threadId = requireClaudeId(value);
  return {
    threadId,
    configPath: join(paths.claudeThreadsPath, `${sha256(Buffer.from(threadId, "utf8"))}.json`),
    windowName: `c-${sha256(Buffer.from(threadId, "utf8")).slice(0, 16)}`,
  };
}

function requireClaudeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9:_.-]{1,256}$/u.test(value)) throw new Error("invalid Claude identifier");
  return value;
}

async function ensureClaudePane(paths, thread, shell, runtimeToken) {
  const existing = await findClaudePane(paths, thread.threadId, runtimeToken);
  if (existing) return existing;
  const created = await run("tmux", [
    ...tmuxArgs(paths),
    "new-window", "-d", "-P", "-F", "#{pane_id}",
    "-t", paths.session, "-n", thread.windowName, `${shell} -l`,
  ]);
  const pane = created.stdout.toString("utf8").trim();
  if (!/^%[0-9]+$/u.test(pane)) throw new Error("invalid Claude pane");
  await run("tmux", [...tmuxArgs(paths), "set-option", "-p", "-t", pane, "@qiyan_thread", thread.threadId]);
  await run("tmux", [...tmuxArgs(paths), "set-option", "-p", "-t", pane, "@qiyan_runtime", runtimeToken]);
  return pane;
}

async function findClaudePane(paths, threadId, runtimeToken) {
  const listed = await run("tmux", [
    ...tmuxArgs(paths),
    "list-panes", "-a", "-F",
    "#{session_name}\t#{pane_id}\t#{@qiyan_thread}\t#{@qiyan_runtime}",
  ], true);
  if (listed.code !== 0) return undefined;
  let found;
  for (const line of listed.stdout.toString("utf8").split(/\r?\n/u)) {
    const [session, pane, foundThread, foundRuntime, extra] = line.split("\t");
    if (extra !== undefined || session !== paths.session || foundThread !== threadId) continue;
    if (!/^%[0-9]+$/u.test(pane ?? "") || foundRuntime !== runtimeToken || found !== undefined) {
      throw new Error("Claude pane ownership cannot be proven");
    }
    found = pane;
  }
  return found;
}

async function inspectClaudePane(paths, pane, runtimeToken) {
  const owner = await run("tmux", [...tmuxArgs(paths), "show-options", "-pqv", "-t", pane, "@qiyan_runtime"], true);
  if (owner.code !== 0 || owner.stdout.toString("utf8").trim() !== runtimeToken) {
    throw new Error("Claude pane ownership cannot be proven");
  }
  const option = await run("tmux", [...tmuxArgs(paths), "show-options", "-pqv", "-t", pane, "@qiyan_live"], true);
  const encoded = option.stdout.toString("utf8").trim();
  if (!encoded) return { status: "idle" };
  let value;
  try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw new Error("invalid Claude live marker"); }
  const live = validClaudeLive(value);
  if (!live || live.runtimeToken !== runtimeToken) throw new Error("invalid Claude live marker");
  if (!identityMatches({
    kind: "ssh",
    token: live.runtimeToken,
    pid: live.pid,
    linuxStartTime: live.linuxStartTime,
    processGroupId: live.processGroupId,
  }) || !processHasToken(live.pid, live.runtimeToken)) {
    await clearClaudeLiveOption(paths, pane);
    const release = await run("tmux", [...tmuxArgs(paths), "show-options", "-pqv", "-t", pane, "@qiyan_release"], true);
    if (release.stdout.toString("utf8").trim() === runtimeToken) {
      const threadOption = await run("tmux", [...tmuxArgs(paths), "show-options", "-pqv", "-t", pane, "@qiyan_thread"], true);
      const threadId = threadOption.stdout.toString("utf8").trim();
      const thread = claudeThreadPaths(paths, threadId);
      await cleanupClaudePane(paths, pane, thread.configPath);
    }
    return { status: "idle" };
  }
  ownedGroupMembers({
    kind: "ssh",
    token: live.runtimeToken,
    pid: live.pid,
    linuxStartTime: live.linuxStartTime,
    processGroupId: live.processGroupId,
  });
  return {
    status: "running",
    turnId: live.turnId,
    dispatchToken: live.dispatchToken,
    identity: {
      kind: "ssh",
      token: live.runtimeToken,
      pid: live.pid,
      linuxStartTime: live.linuxStartTime,
      processGroupId: live.processGroupId,
    },
  };
}

function validClaudeLive(value) {
  if (!value || typeof value !== "object" || !HEX_128.test(value.runtimeToken ?? "")
    || !HEX_128.test(value.dispatchToken ?? "") || !/^[A-Za-z0-9:_.-]{1,256}$/u.test(value.turnId ?? "")
    || !Number.isSafeInteger(value.pid) || value.pid < 2 || !DECIMAL.test(value.linuxStartTime ?? "")
    || !Number.isSafeInteger(value.processGroupId) || value.processGroupId < 2) return undefined;
  return value;
}

function sameClaudeLive(actual, expected) {
  return actual.status === "running"
    && actual.turnId === expected.turnId
    && actual.dispatchToken === expected.dispatchToken
    && actual.identity.token === expected.runtimeToken
    && actual.identity.pid === expected.pid
    && actual.identity.linuxStartTime === expected.linuxStartTime
    && actual.identity.processGroupId === expected.processGroupId;
}

async function clearClaudeLiveOption(paths, pane) {
  await run("tmux", [...tmuxArgs(paths), "set-option", "-pu", "-t", pane, "@qiyan_live"], true);
}

async function cleanupClaudePane(paths, pane, configPath) {
  await rm(configPath, { force: true });
  await run("tmux", [...tmuxArgs(paths), "kill-pane", "-t", pane], true);
}

async function sweepClaudeBuffers(paths) {
  const listed = await run("tmux", [...tmuxArgs(paths), "list-buffers", "-F", "#{buffer_name}"], true);
  if (listed.code !== 0) return;
  for (const name of listed.stdout.toString("utf8").split(/\r?\n/u)) {
    if (/^qiyan-[A-Za-z0-9_.-]+$/u.test(name)) {
      await run("tmux", [...tmuxArgs(paths), "delete-buffer", "-b", name], true);
    }
  }
}

async function sweepReleasedClaudePanes(paths, runtimeToken) {
  const listed = await run("tmux", [
    ...tmuxArgs(paths),
    "list-panes", "-a", "-F",
    "#{session_name}\t#{pane_id}\t#{@qiyan_thread}\t#{@qiyan_runtime}\t#{@qiyan_release}",
  ], true);
  if (listed.code !== 0) return;
  for (const line of listed.stdout.toString("utf8").split(/\r?\n/u)) {
    const [session, pane, threadId, owner, release, extra] = line.split("\t");
    if (extra !== undefined || session !== paths.session || !/^%[0-9]+$/u.test(pane ?? "")
      || owner !== runtimeToken || release !== runtimeToken) continue;
    const inspected = await inspectClaudePane(paths, pane, runtimeToken);
    if (inspected.status === "idle") {
      const thread = claudeThreadPaths(paths, threadId);
      await cleanupClaudePane(paths, pane, thread.configPath);
    }
  }
}

async function stopOwnedGroup(identity) {
  let members = ownedGroupMembers(identity);
  if (members.length === 0) return;
  try { process.kill(-identity.processGroupId, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  await waitForEmptyGroup(identity.processGroupId, 2_000);
  members = ownedGroupMembers(identity);
  if (members.length > 0) {
    try { process.kill(-identity.processGroupId, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    await waitForEmptyGroup(identity.processGroupId, 2_000);
  }
  if (ownedGroupMembers(identity).length > 0) throw new Error("Claude process group did not stop");
}

function tokenOwnedPids(token) {
  return readdirSync("/proc")
    .filter((name) => DECIMAL.test(name))
    .map(Number)
    .filter((pid) => processHasToken(pid, token));
}

async function stopTokenOwnedProcesses(token) {
  const groups = new Set(tokenOwnedPids(token).map((pid) => processState(pid)?.processGroupId).filter(Boolean));
  for (const processGroupId of groups) {
    const members = membersOfGroup(processGroupId);
    if (members.some((pid) => !processHasToken(pid, token))) throw new Error("Claude runtime process ownership cannot be proven");
    try { process.kill(-processGroupId, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
  const deadline = Date.now() + 2_000;
  while (tokenOwnedPids(token).length > 0 && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  for (const processGroupId of new Set(tokenOwnedPids(token).map((pid) => processState(pid)?.processGroupId).filter(Boolean))) {
    try { process.kill(-processGroupId, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
  const hardDeadline = Date.now() + 2_000;
  while (tokenOwnedPids(token).length > 0 && Date.now() < hardDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
}

async function readStdinBytes(expectedSize) {
  const chunks = [];
  let size = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.from(value);
    size += chunk.byteLength;
    if (size > expectedSize) throw new Error("helper input exceeds declared size");
    chunks.push(chunk);
  }
  if (size !== expectedSize) throw new Error("helper input size mismatch");
  return Buffer.concat(chunks, size);
}

async function waitForTmuxSignal(paths, name, timeoutMs) {
  return new Promise((resolveWait) => {
    const child = spawn("tmux", [...tmuxArgs(paths), "wait-for", name], { shell: false, stdio: "ignore" });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveWait(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(false);
    }, timeoutMs);
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

async function createClaudeTranscriptCursor(home, threadId) {
  const found = await findClaudeTranscript(home, threadId);
  return found
    ? { ...found, offset: found.size, scanned: 0, carry: Buffer.alloc(0) }
    : { offset: 0, scanned: 0, carry: Buffer.alloc(0) };
}

async function findClaudeTranscript(home, threadId) {
  const root = join(home, ".claude", "projects");
  const fileName = `${threadId}.jsonl`;
  let directories;
  try { directories = await readdir(root); } catch { return undefined; }
  for (const directory of directories) {
    const path = join(root, directory, fileName);
    let file;
    try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { continue; }
    try {
      const state = await file.stat();
      if (!state.isFile() || state.uid !== process.getuid?.()) continue;
      return {
        path,
        device: String(state.dev),
        inode: String(state.ino),
        size: Number(state.size),
      };
    } finally { await file.close(); }
  }
  return undefined;
}

async function scanClaudeTranscriptBytes(cursor, home, threadId, markerText) {
  if (!cursor.path) {
    const found = await findClaudeTranscript(home, threadId);
    if (!found) return false;
    cursor.path = found.path;
    cursor.device = found.device;
    cursor.inode = found.inode;
    cursor.offset = 0;
  }
  const file = await open(cursor.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await file.stat();
    if (!state.isFile() || state.uid !== process.getuid?.()
      || String(state.dev) !== cursor.device || String(state.ino) !== cursor.inode
      || state.size < cursor.offset) throw new Error("Claude transcript changed during dispatch");
    const marker = Buffer.from(markerText, "utf8");
    while (cursor.offset < state.size) {
      const remainingBudget = MAX_CLAUDE_MARKER_SCAN_BYTES - cursor.scanned;
      if (remainingBudget <= 0) throw new Error("Claude marker scan exceeded its bound");
      const length = Math.min(CLAUDE_MARKER_SCAN_CHUNK_BYTES, remainingBudget, state.size - cursor.offset);
      const bytes = Buffer.alloc(length);
      const { bytesRead } = await file.read(bytes, 0, length, cursor.offset);
      if (bytesRead <= 0) break;
      cursor.offset += bytesRead;
      cursor.scanned += bytesRead;
      const combined = Buffer.concat([cursor.carry, bytes.subarray(0, bytesRead)]);
      if (combined.includes(marker)) return true;
      cursor.carry = Buffer.from(combined.subarray(Math.max(0, combined.length - marker.length + 1)));
    }
    return false;
  } finally {
    await file.close();
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function tmuxArgs(paths) {
  if (paths.tmuxMode === "legacy") return ["-L", "qiyan-bot", "-f", "/dev/null"];
  return ["-S", paths.tmuxSocketPath, "-f", "/dev/null"];
}

function requireRuntimeDir(value, allowMissing = false) {
  if (typeof value !== "string" || !SAFE_PATH.test(value) || !isAbsolute(value) || resolve(value) !== value
    || !/^[a-f0-9]{24}$/u.test(basename(value))) throw new Error("invalid runtime directory");
  const base = dirname(value);
  const { fallback, shared } = allowedRuntimeBases();
  if (base !== fallback && base !== shared) throw new Error("invalid runtime directory");
  if (base === fallback) attestFallbackRoot();
  attestRuntimeDirectory(base, allowMissing);
  attestRuntimeDirectory(value, allowMissing);
  if (Buffer.byteLength(join(value, "app-server.sock")) > MAX_UNIX_SOCKET_PATH_BYTES) throw new Error("invalid runtime directory");
}

function selectedRuntimeBase() {
  const shared = sharedRuntimeBase();
  if (shared) return shared;
  attestFallbackRoot();
  return fallbackRuntimeBase();
}

function allowedRuntimeBases() {
  return { fallback: fallbackRuntimeBase(), shared: sharedRuntimeBase() };
}

function fallbackRuntimeBase() {
  const uid = process.getuid?.();
  if (!Number.isSafeInteger(uid) || uid < 1) throw new Error("invalid account environment");
  return `/tmp/qiyan-${uid}`;
}

function attestFallbackRoot() {
  const root = "/tmp";
  const state = lstatSync(root);
  const uid = process.getuid?.();
  const untrustedWritable = (state.mode & 0o022) !== 0;
  const protectedSharedRoot = state.uid === 0 && (state.mode & 0o1000) !== 0;
  if (!state.isDirectory() || state.isSymbolicLink() || realpathSync(root) !== root
    || (state.uid !== 0 && state.uid !== uid) || (untrustedWritable && !protectedSharedRoot)
    || Number(statfsSync(root).type) === NFS_SUPER_MAGIC) throw new Error("unsafe runtime filesystem");
}

function sharedRuntimeBase() {
  const root = process.env.XDG_RUNTIME_DIR;
  if (typeof root !== "string" || !SAFE_PATH.test(root) || !isAbsolute(root) || resolve(root) !== root) return undefined;
  try { if (!attestPrivateDirectory(root)) return undefined; }
  catch { return undefined; }
  const base = join(root, "qiyan-bot");
  if (Buffer.byteLength(join(base, "f".repeat(24), "app-server.sock")) > MAX_UNIX_SOCKET_PATH_BYTES) return undefined;
  try { if (!attestPrivateDirectory(base)) return undefined; }
  catch (error) { if (error?.code !== "ENOENT") return undefined; }
  return base;
}

function attestRuntimeDirectory(path, allowMissing) {
  try {
    if (!attestPrivateDirectory(path)) throw new Error("unsafe runtime directory");
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return;
    throw error;
  }
}

function attestPrivateDirectory(path) {
  const state = lstatSync(path);
  return state.isDirectory() && !state.isSymbolicLink() && state.uid === process.getuid?.()
    && (state.mode & 0o077) === 0 && realpathSync(path) === path
    && Number(statfsSync(path).type) !== NFS_SUPER_MAGIC;
}

async function ensurePrivateDirectory(path) {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  const state = lstatSync(path);
  if (!state.isDirectory() || state.isSymbolicLink() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0) throw new Error("unsafe runtime directory");
}

function decodeAsset(value, expected) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid asset");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024 || sha256(bytes) !== expected) throw new Error("invalid asset");
  return bytes;
}

async function atomicWrite(path, bytes, mode) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, mode);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  await chmod(temporary, mode);
  renameSync(temporary, path);
}

async function readIdentity(path) {
  let state;
  try { state = await stat(path); } catch { return undefined; }
  if (!state.isFile() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0 || state.size > 4096) return undefined;
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
  return validIdentity(value);
}

function validIdentity(value) {
  if (value?.kind !== "ssh" || !HEX_128.test(value.token) || !Number.isSafeInteger(value.pid) || value.pid < 2
    || !DECIMAL.test(value.linuxStartTime) || !Number.isSafeInteger(value.processGroupId) || value.processGroupId < 2) return undefined;
  return value;
}

function sameIdentity(left, right) {
  return left.token === right.token && left.pid === right.pid && left.linuxStartTime === right.linuxStartTime && left.processGroupId === right.processGroupId;
}

function processHasToken(pid, token) {
  let environment;
  try { environment = readFileSync(`/proc/${pid}/environ`); } catch { return false; }
  return environment.toString("utf8").split("\0").includes(`QIYAN_RUNTIME_TOKEN=${token}`);
}

function ownedGroupMembers(identity) {
  const members = membersOfGroup(identity.processGroupId);
  const owned = members.filter((pid) => processHasToken(pid, identity.token));
  if (members.length > 0 && (owned.length === 0 || owned.length !== members.length)) throw new Error("runtime process group ownership cannot be proven");
  return owned;
}

function identityMatches(identity) {
  const state = processState(identity.pid);
  return state !== undefined && state.state !== "Z"
    && state.startTime === identity.linuxStartTime && state.processGroupId === identity.processGroupId;
}

function processState(pid) {
  let raw;
  try { raw = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return undefined; }
  const close = raw.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = raw.slice(close + 2).trim().split(/\s+/u);
  const state = fields[0];
  const processGroupId = Number(fields[2]);
  const startTime = fields[19];
  return typeof state === "string" && state.length === 1
    && Number.isSafeInteger(processGroupId) && processGroupId > 1 && DECIMAL.test(startTime ?? "")
    ? { state, processGroupId, startTime }
    : undefined;
}

function membersOfGroup(processGroupId) {
  const members = [];
  for (const name of readdirSync("/proc")) {
    if (!DECIMAL.test(name)) continue;
    const state = processState(Number(name));
    if (state?.state !== "Z" && state?.processGroupId === processGroupId) members.push(Number(name));
  }
  return members;
}

async function waitForEmptyGroup(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (membersOfGroup(processGroupId).length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
}

function run(command, args, allowFailure = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    child.stdout.on("data", (chunk) => { stdout = Buffer.concat([stdout, chunk]); if (stdout.byteLength > 64 * 1024) child.kill("SIGKILL"); });
    child.stderr.on("data", (chunk) => { stderrBytes += chunk.byteLength; if (stderrBytes > 64 * 1024) child.kill("SIGKILL"); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || allowFailure) resolve({ code, stdout });
      else reject(new Error("remote command failed"));
    });
  });
}

function runWithInput(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = Buffer.alloc(0);
    let stderrBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(error);
    };
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > 64 * 1024) fail(new Error("remote command output exceeded its bound"));
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 64 * 1024) fail(new Error("remote command diagnostics exceeded their bound"));
    });
    child.stdin.on("error", () => fail(new Error("remote command input failed")));
    child.once("error", fail);
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ code, stdout });
      else reject(new Error("remote command failed"));
    });
    child.stdin.end(input);
  });
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, statfsSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rm, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";

const SAFE_PATH = /^\/[A-Za-z0-9_./+-]+$/u;
// The Agent SDK resolves under a scoped package directory, so its path is the one remote
// path that legitimately carries an `@`.
const SAFE_SDK_PATH = /^\/[A-Za-z0-9_./@+-]+$/u;
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const HEX_128 = /^[a-f0-9]{32}$/u;
const DECIMAL = /^\d+$/u;
const MAX_ARGUMENT_BYTES = 96 * 1024;
// Declared up here with the other constants because the operation dispatch below runs at
// module top level: a const defined further down is still in its temporal dead zone by then.
const RUNTIME_LOG_CAP_BYTES = 64 * 1024 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 107;
const NFS_SUPER_MAGIC = 0x6969;
const RESPONSE_PREFIX = "qiyan-helper-v1:";
const APP_SERVER_PROXY_READY = "qiyan-app-server-proxy-v1-ready\n";
const CLAUDE_HOST_PROXY_READY = "qiyan-claude-host-proxy-v1-ready\n";

const operation = process.argv[2];
const encoded = process.argv.slice(3);

try {
  if (operation === "proxy-app-server") {
    await proxyAppServer(decodeJson(encoded, 1));
  } else if (operation === "proxy-claude-host") {
    await proxyClaudeHost(decodeJson(encoded, 1));
  } else {
    let result;
    switch (operation) {
      case "preflight": result = preflight(); break;
      case "bootstrap": result = await bootstrap(encoded.length === 0 ? await decodeStdinJson(256 * 1024) : decodeJson(encoded, 1)); break;
      case "inspect": result = await inspect(decodeJson(encoded, 1)); break;
      case "start": result = await start(decodeJson(encoded, 1)); break;
      case "stop": result = await stop(decodeJson(encoded, 1)); break;
      case "inspect-claude-host": result = await inspectClaudeHost(decodeJson(encoded, 1)); break;
      case "start-claude-host": result = await startClaudeHost(decodeJson(encoded, 1)); break;
      case "stop-claude-host": result = await stopClaudeHost(decodeJson(encoded, 1)); break;
      case "read-file": result = await readFileDescriptor(decodeJson(encoded, 1)); break;
      case "read-rollout-slice": result = await readRolloutSlice(decodeJson(encoded, 1)); break;
      case "write-file": result = await writeFileDescriptor(decodeJson(encoded, 1)); break;
      case "workspace": result = await workspace(decodeJson(encoded, 1)); break;
      default: throw new Error("unsupported helper operation");
    }
    process.stdout.write(`\n${RESPONSE_PREFIX}${JSON.stringify(result)}\n`);
  }
} catch (error) {
  // Say what went wrong. Swallowing it left the caller with nothing but `exit 1` for every
  // remote failure alike — a refused start, a missing dependency, a runtime whose state
  // directory was on a stalled filesystem — and the reason never left this host.
  const detail = String(error?.message ?? error ?? "").replace(/\s+/gu, " ").trim().slice(0, 300);
  process.stderr.write(`qiyan remote helper failed${detail ? `: ${detail}` : ""}\n`);
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
    claudeHostBase64,
    claudeHostSha256,
    claudeHostLauncherBase64,
    claudeHostLauncherSha256,
  } = value ?? {};
  requireRuntimeDir(runtimeDir, true);
  if (![helperSha256, launcherSha256, claudeHostSha256, claudeHostLauncherSha256]
    .every((item) => typeof item === "string" && /^[a-f0-9]{64}$/u.test(item))) throw new Error("invalid asset digest");
  const helper = decodeAsset(helperBase64, helperSha256);
  const launcher = decodeAsset(launcherBase64, launcherSha256);
  const claudeHost = decodeAsset(claudeHostBase64, claudeHostSha256);
  const claudeHostLauncher = decodeAsset(claudeHostLauncherBase64, claudeHostLauncherSha256);
  await ensurePrivateDirectory(dirname(runtimeDir));
  await ensurePrivateDirectory(runtimeDir);
  requireRuntimeDir(runtimeDir);
  await atomicWrite(join(runtimeDir, "qiyan-ssh-helper.mjs"), helper, 0o700);
  await atomicWrite(join(runtimeDir, "qiyan-app-server-launcher.sh"), launcher, 0o700);
  await atomicWrite(join(runtimeDir, "qiyan-claude-host.mjs"), claudeHost, 0o700);
  await atomicWrite(join(runtimeDir, "qiyan-claude-host-launcher.sh"), claudeHostLauncher, 0o700);
  return { installed: true };
}

// The launcher rotates the runtime log only when it STARTS: it moves the old file aside,
// keeps its last MiB, and begins a fresh one. Then it execs the server, so no launcher process
// remains and nothing rotates a log that is already running — which is how one grew to 3.1 GB
// in under five minutes, in /run/user, which is RAM.
//
// Truncating in place is safe rather than clever: the launcher redirects with `>>`, so the
// server's descriptor is O_APPEND and every write atomically seeks to end-of-file. After a
// truncate the next write lands at offset 0 — no sparse file, no interleaving, and no
// intermediary process between tmux and the server, which is what the identity checks rely on.
// Keeping a tail instead WOULD race the appender, so the whole file goes.

async function capRuntimeLog(logPath) {
  try {
    const current = await stat(logPath);
    if (!current.isFile() || current.size <= RUNTIME_LOG_CAP_BYTES) return;
    await truncate(logPath, 0);
    // Leave a record. A log that simply becomes small is indistinguishable from a quiet one,
    // and whoever reads it next has no way to know bytes were dropped.
    await writeFile(logPath, `--- qiyan: capped ${current.size} bytes at ${new Date().toISOString()} ---\n`, { flag: "a", mode: 0o600 });
  } catch { /* the log is absent or unreadable: nothing to cap, and never a probe failure */ }
}

async function inspect(value) {
  const paths = runtimePaths(value, true);
  await capRuntimeLog(join(paths.runtimeDir, "app-server.log"));
  const tmux = await run("tmux", [...tmuxArgs(paths), "has-session", "-t", paths.session], true);
  const identityFile = await stat(paths.identityPath).catch(() => undefined);
  const socketFile = await stat(paths.socketPath).catch(() => undefined);
  const identity = await readIdentity(paths.identityPath);
  const group = identity ? membersOfGroup(identity.processGroupId) : [];
  const ownedGroup = identity ? group.filter((pid) => processHasToken(pid, identity.token)) : [];
  const groupAlive = group.length > 0;
  // Whether the supervisor is still there. A caller cannot otherwise tell a runtime whose tmux
  // session is GONE — dead, and its leftovers reclaimable — from one that is alive but failing a
  // check, which must be left alone.
  const supervised = tmux.code === 0;
  if (!supervised) {
    if ((identityFile && !identity) || (!identity && socketFile) || groupAlive) return { status: "unhealthy", supervised, ...(identity ? { identity, ownedGroup, groupSize: group.length } : {}) };
    return { status: "absent", supervised };
  }
  if (!identity || !identityMatches(identity)) return { status: "unhealthy", supervised, ...(identity ? { identity, ownedGroup, groupSize: group.length } : {}) };
  if (!socketFile?.isSocket() || socketFile.uid !== process.getuid?.() || (socketFile.mode & 0o077) !== 0) {
    return { status: "unhealthy", supervised, identity, ownedGroup, groupSize: group.length };
  }
  return { status: "healthy", identity, supervised };
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
  // Reclaiming an unhealthy runtime is `stop`'s job, and ensureStarted routes through it before
  // ever calling start. Starting over one here would race that.
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
  // Say why. The app-server writes its own startup failure to this log and then exits, and
  // without it the caller sees only that the runtime never appeared -- the reason (a state
  // directory on an unresponsive filesystem, say) stays on this host.
  throw new Error(`runtime did not become healthy${await launcherFailureDetail(paths)}`);
}

async function launcherFailureDetail(paths) {
  try {
    const log = await readFile(join(paths.runtimeDir, "app-server.log"), "utf8");
    const lines = log.replace(/\u001b\[[0-9;]*m/gu, "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const detail = lines.slice(-2).join("; ").slice(0, 300);
    return detail ? `: ${detail}` : "";
  } catch { return ""; }
}

async function stop(value) {
  const paths = runtimePaths(value);
  const identity = await readIdentity(paths.identityPath);
  const expected = validIdentity(value?.expected);
  if (!identity || !expected || !sameIdentity(identity, expected)) throw new Error("runtime identity cannot be proven");
  let survivors = 0;
  if (identity) {
    // This gate is the protection against a RECYCLED pgid, not a redundant liveness check:
    // the signal below goes to the whole process group, and only a surviving member still
    // carrying our token proves the group is still ours. If every member had died and the
    // kernel handed that pgid to something else, no member carries the token and nothing is
    // signalled. Removing this would make the kill reuse-unsafe and silently so.
    let members = ownedGroupMembers(identity);
    if (members.length > 0) {
      try { process.kill(-identity.processGroupId, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
      await waitForEmptyGroup(identity.processGroupId, 2_000);
      members = ownedGroupMembers(identity);
      if (members.length > 0) {
        try { process.kill(-identity.processGroupId, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
        await waitForEmptyGroup(identity.processGroupId, 2_000);
      }
      survivors = ownedGroupMembers(identity).length;
      // A survivor is only a FAILURE while something is left to protect. A process blocked in
      // uninterruptible I/O -- a stalled network filesystem -- cannot be reaped by any signal:
      // the SIGKILL simply sits pending. Refusing to finish there is how one wedged `git`, long
      // outliving the server that spawned it, locked its endpoint out for hours: the repair was
      // refused by debris that could never go away.
      //
      // So insist only that the SERVER is gone -- its recorded process dead and its supervisor
      // with it. That is the condition under which a replacement cannot become a second live
      // app-server on the same socket, which is the thing this check is really for. Leftover
      // descendants do not qualify: the replacement gets a new pid, process group and token.
      if (survivors > 0) {
        const supervised = (await run("tmux", [...tmuxArgs(paths), "has-session", "-t", paths.session], true)).code === 0;
        const serverAlive = identityMatches(identity) && processHasToken(identity.pid, identity.token);
        if (supervised || serverAlive) throw new Error("runtime process group did not stop");
      }
    }
  }
  await run("tmux", [...tmuxArgs(paths), "kill-session", "-t", paths.session], true);
  await rm(paths.socketPath, { force: true });
  await rm(paths.identityPath, { force: true });
  // Report what was left behind. A caller that reclaimed over unreapable debris should be able
  // to say so rather than presenting the endpoint as cleanly stopped.
  return { stopped: true, ...survivors > 0 ? { survivors } : {} };
}

// The Claude host runtime is the Codex app-server runtime with a different server: one
// tmux-supervised process holding an owner-only unix socket, identified by the token it
// carries in its own /proc environ. Inspection is therefore the same three proofs — the
// supervising session exists, the recorded process is still that process, and the socket is
// private — so the two providers cannot drift into different liveness semantics.
async function inspectClaudeHost(value) {
  const paths = claudeRuntimePaths(value, true);
  await capRuntimeLog(join(paths.runtimeDir, "claude-host.log"));
  const tmux = await run("tmux", [...tmuxArgs(paths), "has-session", "-t", paths.session], true);
  const identityFile = await stat(paths.claudeHostIdentityPath).catch(() => undefined);
  const socketFile = await stat(paths.claudeHostSocketPath).catch(() => undefined);
  const identity = await readIdentity(paths.claudeHostIdentityPath);
  const group = identity ? membersOfGroup(identity.processGroupId) : [];
  const ownedGroup = identity ? group.filter((pid) => processHasToken(pid, identity.token)) : [];
  const groupAlive = group.length > 0;
  const supervised = tmux.code === 0;
  if (!supervised) {
    if ((identityFile && !identity) || (!identity && socketFile) || groupAlive) return { status: "unhealthy", supervised, ...(identity ? { identity, ownedGroup, groupSize: group.length } : {}) };
    return { status: "absent", supervised };
  }
  // The launcher exports QIYAN_RUNTIME_TOKEN before exec, so the environ check proves the
  // live process is the one we started rather than a recycled pid that matches by accident.
  if (!identity || !identityMatches(identity) || !processHasToken(identity.pid, identity.token)) {
    return { status: "unhealthy", supervised, ...(identity ? { identity, ownedGroup, groupSize: group.length } : {}) };
  }
  if (!socketFile?.isSocket() || socketFile.uid !== process.getuid?.() || (socketFile.mode & 0o077) !== 0) {
    return { status: "unhealthy", supervised, identity, ownedGroup, groupSize: group.length };
  }
  return { status: "healthy", identity, supervised };
}

async function startClaudeHost(value) {
  const paths = claudeRuntimePaths(value);
  if (paths.tmuxMode !== "explicit" || !HEX_128.test(value?.token ?? "")
    || typeof value?.shell !== "string" || !SAFE_PATH.test(value.shell)) throw new Error("invalid Claude host start request");
  // Capability probe on the login PATH: node runs the host bundle, claude is the CLI the
  // SDK drives, tmux supervises the generation, tail rotates the host log.
  const capability = spawnSync(value.shell, ["-lc", "command -v node; command -v claude; command -v tmux; command -v tail"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
  });
  const capabilityPaths = (capability.stdout ?? "").split(/\r?\n/u).map((line) => line.trim()).filter((line) => SAFE_PATH.test(line));
  if (capability.status !== 0 || capabilityPaths.slice(-4).length !== 4) {
    throw new Error("node, claude, tmux, and tail are required to start a remote Claude host");
  }
  const before = await inspectClaudeHost(value);
  if (before.status === "healthy") return { identity: before.identity };
  if (before.status === "unhealthy") throw new Error("existing Claude host is unhealthy");
  // Only a real launch pays for this: it shells out to `npm root -g`, and reattaching to a
  // healthy host above must stay a cheap round-trip.
  const sdkPath = resolveAgentSdkPath(value.shell);
  await unlink(paths.claudeHostSocketPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  await unlink(paths.claudeHostIdentityPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  const inner = `exec ${paths.claudeHostLauncherPath} ${value.token} ${paths.claudeHostSocketPath} ${paths.claudeHostIdentityPath} ${paths.claudeHostPath} ${sdkPath}`;
  if (![paths.claudeHostLauncherPath, paths.claudeHostSocketPath, paths.claudeHostIdentityPath, paths.claudeHostPath].every((item) => SAFE_PATH.test(item))) {
    throw new Error("unsafe Claude host launcher path");
  }
  const command = `${value.shell} -lc '${inner}'`;
  await run("tmux", [...tmuxArgs(paths), "new-session", "-d", "-s", paths.session, command]);
  // Longer than the app-server's window: before it binds, the host imports the Agent SDK
  // and probes `claude --version`, so it fails its prerequisites here rather than later.
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const state = await inspectClaudeHost(value);
    if (state.status === "healthy") return { identity: state.identity };
    if (state.status === "absent") break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Claude host did not become healthy");
}

// The host bundle lives outside any node_modules tree, so it cannot resolve the SDK itself
// (and NODE_PATH would not help: it is ignored for ESM). Resolve it here, under the login
// shell, from the roots an install actually lands in — the npm global prefix, then the
// account's own node_modules — and hand the host the absolute entry path.
function resolveAgentSdkPath(shell) {
  const script = "const { createRequire } = require('node:module');"
    + "for (const root of process.argv.slice(1)) {"
    + "  if (!root) continue;"
    + "  try { process.stdout.write(createRequire(root + '/qiyan.js').resolve('@anthropic-ai/claude-agent-sdk')); process.exit(0); } catch { /* try the next root */ }"
    + "}"
    + "process.exit(1);";
  const resolved = spawnSync(shell, ["-lc", `node -e ${shellQuote(script)} -- "$(npm root -g 2>/dev/null)" "$HOME"`], {
    encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024,
  });
  const sdkPath = (resolved.stdout ?? "").trim();
  if (resolved.status !== 0 || !SAFE_SDK_PATH.test(sdkPath) || !isAbsolute(sdkPath)) {
    throw new Error("the Claude Agent SDK is not installed on this host (npm i -g @anthropic-ai/claude-agent-sdk)");
  }
  return sdkPath;
}

async function stopClaudeHost(value) {
  const paths = claudeRuntimePaths(value);
  const identity = await readIdentity(paths.claudeHostIdentityPath);
  const expected = validIdentity(value?.expected);
  if (!identity || !expected || !sameIdentity(identity, expected)) throw new Error("Claude host identity cannot be proven");
  let survivors = 0;
  let members = ownedGroupMembers(identity);
  if (members.length > 0) {
    try { process.kill(-identity.processGroupId, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
    await waitForEmptyGroup(identity.processGroupId, 2_000);
    members = ownedGroupMembers(identity);
    if (members.length > 0) {
      try { process.kill(-identity.processGroupId, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
      await waitForEmptyGroup(identity.processGroupId, 2_000);
    }
    survivors = ownedGroupMembers(identity).length;
    // Same rule as the Codex runtime's stop, and it matters MORE here: Claude runs Bash tools,
    // so a command it started can be blocked in uninterruptible I/O on a stalled filesystem —
    // inheriting the host's process group and token, unreapable by any signal, and otherwise
    // refusing this reclaim forever. Insist only that the HOST is gone.
    if (survivors > 0) {
      const supervised = (await run("tmux", [...tmuxArgs(paths), "has-session", "-t", paths.session], true)).code === 0;
      const hostAlive = identityMatches(identity) && processHasToken(identity.pid, identity.token);
      if (supervised || hostAlive) throw new Error("Claude host process group did not stop");
    }
  }
  await run("tmux", [...tmuxArgs(paths), "kill-session", "-t", paths.session], true);
  await rm(paths.claudeHostSocketPath, { force: true });
  await rm(paths.claudeHostIdentityPath, { force: true });
  // The tmux socket is deliberately left alone: one tmux server in this runtime directory
  // may also be supervising the endpoint's Codex app-server session, and unlinking it would
  // strand that generation. Codex's own stop() does not remove it either.
  return { stopped: true, ...survivors > 0 ? { survivors } : {} };
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

// Byte-for-byte the app-server proxy against the Claude host's socket: prove the recorded
// runtime identity before AND after connecting, prove the socket did not change inode
// underneath us, and only then announce readiness and copy bytes. A swapped socket must
// never receive a single framed request.
async function proxyClaudeHost(value) {
  const paths = claudeRuntimePaths(value);
  const expected = validIdentity(value?.expected);
  if (!expected) throw new Error("invalid expected Claude host identity");
  const beforeIdentity = await readIdentity(paths.claudeHostIdentityPath);
  if (!beforeIdentity || !sameIdentity(beforeIdentity, expected) || !identityMatches(beforeIdentity)
    || !processHasToken(beforeIdentity.pid, beforeIdentity.token)) {
    throw new Error("Claude host identity changed");
  }
  const beforeSocket = await privateSocketIdentity(paths.claudeHostSocketPath);
  const socket = connect(paths.claudeHostSocketPath);
  try {
    await new Promise((resolveConnection, rejectConnection) => {
      const connected = () => { cleanup(); resolveConnection(); };
      const failed = () => { cleanup(); rejectConnection(new Error("Claude host socket connection failed")); };
      const cleanup = () => { socket.off("connect", connected); socket.off("error", failed); };
      socket.once("connect", connected);
      socket.once("error", failed);
    });
    const [afterSocket, afterIdentity] = await Promise.all([
      privateSocketIdentity(paths.claudeHostSocketPath),
      readIdentity(paths.claudeHostIdentityPath),
    ]);
    if (afterSocket.device !== beforeSocket.device || afterSocket.inode !== beforeSocket.inode
      || !afterIdentity || !sameIdentity(afterIdentity, expected) || !identityMatches(afterIdentity)) {
      throw new Error("Claude host changed during connection");
    }
    await new Promise((resolveReady, rejectReady) => {
      process.stdout.write(CLAUDE_HOST_PROXY_READY, (error) => error ? rejectReady(error) : resolveReady());
    });
    await new Promise((resolveProxy, rejectProxy) => {
      const failed = () => rejectProxy(new Error("Claude host proxy failed"));
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
    || (uid !== undefined && state.uid !== BigInt(uid))) throw new Error("invalid runtime socket");
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
    // Deliberately short: requireRuntimeDir bounds `app-server.sock` (15 bytes) against the
    // 107-byte unix path limit, so an 11-byte socket name keeps that one check sufficient
    // for every socket this runtime directory holds.
    claudeHostSocketPath: join(paths.runtimeDir, "claude.sock"),
    claudeHostIdentityPath: join(paths.runtimeDir, "claude-host-identity.json"),
    claudeHostLauncherPath: join(paths.runtimeDir, "qiyan-claude-host-launcher.sh"),
    claudeHostPath: join(paths.runtimeDir, "qiyan-claude-host.mjs"),
  };
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

// The members of the runtime's process group that still carry its token. Deliberately NOT a
// proof obligation: a descendant that re-execs with a scrubbed environment fails the token check
// while still being ours (group membership implies descent -- setpgid can only join a group in
// the caller's session), and a recycled pgid shows members that carry no token at all. Throwing
// on either turned an endpoint whose debris could not be reaped into a permanent lockout, which
// is the failure this whole path exists to end. Callers gate on `owned.length > 0` instead:
// one surviving token-carrier is what proves the group is still ours and makes signalling it safe.
function ownedGroupMembers(identity) {
  return membersOfGroup(identity.processGroupId).filter((pid) => processHasToken(pid, identity.token));
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


function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

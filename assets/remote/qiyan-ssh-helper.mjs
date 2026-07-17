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
// QiYan's per-turn ownership marker in a Claude message body (see claude-transcript.ts).
// Declared with the other top-level consts so it is initialized before the entry `try`.
const CLAUDE_CLIENT_MARKER = /<!--\s*qiyan-cid:([A-Za-z0-9:_.-]{1,256})\s*-->/u;
const MAX_ARGUMENT_BYTES = 96 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 107;
const NFS_SUPER_MAGIC = 0x6969;
const RESPONSE_PREFIX = "qiyan-helper-v1:";
const APP_SERVER_PROXY_READY = "qiyan-app-server-proxy-v1-ready\n";
const HISTORY_SCAN_BYTES = 4 * 1024 * 1024;
const HISTORY_SCAN_RECORDS = 20_000;
const HISTORY_PARSE_LINE_BYTES = 2 * 1024 * 1024;
const HISTORY_PENDING_BYTES = 4 * 1024 * 1024;
const HISTORY_PAGE_JSON_BYTES = 700 * 1024;
const HISTORY_FRAME_BYTES = 768 * 1024;
const HISTORY_CURSOR_BYTES = 4096;
const HISTORY_CURSOR_TERMINALS = 16;

const operation = process.argv[2];
const encoded = process.argv.slice(3);

try {
  if (operation === "proxy-app-server") {
    await proxyAppServer(decodeJson(encoded, 1));
  } else {
    let result;
    switch (operation) {
      case "preflight": result = preflight(); break;
      case "bootstrap": result = await bootstrap(encoded.length === 0 ? await decodeStdinJson(256 * 1024) : decodeJson(encoded, 1)); break;
      case "inspect": result = await inspect(decodeJson(encoded, 1)); break;
      case "start": result = await start(decodeJson(encoded, 1)); break;
      case "stop": result = await stop(decodeJson(encoded, 1)); break;
      case "read-file": result = await readFileDescriptor(decodeJson(encoded, 1)); break;
      case "write-file": result = await writeFileDescriptor(decodeJson(encoded, 1)); break;
      case "rollout-scan": result = await scanRollouts(decodeJson(encoded, 1)); break;
      case "claude-rollout-scan": result = await scanClaudeTranscripts(decodeJson(encoded, 1)); break;
      case "codex-history": result = await codexHistory(decodeJson(encoded, 1)); break;
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
  const { runtimeDir, helperBase64, helperSha256, launcherBase64, launcherSha256 } = value ?? {};
  requireRuntimeDir(runtimeDir, true);
  if (![helperSha256, launcherSha256].every((item) => typeof item === "string" && /^[a-f0-9]{64}$/u.test(item))) throw new Error("invalid asset digest");
  const helper = decodeAsset(helperBase64, helperSha256);
  const launcher = decodeAsset(launcherBase64, launcherSha256);
  await ensurePrivateDirectory(dirname(runtimeDir));
  await ensurePrivateDirectory(runtimeDir);
  requireRuntimeDir(runtimeDir);
  await atomicWrite(join(runtimeDir, "qiyan-ssh-helper.mjs"), helper, 0o700);
  await atomicWrite(join(runtimeDir, "qiyan-app-server-launcher.sh"), launcher, 0o700);
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

async function scanRollouts(value) {
  if (!Array.isArray(value?.requests) || value.requests.length < 1 || value.requests.length > 128) throw new Error("invalid rollout scan request");
  if (value.allowMissing !== undefined && value.allowMissing !== true) throw new Error("invalid rollout scan request");
  if (value.collectFromStart !== undefined && value.collectFromStart !== true) throw new Error("invalid rollout scan request");
  if (value.collectFromStart === true && value.allowMissing !== true) throw new Error("invalid rollout scan request");
  const collectFromStart = value.collectFromStart === true;
  return {
    results: await Promise.all(value.requests.map((request) => value.allowMissing === true
      ? scanRolloutAllowMissing(request, collectFromStart)
      : scanRollout(request, collectFromStart))),
  };
}

async function scanRolloutAllowMissing(request, collectFromStart) {
  try { return await scanRollout(request, collectFromStart); }
  catch (error) { if (error?.code === "ENOENT") return { missing: true }; throw error; }
}

async function scanRollout(request, collectFromStart = false) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await scanRolloutSnapshot(request, collectFromStart); }
    catch (error) {
      if (attempt >= 3 || error?.message !== "rollout appended while scanning") throw error;
    }
  }
}

async function scanRolloutSnapshot(request, collectFromStart = false) {
  const path = request?.path;
  const threadId = request?.threadId;
  const cursor = request?.cursor;
  const name = typeof path === "string" ? basename(path) : "";
  if (typeof path !== "string" || !isAbsolute(path) || typeof threadId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(threadId)
    || !name.startsWith("rollout-") || !name.endsWith(`-${threadId}.jsonl`)) throw new Error("invalid rollout scan request");
  if (cursor !== undefined && (cursor === null || typeof cursor !== "object" || !DECIMAL.test(cursor.device ?? "")
    || !DECIMAL.test(cursor.inode ?? "") || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)) throw new Error("invalid rollout scan cursor");
  const offset = cursor?.offset ?? 0;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await file.stat({ bigint: true });
    const uid = process.getuid?.();
    if (!state.isFile() || (uid !== undefined && state.uid !== BigInt(uid)) || state.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid rollout file");
    const device = state.dev.toString(10);
    const inode = state.ino.toString(10);
    if (cursor && (cursor.device !== device || cursor.inode !== inode)) throw new Error("rollout identity changed");
    if (BigInt(offset) > state.size) throw new Error("rollout was truncated");
    const parsed = await parseRolloutFile(file, offset, Number(state.size), cursor !== undefined || collectFromStart);
    const after = await file.stat({ bigint: true });
    if (after.dev !== state.dev || after.ino !== state.ino) throw new Error("rollout identity changed");
    if (after.size < state.size) throw new Error("rollout was truncated");
    if (after.size > state.size) throw new Error("rollout appended while scanning");
    if (after.mtimeNs !== state.mtimeNs) throw new Error("rollout changed while scanning");
    return parsed.result({ device, inode, offset });
  } finally { await file.close(); }
}

async function parseRolloutFile(file, offset, size, collectStarts) {
  const parser = createRolloutParser(offset, collectStarts);
  let position = offset;
  let carry = Buffer.alloc(0);
  let carryStart = offset;
  while (position < size) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - position));
    const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) throw new Error("rollout was truncated");
    position += bytesRead;
    const bytes = carry.byteLength === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
    let lineStart = 0;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      parser.consume(bytes.subarray(lineStart, index), carryStart + lineStart, carryStart + index + 1);
      lineStart = index + 1;
    }
    carryStart += lineStart;
    carry = Buffer.from(bytes.subarray(lineStart));
    if (carry.byteLength > 64 * 1024 * 1024) throw new Error("rollout line exceeds bounded window");
  }
  return parser;
}

function createRolloutParser(baseOffset, collectStarts) {
  const starts = [];
  let current;
  let parsedEnd = baseOffset;
  let malformedOffset;
  function report(turn) {
    if (!collectStarts) return;
    if (starts.length >= 1024) throw new Error("rollout ownership scan contains too many turns");
    starts.push(publicRolloutStart(turn));
  }
  function consume(raw, lineStart, lineEnd) {
    parsedEnd = lineEnd;
    if (raw.byteLength === 0) return;
    let value;
    try { value = JSON.parse(raw.toString("utf8")); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      malformedOffset ??= lineStart;
      if (current?.sawUserMessage) report(current);
      current = undefined;
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const payload = value.payload;
    if (value.type !== "event_msg" || typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const type = payload.type;
    const turnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined;
    if ((type === "task_started" || type === "turn_started") && turnId) {
      if (current) report(current);
      current = { turnId, startOffset: lineStart, sawUserMessage: false };
      return;
    }
    if (type === "user_message" && current) {
      current.sawUserMessage = true;
      if (typeof payload.client_id === "string" && payload.client_id.length > 0) current.clientId = payload.client_id;
      return;
    }
    if ((type === "task_complete" || type === "turn_complete" || type === "turn_aborted")
      && current && (!turnId || turnId === current.turnId)) {
      report(current);
      current = undefined;
    }
  }
  function result(identity) {
    if (current?.sawUserMessage) report(current);
    const semanticOffset = current && !current.sawUserMessage ? current.startOffset : parsedEnd;
    const cursorOffset = malformedOffset === undefined ? semanticOffset : Math.min(semanticOffset, malformedOffset);
    return {
      cursor: { ...identity, offset: cursorOffset },
      starts,
      ...(current ? { openTurn: publicRolloutStart(current) } : {}),
      ...(malformedOffset === undefined ? {} : { malformed: true }),
    };
  }
  return { consume, result };
}

function publicRolloutStart(turn) {
  return {
    turnId: turn.turnId,
    ...(turn.clientId ? { clientId: turn.clientId } : {}),
    ...(turn.sawUserMessage ? { hasUserMessage: true } : {}),
  };
}

// Bounded, on-demand Web UI history. Keep this algorithm in parity with
// src/webui/codex-rollout-history.ts; the tests run identical fixtures through both copies.
async function codexHistory(value) {
  const path = value?.path;
  const threadId = value?.threadId;
  const name = typeof path === "string" ? basename(path) : "";
  if (typeof path !== "string" || !isAbsolute(path) || typeof threadId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(threadId)
    || !name.startsWith("rollout-") || !name.endsWith(`-${threadId}.jsonl`)
    || (value?.activeTurnId !== undefined && (typeof value.activeTurnId !== "string"
      || value.activeTurnId.length < 1 || value.activeTurnId.length > 256))
    || !Number.isSafeInteger(value?.limit) || value.limit < 1 || value.limit > 50) throw new Error("invalid Codex history request");
  const cursor = decodeHistoryCursor(value.cursor);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await file.stat({ bigint: true });
    const uid = process.getuid?.();
    if (!state.isFile() || state.size > BigInt(Number.MAX_SAFE_INTEGER)
      || (uid !== undefined && state.uid !== BigInt(uid))) throw new Error("invalid Codex rollout file");
    const device = state.dev.toString(10);
    const inode = state.ino.toString(10);
    if (cursor && (cursor.device !== device || cursor.inode !== inode || BigInt(cursor.before) > state.size)) throw new Error("stale Codex history cursor");
    if (cursor?.pending.some((entry) => BigInt(entry.end) > state.size || entry.start < cursor.before)) throw new Error("stale Codex history cursor");
    const before = cursor?.before ?? Number(state.size);
    let pending = cursor?.pending ?? [];
    let pendingBytes = pendingHistoryLength(pending);
    let pendingSkipped = cursor?.pendingSkipped ?? false;
    const terminal = new Map((cursor?.terminals ?? []).map((entry) => [entry.turnId, { status: entry.status, at: entry.at }]));
    const messages = [];
    const openTurnIds = [];
    const terminalTurnIds = [];
    const parsedVisible = new Map();
    let pageJsonBytes = 128;
    let oldestSelectedOffset;
    let pageFilled = false;
    let pageBoundaryOffset;
    let carryTerminal;
    let resolvedCursor;
    let unresolvedActiveTurnId = cursor?.activeTurnId ?? (cursor ? undefined : value.activeTurnId);

    if (cursor?.resolved) {
      const materialized = await materializeHistoryPending(file, pending, cursor.resolved, parsedVisible, messages, value.limit, pageJsonBytes);
      pageJsonBytes = materialized.pageJsonBytes;
      oldestSelectedOffset = materialized.oldestSelectedOffset;
      pending = pending.slice(materialized.consumed);
      pendingBytes = pendingHistoryLength(pending);
      rememberHistoryPresentation(cursor.resolved, materialized.emitted, openTurnIds, terminalTurnIds);
      if (pending.length > 0) {
        resolvedCursor = {
          device, inode, before, pending, terminals: cursor.terminals, skipPartial: false,
          pendingSkipped: false, ...(cursor.activeTurnId ? { activeTurnId: cursor.activeTurnId } : {}), resolved: cursor.resolved,
        };
        return finishHistoryPage(messages, openTurnIds, terminalTurnIds, encodeHistoryCursor(resolvedCursor));
      }
      if (messages.length >= value.limit || materialized.filled) {
        const nextCursor = before > 0
          ? encodeHistoryCursor({
            device, inode, before, pending: [], terminals: [], skipPartial: false, pendingSkipped: false,
            ...(cursor.activeTurnId ? { activeTurnId: cursor.activeTurnId } : {}),
          })
          : undefined;
        return finishHistoryPage(messages, openTurnIds, terminalTurnIds, nextCursor);
      }
    }

    const window = await readReverseHistoryWindow(file, before, cursor?.skipPartial ?? false);

    for (const line of window.lines) {
      if (!line.bytes) continue;
      const record = parseHistoryRecord(line.bytes);
      if (!record) continue;
      const payload = objectRecord(record.payload);
      const at = historyTimestamp(record.timestamp);
      if (record.type === "event_msg" && payload) {
        const eventType = nonEmptyText(payload.type);
        const turnId = nonEmptyText(payload.turn_id);
        const status = historyTerminalStatus(eventType);
        if (status && turnId) { rememberHistoryTerminal(terminal, turnId, { status, at }); continue; }
        if ((eventType === "task_started" || eventType === "turn_started") && turnId) {
          if (turnId === unresolvedActiveTurnId) unresolvedActiveTurnId = undefined;
          const proof = terminal.get(turnId);
          const turnStatus = proof?.status ?? "inProgress";
          const resolved = { turnId, status: turnStatus, at: proof?.at ?? -1, turnOrder: line.start };
          const materialized = await materializeHistoryPending(file, pending, resolved, parsedVisible, messages, value.limit, pageJsonBytes);
          pageJsonBytes = materialized.pageJsonBytes;
          oldestSelectedOffset = materialized.oldestSelectedOffset ?? oldestSelectedOffset;
          const remaining = pending.slice(materialized.consumed);
          rememberHistoryPresentation(resolved, materialized.emitted, openTurnIds, terminalTurnIds);
          if (remaining.length > 0) {
            resolvedCursor = {
              device, inode, before: line.start, pending: remaining, terminals: [], skipPartial: false,
              pendingSkipped: false, resolved,
            };
            pageFilled = true;
            break;
          }
          if (pendingSkipped && proof) carryTerminal = { turnId, status: turnStatus, at: proof.at };
          pending = [];
          pendingBytes = 0;
          terminal.delete(turnId);
          if (pendingSkipped || messages.length >= value.limit || materialized.filled) {
            pageFilled = true; pageBoundaryOffset = line.start; break;
          }
          pendingSkipped = false;
          continue;
        }
        if (eventType === "user_message" && typeof payload.message === "string") {
          const item = visibleHistoryUser(line.start, payload, at);
          const descriptor = { start: line.start, end: line.end };
          if (item && canRetainHistoryPending(pending, pendingBytes, descriptor, messages.length, value.limit)) {
            pending.push(descriptor); pendingBytes += line.end - line.start; parsedVisible.set(line.start, item);
          } else if (item) pendingSkipped = true;
        }
        continue;
      }
      if (record.type !== "response_item" || !payload || payload.type !== "message" || payload.role !== "assistant") continue;
      const item = visibleHistoryAssistant(line.start, payload, at);
      const descriptor = { start: line.start, end: line.end };
      if (item && canRetainHistoryPending(pending, pendingBytes, descriptor, messages.length, value.limit)) {
        pending.push(descriptor); pendingBytes += line.end - line.start; parsedVisible.set(line.start, item);
      } else if (item) pendingSkipped = true;
    }

    if (!resolvedCursor && !pageFilled && unresolvedActiveTurnId && pending.length > 0) {
      const resolved = { turnId: unresolvedActiveTurnId, status: "inProgress", at: -1, turnOrder: window.nextBefore };
      const materialized = await materializeHistoryPending(file, pending, resolved, parsedVisible, messages, value.limit, pageJsonBytes);
      pageJsonBytes = materialized.pageJsonBytes;
      oldestSelectedOffset = materialized.oldestSelectedOffset ?? oldestSelectedOffset;
      const remaining = pending.slice(materialized.consumed);
      rememberHistoryPresentation(resolved, materialized.emitted, openTurnIds, terminalTurnIds);
      if (remaining.length > 0) {
        resolvedCursor = {
          device, inode, before: window.nextBefore, pending: remaining, terminals: [], skipPartial: false,
          pendingSkipped: false, activeTurnId: unresolvedActiveTurnId, resolved,
        };
        pageFilled = true;
      } else {
        pending = [];
        pendingBytes = 0;
        if (pendingSkipped || messages.length >= value.limit || materialized.filled) {
          pageFilled = true;
          pageBoundaryOffset = materialized.oldestSelectedOffset ?? window.nextBefore;
        }
      }
    }

    let nextCursor;
    if (resolvedCursor) {
      nextCursor = encodeHistoryCursor(resolvedCursor);
    } else if (pageFilled && pendingSkipped && oldestSelectedOffset !== undefined && oldestSelectedOffset > 0) {
      nextCursor = encodeHistoryCursor({
        device, inode, before: oldestSelectedOffset, pending: [],
        terminals: carryTerminal ? [carryTerminal] : [], skipPartial: false, pendingSkipped: false,
        ...(unresolvedActiveTurnId ? { activeTurnId: unresolvedActiveTurnId } : {}),
      });
    } else if (pageFilled && (pageBoundaryOffset ?? 0) > 0) {
      nextCursor = encodeHistoryCursor({
        device, inode, before: pageBoundaryOffset, pending: [], terminals: [], skipPartial: false, pendingSkipped: false,
        ...(unresolvedActiveTurnId ? { activeTurnId: unresolvedActiveTurnId } : {}),
      });
    } else if (window.hasMore) {
      nextCursor = encodeHistoryCursor({
        device, inode, before: window.nextBefore, pending,
        terminals: [...terminal].slice(-HISTORY_CURSOR_TERMINALS).map(([pendingTurnId, proof]) => ({ turnId: pendingTurnId, ...proof })),
        skipPartial: window.skipPartial, pendingSkipped,
        ...(unresolvedActiveTurnId ? { activeTurnId: unresolvedActiveTurnId } : {}),
      });
    }
    return finishHistoryPage(messages, openTurnIds, terminalTurnIds, nextCursor);
  } finally { await file.close(); }
}

async function materializeHistoryPending(file, pending, resolved, parsedVisible, messages, pageSize, initialPageJsonBytes) {
  let pageJsonBytes = initialPageJsonBytes;
  let emitted = 0;
  let oldestSelectedOffset;
  for (let index = 0; index < pending.length; index += 1) {
    if (messages.length >= pageSize) return { consumed: index, emitted, pageJsonBytes, oldestSelectedOffset, filled: true };
    const descriptor = pending[index];
    const item = parsedVisible.get(descriptor.start) ?? await readPendingHistoryMessage(file, descriptor);
    if (!item) continue;
    const nativeId = item.nativeId ?? item.clientId ?? `rollout-${item.lineStart}`;
    const message = {
      id: `${item.role === "you" ? "u" : "a"}:${resolved.turnId}:${nativeId}`,
      turnId: resolved.turnId, body: item.body, completedAt: resolved.at >= 0 ? resolved.at : item.at,
      terminalStatus: resolved.status, turnOrder: resolved.turnOrder, itemOrder: item.lineStart,
      ...(item.role === "you" ? { role: "you" } : {}),
      ...(item.clientId ? { clientId: item.clientId } : {}),
      ...(item.phase ? { phase: item.phase } : {}),
    };
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8") + 1;
    if (pageJsonBytes + bytes > HISTORY_PAGE_JSON_BYTES) return { consumed: index, emitted, pageJsonBytes, oldestSelectedOffset, filled: true };
    messages.push(message); emitted += 1; pageJsonBytes += bytes; oldestSelectedOffset = descriptor.start;
  }
  return { consumed: pending.length, emitted, pageJsonBytes, oldestSelectedOffset, filled: false };
}

function canRetainHistoryPending(pending, pendingBytes, descriptor, emittedMessages, pageSize) {
  return pending.length + emittedMessages < pageSize
    && pendingBytes + descriptor.end - descriptor.start <= HISTORY_PENDING_BYTES;
}
function pendingHistoryLength(pending) { return pending.reduce((total, descriptor) => total + descriptor.end - descriptor.start, 0); }
function rememberHistoryPresentation(resolved, emitted, openTurnIds, terminalTurnIds) {
  if (emitted === 0) return;
  if (["completed", "failed", "interrupted"].includes(resolved.status)) terminalTurnIds.push(resolved.turnId);
  else openTurnIds.push(resolved.turnId);
}
function finishHistoryPage(messages, openTurnIds, terminalTurnIds, nextCursor) {
  messages.sort((left, right) => left.itemOrder - right.itemOrder);
  const page = {
    messages, hasOlder: nextCursor !== undefined, ...(nextCursor ? { nextCursor } : {}),
    openTurnIds: [...new Set(openTurnIds)], terminalTurnIds: [...new Set(terminalTurnIds)].slice(-50),
  };
  if (Buffer.byteLength(JSON.stringify(page), "utf8") > HISTORY_FRAME_BYTES) throw new Error("Codex history page exceeds the Web UI frame budget");
  return page;
}

async function readReverseHistoryWindow(file, end, skipPartial) {
  const start = Math.max(0, end - HISTORY_SCAN_BYTES);
  const bytes = Buffer.allocUnsafe(end - start);
  const { bytesRead } = await file.read(bytes, 0, bytes.byteLength, start);
  if (bytesRead !== bytes.byteLength) throw new Error("Codex rollout changed during history read");
  const lines = [];
  let boundary = bytes.byteLength;
  let skipped = !skipPartial;
  let resolvedPartialBefore;
  let recordLimited = false;
  for (let index = bytes.byteLength - 1; index >= 0; index -= 1) {
    if (bytes[index] !== 0x0a) continue;
    if (boundary > index + 1) {
      const lineStart = start + index + 1;
      const lineEnd = start + boundary;
      if (skipped) {
        const length = boundary - index - 1;
        lines.push({ start: lineStart, end: lineEnd, ...(length <= HISTORY_PARSE_LINE_BYTES ? { bytes: bytes.subarray(index + 1, boundary) } : {}) });
        if (lines.length >= HISTORY_SCAN_RECORDS) { recordLimited = true; break; }
      } else { skipped = true; resolvedPartialBefore = lineStart; }
    }
    boundary = index;
  }
  if (!recordLimited && start === 0 && boundary > 0 && skipped) {
    lines.push({ start: 0, end: boundary, ...(boundary <= HISTORY_PARSE_LINE_BYTES ? { bytes: bytes.subarray(0, boundary) } : {}) });
  }
  const nextBefore = lines.at(-1)?.start ?? resolvedPartialBefore ?? start;
  return {
    lines, nextBefore, hasMore: recordLimited || start > 0 || nextBefore > 0,
    skipPartial: !recordLimited && start > 0 && lines.length === 0 && resolvedPartialBefore === undefined,
  };
}

async function readPendingHistoryMessage(file, descriptor) {
  const length = descriptor.end - descriptor.start;
  if (length <= 0 || length > HISTORY_PARSE_LINE_BYTES) return undefined;
  const bytes = Buffer.allocUnsafe(length);
  const { bytesRead } = await file.read(bytes, 0, length, descriptor.start);
  if (bytesRead !== length) throw new Error("Codex rollout changed during history read");
  const record = parseHistoryRecord(bytes);
  const payload = objectRecord(record?.payload);
  const at = historyTimestamp(record?.timestamp);
  if (record?.type === "event_msg" && payload?.type === "user_message" && typeof payload.message === "string") return visibleHistoryUser(descriptor.start, payload, at);
  if (record?.type === "response_item" && payload?.type === "message" && payload.role === "assistant") return visibleHistoryAssistant(descriptor.start, payload, at);
  return undefined;
}

function visibleHistoryUser(lineStart, payload, at) {
  const body = truncateHistoryBody(stripHistorySetup(String(payload.message)));
  return body ? { lineStart, role: "you", body, at, ...(nonEmptyText(payload.client_id) ? { clientId: payload.client_id } : {}) } : undefined;
}
function visibleHistoryAssistant(lineStart, payload, at) {
  const body = truncateHistoryBody(historyOutputText(payload.content));
  return body ? {
    lineStart, role: "worker", body, at,
    ...(nonEmptyText(payload.id) ? { nativeId: payload.id } : {}),
    ...(nonEmptyText(payload.phase) ? { phase: payload.phase } : {}),
  } : undefined;
}

function parseHistoryRecord(bytes) {
  if (bytes.byteLength === 0) return undefined;
  try { return objectRecord(JSON.parse(bytes.toString("utf8"))); } catch { return undefined; }
}
function objectRecord(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : undefined; }
function nonEmptyText(value) { return typeof value === "string" && value.length > 0 ? value : undefined; }
function historyOutputText(content) {
  return Array.isArray(content) ? content.flatMap((entry) => entry?.type === "output_text" && typeof entry.text === "string" ? [entry.text] : []).join("").trim() : "";
}
function stripHistorySetup(value) { return value.replace(/^\s*<environment_context>[\s\S]*?<\/environment_context>\s*/iu, "").trim(); }
function truncateHistoryBody(body) {
  const bytes = Buffer.from(body, "utf8");
  if (bytes.byteLength <= 64 * 1024) return body;
  let end = 64 * 1024;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}\n\n[message truncated by Web UI]`;
}
function historyTimestamp(value) { const parsed = typeof value === "string" ? Date.parse(value) : 0; return Number.isFinite(parsed) ? parsed : 0; }
function historyTerminalStatus(type) {
  if (type === "task_complete" || type === "turn_complete") return "completed";
  if (type === "task_failed" || type === "turn_failed") return "failed";
  if (type === "turn_aborted" || type === "task_aborted") return "interrupted";
  return undefined;
}
function rememberHistoryTerminal(terminal, turnId, proof) {
  terminal.delete(turnId); terminal.set(turnId, proof);
  while (terminal.size > HISTORY_CURSOR_TERMINALS) terminal.delete(terminal.keys().next().value);
}
function encodeHistoryCursor(cursor) {
  const encoded = Buffer.from(JSON.stringify({ v: 2, ...cursor }), "utf8").toString("base64url");
  if (encoded.length > HISTORY_CURSOR_BYTES) throw new Error("Codex history cursor exceeds its budget");
  return encoded;
}
function decodeHistoryCursor(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > HISTORY_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("invalid Codex history cursor");
  let cursor;
  try { cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { throw new Error("invalid Codex history cursor"); }
  if ((cursor?.v !== 1 && cursor?.v !== 2) || !DECIMAL.test(cursor.device ?? "") || !DECIMAL.test(cursor.inode ?? "")
    || !Number.isSafeInteger(cursor.before) || cursor.before < 0) throw new Error("invalid Codex history cursor");
  if (cursor.v === 1) return {
    device: cursor.device, inode: cursor.inode, before: cursor.before,
    pending: [], terminals: [], skipPartial: false, pendingSkipped: false,
  };
  const pending = Array.isArray(cursor.pending) ? cursor.pending : [];
  const terminals = Array.isArray(cursor.terminals) ? cursor.terminals : [];
  const resolved = objectRecord(cursor.resolved);
  if (pending.length > 50 || terminals.length > HISTORY_CURSOR_TERMINALS
    || !validHistoryPending(pending)
    || !terminals.every((entry) => objectRecord(entry) && typeof entry.turnId === "string" && entry.turnId.length <= 256
      && ["completed", "failed", "interrupted"].includes(entry.status) && Number.isSafeInteger(entry.at))
    || (cursor.skipPartial !== undefined && typeof cursor.skipPartial !== "boolean")
    || (cursor.pendingSkipped !== undefined && typeof cursor.pendingSkipped !== "boolean")
    || (cursor.activeTurnId !== undefined && (typeof cursor.activeTurnId !== "string"
      || cursor.activeTurnId.length < 1 || cursor.activeTurnId.length > 256))
    || (cursor.resolved !== undefined && (!resolved || pending.length === 0 || cursor.pendingSkipped === true
      || typeof resolved.turnId !== "string" || resolved.turnId.length < 1 || resolved.turnId.length > 256
      || !["completed", "failed", "interrupted", "inProgress"].includes(resolved.status)
      || !Number.isSafeInteger(resolved.at) || resolved.turnOrder !== cursor.before))) {
    throw new Error("invalid Codex history cursor");
  }
  return {
    device: cursor.device, inode: cursor.inode, before: cursor.before, pending, terminals,
    skipPartial: cursor.skipPartial === true, pendingSkipped: cursor.pendingSkipped === true,
    ...(typeof cursor.activeTurnId === "string" ? { activeTurnId: cursor.activeTurnId } : {}),
    ...(resolved ? { resolved } : {}),
  };
}
function validHistoryPending(values) {
  let bytes = 0;
  let previousStart = Number.MAX_SAFE_INTEGER;
  for (const entry of values) {
    if (!objectRecord(entry) || !Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end)
      || entry.start < 0 || entry.end <= entry.start || entry.end > previousStart
      || entry.end - entry.start > HISTORY_PARSE_LINE_BYTES) return false;
    bytes += entry.end - entry.start;
    if (bytes > HISTORY_PENDING_BYTES) return false;
    previousStart = entry.start;
  }
  return true;
}

// ---------------------------------------------------------------------------------------
// Claude transcript ownership scan — a FAITHFUL transliteration of
// `scanLocalClaudeTranscript` (src/sessions/claude-transcript.ts). It reads a Claude
// `<session_id>.jsonl` by byte offset, emitting ONLY per-turn ownership metadata (never
// bodies). It diverges from the Codex parser above in four ways (all intentional, all
// from the local scanner): turn model (user promptSource / assistant stop_reason, not
// event_msg), turn-end = any non-tool_use stop_reason, the open turn always advances the
// cursor (no rewind), and — the sole remote hardening not in the local scanner — a uid
// check on the transcript file. Any change here MUST stay byte-identical to the local
// scanner's RolloutScanResult (enforced by tests/endpoints/ssh-claude-scan.test.ts).

async function scanClaudeTranscripts(value) {
  if (!Array.isArray(value?.requests) || value.requests.length < 1 || value.requests.length > 128) throw new Error("invalid claude transcript scan request");
  if (value.allowMissing !== undefined && value.allowMissing !== true) throw new Error("invalid claude transcript scan request");
  if (value.collectFromStart !== undefined && value.collectFromStart !== true) throw new Error("invalid claude transcript scan request");
  if (value.collectFromStart === true && value.allowMissing !== true) throw new Error("invalid claude transcript scan request");
  const collectFromStart = value.collectFromStart === true;
  return {
    results: await Promise.all(value.requests.map((request) => value.allowMissing === true
      ? scanClaudeTranscriptAllowMissing(request, collectFromStart)
      : scanClaudeTranscript(request, collectFromStart))),
  };
}

async function scanClaudeTranscriptAllowMissing(request, collectFromStart) {
  try { return await scanClaudeTranscript(request, collectFromStart); }
  catch (error) { if (error?.code === "ENOENT") return { missing: true }; throw error; }
}

async function scanClaudeTranscript(request, collectFromStart = false) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await scanClaudeTranscriptSnapshot(request, collectFromStart); }
    catch (error) {
      // Shared sentinel with the Codex scan so the retry harness keys on it identically.
      if (attempt >= 3 || error?.message !== "rollout appended while scanning") throw error;
    }
  }
}

async function scanClaudeTranscriptSnapshot(request, collectFromStart = false) {
  const path = request?.path;
  const threadId = request?.threadId;
  const cursor = request?.cursor;
  const name = typeof path === "string" ? basename(path) : "";
  if (typeof path !== "string" || !isAbsolute(path) || typeof threadId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(threadId) || name !== `${threadId}.jsonl`) throw new Error("invalid claude transcript scan request");
  if (cursor !== undefined && (cursor === null || typeof cursor !== "object" || !DECIMAL.test(cursor.device ?? "")
    || !DECIMAL.test(cursor.inode ?? "") || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)) throw new Error("invalid claude transcript cursor");
  const offset = cursor?.offset ?? 0;
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await file.stat({ bigint: true });
    const uid = process.getuid?.();
    if (!state.isFile() || (uid !== undefined && state.uid !== BigInt(uid)) || state.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid claude transcript file");
    const device = state.dev.toString(10);
    const inode = state.ino.toString(10);
    if (cursor && (cursor.device !== device || cursor.inode !== inode)) throw new Error("claude transcript identity changed");
    if (BigInt(offset) > state.size) throw new Error("claude transcript was truncated");
    const parsed = await parseClaudeTranscriptFile(file, offset, Number(state.size), cursor !== undefined || collectFromStart);
    const after = await file.stat({ bigint: true });
    if (after.dev !== state.dev || after.ino !== state.ino) throw new Error("claude transcript identity changed");
    if (after.size < state.size) throw new Error("claude transcript was truncated");
    if (after.size > state.size) throw new Error("rollout appended while scanning");
    if (after.mtimeNs !== state.mtimeNs) throw new Error("claude transcript changed while scanning");
    return parsed.result({ device, inode, offset });
  } finally { await file.close(); }
}

async function parseClaudeTranscriptFile(file, offset, size, collectStarts) {
  const parser = createClaudeTranscriptParser(offset, collectStarts);
  let position = offset;
  let carry = Buffer.alloc(0);
  let carryStart = offset;
  while (position < size) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - position));
    const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) throw new Error("claude transcript was truncated");
    position += bytesRead;
    const bytes = carry.byteLength === 0 ? chunk.subarray(0, bytesRead) : Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
    let lineStart = 0;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      parser.consume(bytes.subarray(lineStart, index), carryStart + lineStart, carryStart + index + 1);
      lineStart = index + 1;
    }
    carryStart += lineStart;
    carry = Buffer.from(bytes.subarray(lineStart));
    if (carry.byteLength > 64 * 1024 * 1024) throw new Error("claude transcript line exceeds the maximum size");
  }
  return parser;
}

function createClaudeTranscriptParser(baseOffset, collectStarts) {
  const starts = [];
  let current;
  let parsedEnd = baseOffset;
  let malformedOffset;
  function report(turn) {
    if (!collectStarts) return;
    if (starts.length >= 1024) throw new Error("claude transcript scan contains too many turns");
    starts.push(publicClaudeStart(turn));
  }
  function consume(raw, lineStart, lineEnd) {
    parsedEnd = lineEnd;
    if (raw.byteLength === 0) return;
    let value;
    try { value = JSON.parse(raw.toString("utf8")); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Every Claude turn carries a user message, so an already-observed turn is always
      // reported across a malformed boundary (unlike Codex, which gates on sawUserMessage).
      malformedOffset ??= lineStart;
      if (current) report(current);
      current = undefined;
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const type = value.type;
    if (type === "user") {
      // Only a non-empty promptSource marks a genuine turn start; a null-promptSource
      // user row is a tool_result (mid-turn) and must NOT open a new turn.
      const promptSource = value.promptSource;
      if (typeof promptSource !== "string" || promptSource.length === 0) return;
      const promptId = claudeTurnId(value);
      if (!promptId) return;
      if (current) report(current);
      const clientId = extractClaudeClientMarker(value.message);
      current = { turnId: clientId ?? promptId, hasUserMessage: true };
      if (clientId) current.clientId = clientId;
      return;
    }
    if (type === "assistant" && current && isClaudeTurnEnd(value)) {
      report(current);
      current = undefined;
    }
  }
  function result(identity) {
    // An open (interrupted) turn is a real observed turn: report it, surface it as
    // openTurn, and ALWAYS advance the cursor past it (no rewind — mirrors the local scanner).
    if (current) report(current);
    const cursorOffset = malformedOffset === undefined ? parsedEnd : Math.min(parsedEnd, malformedOffset);
    return {
      cursor: { ...identity, offset: cursorOffset },
      starts,
      ...(current ? { openTurn: publicClaudeStart(current) } : {}),
      ...(malformedOffset === undefined ? {} : { malformed: true }),
    };
  }
  return { consume, result };
}

function claudeTurnId(record) {
  if (typeof record.promptId === "string" && record.promptId.length > 0) return record.promptId;
  if (typeof record.uuid === "string" && record.uuid.length > 0) return record.uuid;
  return undefined;
}

// A turn continues only across a tool call (stop_reason "tool_use"); ANY other concrete
// stop_reason terminates it. A null/absent stop_reason leaves the turn open.
function isClaudeTurnEnd(record) {
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const stopReason = message.stop_reason;
  return typeof stopReason === "string" && stopReason.length > 0 && stopReason !== "tool_use";
}

// Extracts ONLY QiYan's own clientId marker from the message content; the body is never returned.
function extractClaudeClientMarker(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
  const content = message.content;
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && typeof block.text === "string") text += `${block.text}\n`;
    }
  }
  const match = CLAUDE_CLIENT_MARKER.exec(text);
  return match ? match[1] : undefined;
}

function publicClaudeStart(turn) {
  return {
    turnId: turn.turnId,
    ...(turn.clientId ? { clientId: turn.clientId } : {}),
    ...(turn.hasUserMessage ? { hasUserMessage: true } : {}),
  };
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
  return state !== undefined && state.startTime === identity.linuxStartTime && state.processGroupId === identity.processGroupId;
}

function processState(pid) {
  let raw;
  try { raw = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return undefined; }
  const close = raw.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = raw.slice(close + 2).trim().split(/\s+/u);
  const processGroupId = Number(fields[2]);
  const startTime = fields[19];
  return Number.isSafeInteger(processGroupId) && processGroupId > 1 && DECIMAL.test(startTime ?? "") ? { processGroupId, startTime } : undefined;
}

function membersOfGroup(processGroupId) {
  const members = [];
  for (const name of readdirSync("/proc")) {
    if (!DECIMAL.test(name)) continue;
    const state = processState(Number(name));
    if (state?.processGroupId === processGroupId) members.push(Number(name));
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

import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rm, stat, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";

const TMUX = ["-L", "qiyan-bot", "-f", "/dev/null"];
const SAFE_PATH = /^\/[A-Za-z0-9_./+-]+$/u;
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const HEX_128 = /^[a-f0-9]{32}$/u;
const DECIMAL = /^\d+$/u;
const MAX_ARGUMENT_BYTES = 64 * 1024;

const operation = process.argv[2];
const encoded = process.argv.slice(3);

try {
  if (operation === "tunnel") {
    await tunnelSocket(decodeJson(encoded, 1));
  } else {
    let result;
    switch (operation) {
    case "preflight": result = preflight(); break;
    case "bootstrap": result = await bootstrap(decodeJson(encoded, 1)); break;
    case "inspect": result = await inspect(decodeJson(encoded, 1)); break;
    case "start": result = await start(decodeJson(encoded, 1)); break;
    case "stop": result = await stop(decodeJson(encoded, 1)); break;
    case "read-file": result = await readFileDescriptor(decodeJson(encoded, 1)); break;
    case "write-file": result = await writeFileDescriptor(decodeJson(encoded, 1)); break;
    case "rollout-scan": result = await scanRollouts(decodeJson(encoded, 1)); break;
    case "workspace": result = await workspace(decodeJson(encoded, 1)); break;
    default: throw new Error("unsupported helper operation");
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch {
  process.stderr.write("qiyan remote helper failed\n");
  process.exitCode = 1;
}

async function tunnelSocket(value) {
  const socketPath = value?.socketPath;
  if (typeof socketPath !== "string" || !socketPath.endsWith("/app-server.sock")) throw new Error("invalid tunnel request");
  const runtimeDir = dirname(socketPath);
  requireRuntimeDir(runtimeDir);
  if (socketPath !== join(runtimeDir, "app-server.sock")) throw new Error("invalid tunnel request");
  const socket = createConnection({ path: socketPath, allowHalfOpen: true });
  await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  await new Promise((resolve, reject) => socket.once("close", resolve).once("error", reject));
}

function decodeJson(values, count) {
  if (values.length !== count || !/^[A-Za-z0-9_-]+$/u.test(values[0] ?? "")) throw new Error("invalid helper arguments");
  const bytes = Buffer.from(values[0], "base64url");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARGUMENT_BYTES) throw new Error("invalid helper arguments");
  return JSON.parse(bytes.toString("utf8"));
}

function preflight() {
  if (process.platform !== "linux") throw new Error("Linux is required");
  const account = userInfo();
  const uid = process.getuid?.();
  const shell = account.shell || process.env.SHELL;
  if (!Number.isSafeInteger(uid) || uid < 1 || !isAbsolute(account.homedir) || !shell || !SAFE_PATH.test(shell)) throw new Error("invalid account environment");
  if (!SAFE_PATH.test(process.execPath)) throw new Error("invalid Node.js executable");
  const check = spawnSync(shell, ["-lc", "command -v codex; command -v tmux; command -v cut; command -v ps; command -v tr; command -v mv; command -v chmod"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  if (check.status !== 0) throw new Error("required remote command is unavailable");
  const paths = check.stdout.split(/\r?\n/u).map((value) => value.trim()).filter((value) => SAFE_PATH.test(value));
  const required = paths.slice(-7);
  const [codexPath, tmuxPath] = required;
  if (required.length !== 7 || !codexPath || !tmuxPath) throw new Error("required remote command is unavailable");
  return { uid, home: account.homedir, shell, codexPath, tmuxPath };
}

async function bootstrap(value) {
  const { runtimeDir, helperBase64, helperSha256, launcherBase64, launcherSha256 } = value ?? {};
  requireRuntimeDir(runtimeDir);
  if (![helperSha256, launcherSha256].every((item) => typeof item === "string" && /^[a-f0-9]{64}$/u.test(item))) throw new Error("invalid asset digest");
  const helper = decodeAsset(helperBase64, helperSha256);
  const launcher = decodeAsset(launcherBase64, launcherSha256);
  await ensurePrivateDirectory(dirname(runtimeDir));
  await ensurePrivateDirectory(runtimeDir);
  await atomicWrite(join(runtimeDir, "qiyan-ssh-helper.mjs"), helper, 0o700);
  await atomicWrite(join(runtimeDir, "qiyan-app-server-launcher.sh"), launcher, 0o700);
  return { installed: true };
}

async function inspect(value) {
  const paths = runtimePaths(value);
  const tmux = await run("tmux", [...TMUX, "has-session", "-t", paths.session], true);
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
  const before = await inspect(value);
  if (before.status === "healthy") return { identity: before.identity };
  if (before.status === "unhealthy") throw new Error("existing runtime is unhealthy");
  await unlink(paths.socketPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  await unlink(paths.identityPath).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  const inner = `exec ${paths.launcherPath} ${value.token} ${paths.socketPath} ${paths.identityPath}`;
  if (![paths.launcherPath, paths.socketPath, paths.identityPath].every((item) => SAFE_PATH.test(item))) throw new Error("unsafe launcher path");
  const command = `${value.shell} -lc '${inner}'`;
  await run("tmux", [...TMUX, "new-session", "-d", "-s", paths.session, command]);
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
  await run("tmux", [...TMUX, "kill-session", "-t", paths.session], true);
  await rm(paths.socketPath, { force: true });
  await rm(paths.identityPath, { force: true });
  return { stopped: true };
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
    if (after.dev !== state.dev || after.ino !== state.ino || after.size !== state.size || after.mtimeNs !== state.mtimeNs) throw new Error("rollout changed while scanning");
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
    if (bytesRead === 0) throw new Error("rollout changed while scanning");
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
  return { turnId: turn.turnId, ...(turn.clientId ? { clientId: turn.clientId } : {}) };
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

function runtimePaths(value) {
  const runtimeDir = value?.runtimeDir;
  const session = value?.session;
  requireRuntimeDir(runtimeDir);
  if (typeof session !== "string" || !SAFE_NAME.test(session)) throw new Error("invalid tmux session");
  return {
    runtimeDir,
    session,
    socketPath: join(runtimeDir, "app-server.sock"),
    identityPath: join(runtimeDir, "identity.json"),
    launcherPath: join(runtimeDir, "qiyan-app-server-launcher.sh"),
  };
}

function requireRuntimeDir(value) {
  if (typeof value !== "string" || value.split("/")[2] !== `qiyan-${process.getuid?.()}` || !/^\/tmp\/qiyan-\d+\/[a-f0-9]{24}$/u.test(value)) throw new Error("invalid runtime directory");
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

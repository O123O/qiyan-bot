import { createHash, randomUUID } from "node:crypto";
import { constants, readdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { chmod, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const TMUX = ["-L", "qiyan-bot", "-f", "/dev/null"];
const SAFE_PATH = /^\/[A-Za-z0-9_./+-]+$/u;
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const HEX_128 = /^[a-f0-9]{32}$/u;
const DECIMAL = /^\d+$/u;
const MAX_ARGUMENT_BYTES = 64 * 1024;

const operation = process.argv[2];
const encoded = process.argv.slice(3);

try {
  let result;
  switch (operation) {
    case "preflight": result = preflight(); break;
    case "bootstrap": result = await bootstrap(decodeJson(encoded, 1)); break;
    case "inspect": result = await inspect(decodeJson(encoded, 1)); break;
    case "start": result = await start(decodeJson(encoded, 1)); break;
    case "stop": result = await stop(decodeJson(encoded, 1)); break;
    default: throw new Error("unsupported helper operation");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
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

function preflight() {
  if (process.platform !== "linux") throw new Error("Linux is required");
  const account = userInfo();
  const uid = process.getuid?.();
  const shell = account.shell || process.env.SHELL;
  if (!Number.isSafeInteger(uid) || uid < 1 || !isAbsolute(account.homedir) || !shell || !SAFE_PATH.test(shell)) throw new Error("invalid account environment");
  const check = spawnSync(shell, ["-lc", "command -v codex; command -v tmux"], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  if (check.status !== 0) throw new Error("required remote command is unavailable");
  const paths = check.stdout.split(/\r?\n/u).map((value) => value.trim()).filter((value) => SAFE_PATH.test(value));
  const codexPath = paths.at(-2);
  const tmuxPath = paths.at(-1);
  if (!codexPath || !tmuxPath) throw new Error("required remote command is unavailable");
  return { uid, home: account.homedir, shell, codexPath, tmuxPath };
}

async function bootstrap(value) {
  const { runtimeDir, helperBase64, helperSha256, launcherBase64, launcherSha256 } = value ?? {};
  requireRuntimeDir(runtimeDir);
  if (![helperSha256, launcherSha256].every((item) => typeof item === "string" && /^[a-f0-9]{64}$/u.test(item))) throw new Error("invalid asset digest");
  const helper = decodeAsset(helperBase64, helperSha256);
  const launcher = decodeAsset(launcherBase64, launcherSha256);
  await mkdir(dirname(runtimeDir), { recursive: true, mode: 0o700 });
  await chmod(dirname(runtimeDir), 0o700);
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(runtimeDir, 0o700);
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
  const groupAlive = identity ? membersOfGroup(identity.processGroupId).length > 0 : false;
  if (tmux.code !== 0) {
    if ((identityFile && !identity) || (!identity && socketFile) || groupAlive) return { status: "unhealthy" };
    return { status: "absent" };
  }
  if (!identity || !identityMatches(identity)) return { status: "unhealthy" };
  if (!socketFile?.isSocket() || socketFile.uid !== process.getuid?.() || (socketFile.mode & 0o077) !== 0) return { status: "unhealthy" };
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
  if (inspected.status === "unhealthy") throw new Error("runtime identity cannot be proven");
  const identity = await readIdentity(paths.identityPath);
  if (identity) {
    if (!identityMatches(identity) && membersOfGroup(identity.processGroupId).length > 0) throw new Error("runtime identity cannot be proven");
    if (membersOfGroup(identity.processGroupId).length > 0) {
      try { process.kill(-identity.processGroupId, "SIGTERM"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
      await waitForEmptyGroup(identity.processGroupId, 2_000);
      if (membersOfGroup(identity.processGroupId).length > 0) {
        try { process.kill(-identity.processGroupId, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
        await waitForEmptyGroup(identity.processGroupId, 2_000);
      }
      if (membersOfGroup(identity.processGroupId).length > 0) throw new Error("runtime process group did not stop");
    }
  }
  await run("tmux", [...TMUX, "kill-session", "-t", paths.session], true);
  await rm(paths.socketPath, { force: true });
  await rm(paths.identityPath, { force: true });
  return { stopped: true };
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
  if (typeof value !== "string" || !/^\/tmp\/qiyan-\d+\/[a-f0-9]{24}$/u.test(value)) throw new Error("invalid runtime directory");
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
  if (value?.kind !== "ssh" || !HEX_128.test(value.token) || !Number.isSafeInteger(value.pid) || value.pid < 2
    || !DECIMAL.test(value.linuxStartTime) || !Number.isSafeInteger(value.processGroupId) || value.processGroupId < 2) return undefined;
  return value;
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

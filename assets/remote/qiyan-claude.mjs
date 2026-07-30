#!/usr/bin/env node
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, readdirSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const SAFE_PATH = /^\/[A-Za-z0-9_./+-]+$/u;
const SAFE_ID = /^[A-Za-z0-9:_.-]{1,256}$/u;
const SAFE_TMUX_NAME = /^[A-Za-z0-9_.-]{1,128}$/u;
const HEX_128 = /^[a-f0-9]{32}$/u;
const MAX_PROMPT_BYTES = 16 * 1024 * 1024;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_MATERIALIZATION_SCAN_BYTES = 128 * 1024 * 1024;
const MATERIALIZATION_SCAN_CHUNK_BYTES = 256 * 1024;

const configPath = requiredPath(process.env.QIYAN_CLAUDE_CONFIG);
const tmuxSocket = requiredPath(process.env.QIYAN_CLAUDE_TMUX_SOCKET);
const pane = requiredPane(process.env.QIYAN_CLAUDE_PANE);
const buffer = requiredTmuxName(process.env.QIYAN_CLAUDE_BUFFER, "qiyan-");
const acknowledgement = requiredTmuxName(process.env.QIYAN_CLAUDE_ACK, "qiyan-");
const dispatchToken = requiredHex(process.env.QIYAN_CLAUDE_DISPATCH_TOKEN);
const runtimeToken = requiredHex(process.env.QIYAN_RUNTIME_TOKEN);

let child;
let liveInstalled = false;
let promptBufferDeleted = false;

try {
  const prompt = await readStdin();
  deletePromptBuffer();
  const config = await readConfig(configPath);
  if (config.threadId !== process.env.QIYAN_CLAUDE_THREAD_ID) throw new Error("Claude thread identity changed");
  const transcriptCursor = createTranscriptCursor(config.home, config.threadId);

  const self = processState(process.pid);
  if (!self || self.processGroupId !== process.pid) throw new Error("qiyan-claude requires its own process group");
  const live = {
    runtimeToken,
    dispatchToken,
    pid: process.pid,
    linuxStartTime: self.startTime,
    processGroupId: self.processGroupId,
    materialized: false,
  };
  setPaneOption("@qiyan_live", Buffer.from(JSON.stringify(live), "utf8").toString("base64url"));
  liveInstalled = true;

  // User input is delivered only over stdin. stdout/stderr are drained by the
  // native Claude process and its authoritative content remains in Claude JSONL.
  child = spawn(config.command, config.args, {
    cwd: config.cwd,
    env: { ...process.env, HOME: config.home },
    shell: false,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(prompt);
  const outcome = new Promise((resolve) => {
    child.once("error", () => resolve({ code: 1 }));
    child.once("close", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0) }));
  });

  let materialization;
  let materializationUncertain = false;
  try {
    materialization = await waitForNativeMaterialization(config.home, config.threadId, transcriptCursor, outcome);
  } catch {
    materializationUncertain = true;
  }
  if (materialization) {
    const materialized = { ...live, ...materialization, materialized: true };
    const encoded = Buffer.from(JSON.stringify(materialized), "utf8").toString("base64url");
    setPaneOption("@qiyan_live", encoded);
    setPaneOption("@qiyan_last", encoded);
    signalTmux(acknowledgement);
  } else if (!materializationUncertain) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  const result = await outcome;
  process.exitCode = materialization ? result.code : 1;
} catch {
  process.exitCode = 1;
} finally {
  if (!promptBufferDeleted) deletePromptBuffer();
  if (liveInstalled) unsetPaneOption("@qiyan_live");
  const release = showPaneOption("@qiyan_release");
  if (release === runtimeToken) {
    try { unlinkSync(configPath); } catch (error) { if (error?.code !== "ENOENT") process.exitCode = 1; }
    unsetPaneOption("@qiyan_release");
    // The pane is a runtime implementation detail. Killing it after cleanup
    // leaves Claude's native transcript untouched for later adoption.
    runTmux(["kill-pane", "-t", pane], true);
  }
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.from(value);
    size += chunk.byteLength;
    if (size > MAX_PROMPT_BYTES) throw new Error("Claude prompt exceeds its bound");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readConfig(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const state = await handle.stat();
    if (!state.isFile() || state.uid !== process.getuid?.() || (state.mode & 0o077) !== 0
      || state.size < 2 || state.size > MAX_CONFIG_BYTES) throw new Error("invalid Claude config");
    const value = JSON.parse(await handle.readFile("utf8"));
    if (value?.version !== 1 || !SAFE_ID.test(value.threadId ?? "")
      || typeof value.cwd !== "string" || !isAbsolute(value.cwd) || resolve(value.cwd) !== value.cwd
      || typeof value.home !== "string" || !isAbsolute(value.home) || resolve(value.home) !== value.home
      || typeof value.command !== "string" || !SAFE_PATH.test(value.command) || !isAbsolute(value.command)
      || !Array.isArray(value.args) || value.args.length > 128
      || value.args.some((item) => typeof item !== "string" || Buffer.byteLength(item) > 64 * 1024)) {
      throw new Error("invalid Claude config");
    }
    return value;
  } finally {
    await handle.close();
  }
}

async function waitForNativeMaterialization(home, threadId, cursor, childOutcome) {
  const deadline = Date.now() + 30_000;
  let childSettled = false;
  void childOutcome.then(() => { childSettled = true; });
  do {
    const materialization = scanNewTranscriptTurn(cursor, home, threadId);
    if (materialization) return materialization;
    if (childSettled) return scanNewTranscriptTurn(cursor, home, threadId);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  } while (Date.now() < deadline);
  return undefined;
}

function createTranscriptCursor(home, threadId) {
  const path = findTranscript(home, threadId);
  if (!path) return { offset: 0, scanned: 0, carry: Buffer.alloc(0) };
  const snapshot = transcriptSnapshot(path);
  if (!snapshot) return { offset: 0, scanned: 0, carry: Buffer.alloc(0) };
  return {
    path,
    device: String(snapshot.dev),
    inode: String(snapshot.ino),
    offset: snapshot.size,
    scanned: 0,
    carry: Buffer.alloc(0),
  };
}

function findTranscript(home, threadId) {
  const root = join(home, ".claude", "projects");
  let dirs;
  try { dirs = readdirSync(root); } catch { return undefined; }
  const name = `${threadId}.jsonl`;
  for (const dir of dirs) {
    const path = join(root, dir, name);
    if (transcriptSnapshot(path)) return path;
  }
  return undefined;
}

function transcriptSnapshot(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const state = fstatSync(fd);
    return state.isFile() && state.uid === process.getuid?.() ? state : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function scanNewTranscriptTurn(cursor, home, threadId) {
  if (!cursor.path) {
    const path = findTranscript(home, threadId);
    if (!path) return false;
    const snapshot = transcriptSnapshot(path);
    if (!snapshot) return false;
    cursor.path = path;
    cursor.device = String(snapshot.dev);
    cursor.inode = String(snapshot.ino);
    cursor.offset = 0;
  }
  let fd;
  try {
    fd = openSync(cursor.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const state = fstatSync(fd);
    if (!state.isFile() || state.uid !== process.getuid?.()
      || String(state.dev) !== cursor.device || String(state.ino) !== cursor.inode
      || state.size < cursor.offset) throw new Error("Claude transcript changed during dispatch");
    while (cursor.offset < state.size) {
      const remainingBudget = MAX_MATERIALIZATION_SCAN_BYTES - cursor.scanned;
      if (remainingBudget <= 0) throw new Error("Claude materialization scan exceeded its bound");
      const length = Math.min(MATERIALIZATION_SCAN_CHUNK_BYTES, remainingBudget, state.size - cursor.offset);
      const bytes = Buffer.alloc(length);
      const read = readSync(fd, bytes, 0, length, cursor.offset);
      if (read <= 0) break;
      cursor.offset += read;
      cursor.scanned += read;
      const combined = Buffer.concat([cursor.carry, bytes.subarray(0, read)]);
      let start = 0;
      for (let index = combined.indexOf(0x0a); index >= 0; index = combined.indexOf(0x0a, start)) {
        const materialization = nativeMaterializationFromLine(combined.subarray(start, index));
        if (materialization) return materialization;
        start = index + 1;
      }
      cursor.carry = Buffer.from(combined.subarray(start));
    }
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function nativeMaterializationFromLine(line) {
  if (line.byteLength === 0) return undefined;
  let value;
  try { value = JSON.parse(line.toString("utf8")); } catch { return undefined; }
  if (!value || typeof value !== "object" || value.type !== "user"
    || typeof value.promptSource !== "string" || value.promptSource.length === 0) return undefined;
  const turnId = typeof value.promptId === "string" && value.promptId.length > 0
    ? value.promptId
    : typeof value.uuid === "string" && value.uuid.length > 0 ? value.uuid : undefined;
  if (!turnId || !SAFE_ID.test(turnId)) return undefined;
  const userItemId = typeof value.uuid === "string" && SAFE_ID.test(value.uuid) ? value.uuid : `${turnId}:user`;
  return { turnId, userItemId };
}

function processState(pid) {
  let raw;
  try { raw = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { return undefined; }
  const close = raw.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = raw.slice(close + 2).trim().split(/\s+/u);
  const processGroupId = Number(fields[2]);
  const startTime = fields[19];
  return Number.isSafeInteger(processGroupId) && processGroupId > 1 && /^\d+$/u.test(startTime ?? "")
    ? { processGroupId, startTime }
    : undefined;
}

function deletePromptBuffer() {
  runTmux(["delete-buffer", "-b", buffer], true);
  promptBufferDeleted = true;
}

function setPaneOption(name, value) {
  runTmux(["set-option", "-p", "-t", pane, name, value]);
}

function unsetPaneOption(name) {
  runTmux(["set-option", "-pu", "-t", pane, name], true);
}

function showPaneOption(name) {
  const result = runTmux(["show-options", "-pqv", "-t", pane, name], true);
  return result.status === 0 ? result.stdout.trim() : "";
}

function signalTmux(name) {
  runTmux(["wait-for", "-S", name]);
}

function runTmux(args, allowFailure = false) {
  const result = spawnSync("tmux", ["-S", tmuxSocket, "-f", "/dev/null", ...args], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  });
  if (!allowFailure && (result.error || result.status !== 0)) throw new Error("tmux operation failed");
  return result;
}

function requiredPath(value) {
  if (typeof value !== "string" || !SAFE_PATH.test(value) || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error("invalid runtime path");
  }
  return value;
}

function requiredTmuxName(value, prefix) {
  if (typeof value !== "string" || !SAFE_TMUX_NAME.test(value) || !value.startsWith(prefix)) {
    throw new Error("invalid tmux identifier");
  }
  return value;
}

function requiredPane(value) {
  if (typeof value !== "string" || !/^%[0-9]+$/u.test(value)) throw new Error("invalid tmux pane");
  return value;
}

function requiredHex(value) {
  if (typeof value !== "string" || !HEX_128.test(value)) throw new Error("invalid runtime token");
  return value;
}

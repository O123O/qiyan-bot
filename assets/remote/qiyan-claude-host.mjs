#!/usr/bin/env node

// src/claude-host/bin.ts
import { pathToFileURL } from "node:url";

// src/core/errors.ts
var AppError = class extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "AppError";
  }
  code;
  details;
};

// package.json
var package_default = {
  name: "qiyan-bot",
  version: "0.9.2",
  type: "module",
  bin: {
    "qiyan-bot": "dist/qiyan-bot"
  },
  files: [
    "dist/qiyan-bot",
    "assets/webui/index.html",
    "assets/brand/qiyan-logo.png",
    "assets/brand/qiyan-overview.svg",
    "assets/assistant/AGENTS.md",
    "assets/assistant/session-status.example.json",
    "assets/endpoints.example.jsonc",
    "assets/remote/qiyan-app-server-launcher.sh",
    "assets/remote/qiyan-claude-host.mjs",
    "assets/remote/qiyan-claude-host-launcher.sh",
    "assets/remote/qiyan-claude.mjs",
    "assets/remote/qiyan-claude-runtime-launcher.sh",
    "assets/remote/qiyan-ssh-helper.mjs",
    "assets/slack/manifest.yaml",
    "docs/chat-apps/wechat.md",
    "docs/sqlite.md",
    "docs/ssh-workers.md"
  ],
  engines: {
    node: ">=24"
  },
  scripts: {
    build: "node scripts/build.mjs",
    prepack: "npm run build",
    start: "tsx src/bin.ts",
    test: "node scripts/run-tests.mjs",
    typecheck: "tsc --noEmit",
    "check:webui": "node scripts/check-webui-asset.mjs",
    check: "npm run typecheck && npm run check:webui && npm test",
    "generate:codex-schema": "node scripts/generate-app-server-schema.mjs",
    "ssh-worker:up": "node --import tsx scripts/ssh-worker.ts up",
    "ssh-worker:login": "node --import tsx scripts/ssh-worker.ts login",
    "ssh-worker:check": "node --import tsx scripts/ssh-worker.ts check",
    "ssh-worker:endpoint-check": "QIYAN_SSH_ENDPOINT_INTEGRATION=1 node scripts/run-tests.mjs tests/integration/ssh-endpoint.test.ts",
    "ssh-worker:down": "node --import tsx scripts/ssh-worker.ts down",
    "ssh-worker:reset": "node --import tsx scripts/ssh-worker.ts reset"
  },
  devDependencies: {
    "@anthropic-ai/claude-agent-sdk": "0.3.220",
    "@modelcontextprotocol/sdk": "1.29.0",
    "@slack/socket-mode": "2.0.7",
    "@slack/web-api": "7.18.0",
    "@types/node": "26.0.1",
    "@types/qrcode-terminal": "0.12.2",
    "@types/ws": "^8.18.1",
    esbuild: "0.28.1",
    "lossless-json": "4.3.0",
    "qrcode-terminal": "0.12.0",
    tsx: "4.22.4",
    typescript: "6.0.3",
    undici: "8.5.0",
    ws: "^8.21.0",
    zod: "4.4.3"
  }
};

// src/version.ts
var APP_VERSION = package_default.version;

// src/claude-host/session.ts
var InputStream = class {
  pending = [];
  waiters = [];
  closed = false;
  push(message) {
    if (this.closed) throw new AppError("SESSION_DETACHED", "claude session input is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.pending.push(message);
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: void 0, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        const ready = this.pending.shift();
        if (ready) return { value: ready, done: false };
        if (this.closed) return { value: void 0, done: true };
        return await new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
};
var ClaudeHostSession = class {
  constructor(sessionId, createQuery, options = {}) {
    this.sessionId = sessionId;
    this.options = options;
    this.query = createQuery(this.input);
    this.drained = this.drain();
  }
  sessionId;
  options;
  input = new InputStream();
  query;
  listeners = /* @__PURE__ */ new Set();
  // Accepted sends that have not yet settled, in submission order. The SDK executes
  // queued messages in order, so the head is the turn a uuid-less result belongs to.
  inFlight = [];
  acceptedUuids = /* @__PURE__ */ new Set();
  backgroundTasks = /* @__PURE__ */ new Map();
  closed = false;
  drained;
  now() {
    return this.options.now?.() ?? Date.now();
  }
  // Accepting a send is what the caller's idempotency key buys: a duplicate uuid is
  // dropped here rather than becoming a second turn. Returns false when it was a
  // duplicate, so the caller can report "already accepted" instead of re-queueing.
  send(uuid, text) {
    if (this.closed) throw new AppError("SESSION_DETACHED", `claude session is closed: ${this.sessionId}`);
    if (this.acceptedUuids.has(uuid)) return false;
    this.acceptedUuids.add(uuid);
    this.inFlight.push({ uuid, startedAt: this.now() });
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      origin: { kind: "human" },
      uuid
    });
    this.emit({ type: "turn/accepted", sessionId: this.sessionId, uuid, at: this.now() });
    return true;
  }
  async interrupt() {
    if (this.closed) return;
    await this.query.interrupt();
  }
  async setModel(model) {
    await this.query.setModel(model);
  }
  // null clears the flag-layer override and falls back to the user's own settings.
  async setEffort(effort) {
    await this.query.applyFlagSettings({ effortLevel: effort ?? null });
  }
  async setPermissionMode(mode) {
    await this.query.setPermissionMode(mode);
  }
  async stopTask(taskId) {
    await this.query.stopTask(taskId);
  }
  async supportedModels() {
    return await this.query.supportedModels();
  }
  async initializationResult() {
    return await this.query.initializationResult();
  }
  status() {
    return {
      sessionId: this.sessionId,
      activity: this.activity(),
      inFlightTurns: this.inFlight.map((turn) => turn.uuid),
      backgroundTasks: [...this.backgroundTasks.entries()].map(([id, task]) => ({
        taskId: id,
        ...task.type === void 0 ? {} : { taskType: task.type },
        startedAt: task.startedAt
      }))
    };
  }
  // Idle means nothing can still produce output: no turn in flight AND no native
  // background task outstanding. Eviction uses the same rule — a session with a live
  // background task must not be unloaded, or the task's result is lost.
  activity() {
    if (this.inFlight.length > 0) return "working";
    return this.backgroundTasks.size > 0 ? "background" : "idle";
  }
  isEvictable() {
    return this.activity() === "idle";
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    this.query.close();
  }
  emit(event) {
    for (const listener of this.listeners) listener(event);
  }
  async drain() {
    try {
      for await (const raw of this.query) {
        this.consume(raw);
      }
    } catch (error) {
      this.emit({
        type: "session/error",
        sessionId: this.sessionId,
        message: error instanceof Error ? error.message : String(error),
        at: this.now()
      });
    } finally {
      for (const turn of this.inFlight.splice(0)) {
        this.emit({
          type: "turn/completed",
          sessionId: this.sessionId,
          origin: "human",
          uuid: turn.uuid,
          status: "interrupted",
          at: this.now()
        });
      }
    }
  }
  consume(message) {
    const type = String(message.type ?? "");
    if (type === "system") {
      this.consumeSystem(message);
      return;
    }
    if (type === "result") {
      this.consumeResult(message);
      return;
    }
    const nested = message.parent_tool_use_id != null;
    if (type === "assistant") {
      this.emit({
        type: nested ? "content/nested" : "content/assistant",
        sessionId: this.sessionId,
        message,
        at: this.now()
      });
      return;
    }
    if (type === "user") return;
  }
  consumeSystem(message) {
    const subtype = String(message.subtype ?? "");
    const taskId = typeof message.task_id === "string" ? message.task_id : void 0;
    if (subtype === "task_started" && taskId) {
      this.backgroundTasks.set(taskId, { startedAt: this.now() });
      this.emit({ type: "task/started", sessionId: this.sessionId, taskId, at: this.now() });
      return;
    }
    if (subtype === "task_notification" && taskId) {
      this.backgroundTasks.delete(taskId);
      this.emit({
        type: "task/settled",
        sessionId: this.sessionId,
        taskId,
        status: String(message.status ?? "completed"),
        at: this.now()
      });
      return;
    }
    if (subtype === "background_tasks_changed") {
      const tasks = Array.isArray(message.tasks) ? message.tasks : [];
      const live = /* @__PURE__ */ new Set();
      for (const task of tasks) {
        const id = typeof task.task_id === "string" ? task.task_id : void 0;
        if (!id) continue;
        live.add(id);
        if (!this.backgroundTasks.has(id)) {
          this.backgroundTasks.set(id, {
            startedAt: this.now(),
            ...typeof task.task_type === "string" ? { type: task.task_type } : {}
          });
        }
      }
      for (const id of [...this.backgroundTasks.keys()]) {
        if (!live.has(id)) this.backgroundTasks.delete(id);
      }
      this.emit({ type: "task/set", sessionId: this.sessionId, taskIds: [...this.backgroundTasks.keys()], at: this.now() });
      return;
    }
    if (subtype === "init") {
      this.emit({ type: "session/init", sessionId: this.sessionId, message, at: this.now() });
    }
  }
  consumeResult(message) {
    const uuid = typeof message.user_message_uuid === "string" ? message.user_message_uuid : void 0;
    const origin = message.origin ?? {};
    const isTaskNotification = origin.kind === "task-notification";
    const failed = message.subtype !== "success";
    if (isTaskNotification) {
      this.emit({
        type: "turn/completed",
        sessionId: this.sessionId,
        origin: "task-notification",
        status: failed ? "failed" : "completed",
        result: message,
        at: this.now()
      });
      return;
    }
    let settled;
    if (uuid) {
      const index = this.inFlight.findIndex((turn) => turn.uuid === uuid);
      if (index >= 0) settled = this.inFlight.splice(index, 1)[0];
    } else if (this.inFlight.length > 0) {
      settled = this.inFlight.shift();
    }
    this.emit({
      type: "turn/completed",
      sessionId: this.sessionId,
      origin: "human",
      status: failed ? message.subtype === "error_during_execution" ? "interrupted" : "failed" : "completed",
      ...settled === void 0 ? {} : { uuid: settled.uuid },
      result: message,
      at: this.now()
    });
  }
};

// src/claude-host/host.ts
var LocalClaudeHost = class {
  // `prepare` resolves everything a session needs (launch options, permission
  // pass-through) before the actor exists, so the actor's constructor stays synchronous
  // and nothing is patched in afterwards.
  constructor(prepare) {
    this.prepare = prepare;
  }
  prepare;
  sessions = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  unsubscribes = /* @__PURE__ */ new Map();
  async open(request) {
    const existing = this.sessions.get(request.sessionId);
    if (existing) return existing.status();
    const session = new ClaudeHostSession(request.sessionId, await this.prepare(request));
    this.sessions.set(request.sessionId, session);
    this.unsubscribes.set(request.sessionId, session.subscribe((event) => {
      for (const listener of this.listeners) listener(event);
    }));
    return session.status();
  }
  async close(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.close();
    await session.drained;
    this.unsubscribes.get(sessionId)?.();
    this.unsubscribes.delete(sessionId);
  }
  async send(sessionId, uuid, text) {
    return this.require(sessionId).send(uuid, text);
  }
  async interrupt(sessionId) {
    await this.require(sessionId).interrupt();
  }
  async status(sessionId) {
    return this.require(sessionId).status();
  }
  async setModel(sessionId, model) {
    await this.require(sessionId).setModel(model);
  }
  async setEffort(sessionId, effort) {
    await this.require(sessionId).setEffort(effort);
  }
  async models(sessionId) {
    return await this.require(sessionId).supportedModels();
  }
  async stopTask(sessionId, taskId) {
    await this.require(sessionId).stopTask(taskId);
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  // Oldest-first among evictable sessions, so the most recently active stay loaded.
  async evictIdle(keep) {
    const evictable = [...this.sessions.entries()].filter(([, session]) => session.isEvictable());
    const excess = this.sessions.size - keep;
    if (excess <= 0) return [];
    const evicted = [];
    for (const [sessionId] of evictable.slice(0, excess)) {
      await this.close(sessionId);
      evicted.push(sessionId);
    }
    return evicted;
  }
  async shutdown() {
    for (const sessionId of [...this.sessions.keys()]) await this.close(sessionId);
  }
  require(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new AppError("UNKNOWN_SESSION", `claude session is not loaded: ${sessionId}`);
    return session;
  }
};

// src/claude-host/requirements.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var run = promisify(execFile);
var MIN_CLAUDE_CLI_VERSION = "2.1.220";
function compareVersions(left, right) {
  const parse = (value) => (value.match(/\d+/gu) ?? []).map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
function parseClaudeVersion(output) {
  return /(\d+\.\d+\.\d+)/u.exec(output)?.[1];
}
async function loadAgentSdk(importer = (specifier) => import(specifier)) {
  try {
    return await importer("@anthropic-ai/claude-agent-sdk");
  } catch (error) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      "the Claude Agent SDK is not installed on this host. Install it alongside qiyan-bot (npm i -g @anthropic-ai/claude-agent-sdk) \u2014 it is a deployment prerequisite, not a bundled dependency, because it carries a platform-specific native binary.",
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
}
async function resolveClaudeCli(executable, options = {}) {
  const exec = options.exec ?? ((file, args) => run(file, args));
  let stdout;
  try {
    ({ stdout } = await exec(executable, ["--version"]));
  } catch (error) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      `the Claude CLI is not runnable at "${executable}". Install Claude Code on this host, or point the endpoint's \`command\` at it.`,
      { cause: error instanceof Error ? error.message : String(error) }
    );
  }
  const version = parseClaudeVersion(stdout);
  if (version === void 0) {
    throw new AppError(
      "CONFIGURATION_ERROR",
      `could not read a version from "${executable} --version" (got ${JSON.stringify(stdout.slice(0, 120))})`
    );
  }
  if (compareVersions(version, MIN_CLAUDE_CLI_VERSION) < 0) {
    throw new AppError(
      "UNSUPPORTED_CAPABILITY",
      `the Claude CLI at "${executable}" is ${version}, below the required ${MIN_CLAUDE_CLI_VERSION}. Upgrade Claude Code on this host.`
    );
  }
  return version;
}
async function checkClaudeRuntimeRequirements(options) {
  const sdk = await loadAgentSdk(options.importer);
  const sdkVersion = typeof sdk.VERSION === "string" ? sdk.VERSION : "unknown";
  const claudeVersion = await resolveClaudeCli(options.claudeExecutable, options);
  return { sdkVersion, claudeVersion, claudeExecutable: options.claudeExecutable };
}

// src/claude-host/permissions.ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
var CLAUDE_PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk"
];
function settingsCandidates(cwd, home) {
  return [
    { path: "/etc/claude-code/managed-settings.json", source: "managed" },
    { path: join(cwd, ".claude", "settings.local.json"), source: "local" },
    { path: join(cwd, ".claude", "settings.json"), source: "project" },
    { path: join(home, ".claude", "settings.json"), source: "user" }
  ];
}
async function readDefaultMode(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return void 0;
  }
  try {
    const parsed = JSON.parse(text);
    const mode = parsed.permissions?.defaultMode;
    return typeof mode === "string" ? mode : void 0;
  } catch {
    return void 0;
  }
}
async function resolveClaudePermissions(cwd, options = {}) {
  const home = options.home ?? homedir();
  for (const candidate of settingsCandidates(cwd, home)) {
    const mode = await readDefaultMode(candidate.path);
    if (mode === void 0) continue;
    if (!CLAUDE_PERMISSION_MODES.includes(mode)) continue;
    const resolved = mode;
    return {
      permissionMode: resolved,
      ...resolved === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {},
      source: candidate.source
    };
  }
  return { permissionMode: "default", source: "none" };
}
function permissionWarning(resolved) {
  if (resolved.permissionMode !== "default") return void 0;
  return "Claude permission mode is 'default', so this worker's tool calls will be denied. Set permissions.defaultMode in ~/.claude/settings.json (bypassPermissions for an unattended worker).";
}

// src/claude-host/sdk-query.ts
async function buildLaunchOptions(request, context) {
  const permissions = await resolveClaudePermissions(request.cwd, {
    ...context.home === void 0 ? {} : { home: context.home }
  });
  const warning = permissionWarning(permissions);
  if (warning) context.onWarning?.(warning);
  return {
    cwd: request.cwd,
    pathToClaudeCodeExecutable: context.claudeExecutable,
    // Mandatory: omitting systemPrompt selects the SDK's minimal prompt instead of Claude
    // Code's. Nothing is appended — the redirect prompt the one-shot design needed is gone
    // along with the QiYan-side schedulers it redirected to.
    systemPrompt: { type: "preset", preset: "claude_code" },
    // settingSources is deliberately omitted: that loads user/project/local settings,
    // CLAUDE.md, skills, agents, commands, and hooks exactly as the CLI does.
    //
    // Permission mode is the one exception, and it is a pass-through of the user's own
    // config rather than a QiYan policy: the SDK does not read permissions.defaultMode
    // from settings files, and bypassPermissions needs an in-process opt-in.
    permissionMode: permissions.permissionMode,
    ...permissions.allowDangerouslySkipPermissions === void 0 ? {} : { allowDangerouslySkipPermissions: permissions.allowDangerouslySkipPermissions },
    // sessionId reserves the caller's UUID as the native session id; resume reopens an
    // existing one. The SDK rejects both together unless forking, which QiYan never wants.
    ...request.mode === "create" ? { sessionId: request.sessionId } : { resume: request.sessionId },
    ...request.model === void 0 ? {} : { model: request.model },
    ...request.effort === void 0 ? {} : { effort: request.effort }
  };
}
function sdkSessionPreparer(query, context) {
  return async (request) => {
    const options = await buildLaunchOptions(request, context);
    return (input) => query({ prompt: input, options });
  };
}

// src/claude-host/transport.ts
import { createServer, connect } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

// src/claude-host/protocol.ts
var CLAUDE_HOST_PROTOCOL_VERSION = 1;
function encodeFrame(frame) {
  return `${JSON.stringify(frame)}
`;
}
function decodeFrames(buffer) {
  const frames = [];
  let rest = buffer;
  let index;
  while ((index = rest.indexOf("\n")) >= 0) {
    const line = rest.slice(0, index).trim();
    rest = rest.slice(index + 1);
    if (!line) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
    }
  }
  return { frames, rest };
}

// src/claude-host/transport.ts
var ClaudeHostServer = class {
  constructor(host, identity) {
    this.host = host;
    this.identity = identity;
  }
  host;
  identity;
  server;
  clients = /* @__PURE__ */ new Set();
  unsubscribe;
  async listen(socketPath) {
    await mkdir(dirname(socketPath), { recursive: true, mode: 448 });
    await rm(socketPath, { force: true });
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, 384);
    this.unsubscribe = this.host.subscribe((event) => this.broadcast(event));
  }
  async close() {
    this.unsubscribe?.();
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    const server = this.server;
    if (!server) return;
    this.server = void 0;
    await new Promise((resolve) => server.close(() => resolve()));
  }
  broadcast(event) {
    const frame = encodeFrame({ id: 0, event });
    for (const socket of this.clients) socket.write(frame);
  }
  accept(socket) {
    this.clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) void this.handle(socket, frame);
    });
    const drop = () => {
      this.clients.delete(socket);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  }
  async handle(socket, frame) {
    if (!frame.request) return;
    try {
      const result = await this.invoke(frame.request);
      socket.write(encodeFrame({ id: frame.id, result }));
    } catch (error) {
      const code = error instanceof AppError ? error.code : "OPERATION_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      socket.write(encodeFrame({ id: frame.id, error: { code, message } }));
    }
  }
  async invoke(request) {
    switch (request.method) {
      case "host/status":
        return await this.status();
      case "open":
        return await this.host.open(request.params[0]);
      case "close":
        return await this.host.close(request.params[0]);
      case "send":
        return await this.host.send(request.params[0], request.params[1], request.params[2]);
      case "interrupt":
        return await this.host.interrupt(request.params[0]);
      case "status":
        return await this.host.status(request.params[0]);
      case "setModel":
        return await this.host.setModel(request.params[0], request.params[1]);
      case "setEffort":
        return await this.host.setEffort(request.params[0], request.params[1]);
      case "models":
        return await this.host.models(request.params[0]);
      case "stopTask":
        return await this.host.stopTask(request.params[0], request.params[1]);
      case "evictIdle":
        return await this.host.evictIdle(request.params[0]);
      case "shutdown":
        return await this.host.shutdown();
      default: {
        const unknown = request;
        throw new AppError("UNSUPPORTED_CAPABILITY", `claude host does not implement ${unknown.method}`);
      }
    }
  }
  async status() {
    return {
      protocolVersion: CLAUDE_HOST_PROTOCOL_VERSION,
      ...this.identity,
      capabilities: ["sessions", "events", "eviction"],
      sessions: []
    };
  }
};

// src/claude-host/bin.ts
function parseClaudeHostArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    const found = index < 0 ? void 0 : argv[index + 1];
    if (found === void 0 || found.startsWith("--")) {
      throw new AppError("CONFIGURATION_ERROR", `qiyan-claude-host requires ${name} <path>`);
    }
    return found;
  };
  return { socketPath: value("--socket"), claudeExecutable: value("--claude"), sdkPath: value("--sdk") };
}
async function serveClaudeHost(options) {
  const importer = () => import(pathToFileURL(options.sdkPath).href);
  const requirements = await checkClaudeRuntimeRequirements({
    claudeExecutable: options.claudeExecutable,
    importer
  });
  const sdk = await loadAgentSdk(importer);
  const host = new LocalClaudeHost(sdkSessionPreparer(sdk.query, {
    claudeExecutable: options.claudeExecutable,
    // Every session's permission mode is the user's own; a host-wide warning has no
    // client to reach from here, so it stays in the launcher's log.
    onWarning: (message) => process.stderr.write(`qiyan-claude-host: ${message}
`)
  }));
  const server = new ClaudeHostServer(host, {
    hostBuild: APP_VERSION,
    sdkVersion: requirements.sdkVersion,
    claudeVersion: requirements.claudeVersion,
    // The runtime token is what the supervisor uses to prove this process is the one it
    // started, so it is also the generation a reconnecting backend compares against.
    runtimeGeneration: process.env.QIYAN_RUNTIME_TOKEN ?? ""
  });
  await server.listen(options.socketPath);
  const drain = () => {
    void (async () => {
      await host.shutdown().catch(() => void 0);
      await server.close().catch(() => void 0);
      process.exit(0);
    })();
  };
  process.once("SIGTERM", drain);
  process.once("SIGINT", drain);
  return server;
}
if (process.argv[1] !== void 0 && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void serveClaudeHost(parseClaudeHostArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`qiyan-claude-host: ${error instanceof Error ? error.message : String(error)}
`);
    process.exit(1);
  });
}
export {
  parseClaudeHostArgs,
  serveClaudeHost
};

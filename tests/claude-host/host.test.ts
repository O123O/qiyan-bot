import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { LocalClaudeHost, type OpenSessionRequest } from "../../src/claude-host/host.ts";
import { buildLaunchOptions, sdkSessionPreparer } from "../../src/claude-host/sdk-query.ts";
import type { HostEvent } from "../../src/claude-host/protocol.ts";
import type { SessionInput, SessionQuery } from "../../src/claude-host/session.ts";

class FakeQuery implements SessionQuery {
  readonly received: SessionInput[] = [];
  closed = false;
  private readonly pending: unknown[] = [];
  private readonly waiters: Array<(value: IteratorResult<unknown>) => void> = [];
  private ended = false;

  constructor(input: AsyncIterable<SessionInput>) {
    void (async () => { for await (const message of input) this.received.push(message); })();
  }

  push(message: Record<string, unknown>): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.pending.push(message);
  }

  async interrupt(): Promise<unknown> { return undefined; }
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async stopTask(): Promise<void> {}
  async supportedModels(): Promise<unknown[]> { return [{ value: "opus" }]; }
  async initializationResult(): Promise<unknown> { return {}; }
  close(): void {
    this.closed = true;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: async (): Promise<IteratorResult<unknown>> => {
        const ready = this.pending.shift();
        if (ready !== undefined) return { value: ready, done: false };
        if (this.ended) return { value: undefined, done: true };
        return await new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function makeHost(): { host: LocalClaudeHost; queries: Map<string, FakeQuery>; events: HostEvent[] } {
  const queries = new Map<string, FakeQuery>();
  const host = new LocalClaudeHost(async (request) => (input) => {
    const query = new FakeQuery(input);
    queries.set(request.sessionId, query);
    return query;
  });
  const events: HostEvent[] = [];
  host.subscribe((event) => events.push(event));
  return { host, queries, events };
}

const request = (sessionId: string): OpenSessionRequest =>
  ({ sessionId, mode: "create", cwd: "/tmp/x" });

test("opening is idempotent and does not replace a live session", async () => {
  const { host, queries } = makeHost();
  await host.open(request("s1"));
  const first = queries.get("s1");
  await host.open(request("s1"));
  assert.equal(queries.get("s1"), first, "a second open reuses the loaded session");
  assert.equal(first!.closed, false);
  await host.shutdown();
});

test("events from every session reach one host-level subscriber", async () => {
  const { host, events } = makeHost();
  await host.open(request("s1"));
  await host.open(request("s2"));
  await host.send("s1", "u1", "hello");
  await host.send("s2", "u2", "hello");
  await delay(5);
  assert.deepEqual(
    events.filter((event) => event.type === "turn/accepted").map((event) => event.sessionId),
    ["s1", "s2"]);
  await host.shutdown();
});

test("operating on an unloaded session names it rather than failing obscurely", async () => {
  const { host } = makeHost();
  await assert.rejects(host.send("missing", "u1", "hi"), /not loaded: missing/u);
  await assert.rejects(host.status("missing"), /not loaded: missing/u);
});

test("closing a session stops forwarding its events", async () => {
  const { host, queries, events } = makeHost();
  await host.open(request("s1"));
  const query = queries.get("s1")!;
  await host.close("s1");
  assert.equal(query.closed, true);
  const before = events.length;
  query.push({ type: "assistant", parent_tool_use_id: null, message: { content: [] } });
  await delay(5);
  assert.equal(events.length, before, "a closed session's late output is not republished");
});

// Eviction must never unload a session that can still produce output, or its result is
// lost with no way to recover it from the live stream.
test("eviction spares working and background sessions", async () => {
  const { host, queries } = makeHost();
  for (const id of ["idle1", "working", "background", "idle2"]) await host.open(request(id));
  await host.send("working", "u1", "run");
  queries.get("background")!.push({ type: "system", subtype: "task_started", task_id: "t1" });
  await delay(5);

  const evicted = await host.evictIdle(1);
  assert.deepEqual(evicted.sort(), ["idle1", "idle2"], "only genuinely idle sessions are unloaded");
  assert.equal((await host.status("working")).activity, "working");
  assert.equal((await host.status("background")).activity, "background");
  await host.shutdown();
});

test("eviction is a no-op when the loaded count is within budget", async () => {
  const { host } = makeHost();
  await host.open(request("s1"));
  assert.deepEqual(await host.evictIdle(4), []);
  await host.shutdown();
});

// The launch options are the whole "a managed session is an ordinary Claude Code session"
// decision. Pin them, because a silent change here changes worker behaviour everywhere.
async function workspace(mode: string | undefined): Promise<{ cwd: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-launch-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
  if (mode !== undefined) {
    await writeFile(join(home, ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: mode } }));
  }
  return { cwd, home };
}

test("a created session launches as an ordinary Claude Code session", async () => {
  const { cwd, home } = await workspace("bypassPermissions");
  const options = await buildLaunchOptions(
    { sessionId: "abc", mode: "create", cwd },
    { claudeExecutable: "/usr/local/bin/claude", home });

  assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code" },
    "the claude_code preset is mandatory — omitting it selects the SDK's minimal prompt");
  assert.equal("append" in (options.systemPrompt as object), false, "nothing is appended");
  assert.equal(options.settingSources, undefined,
    "omitted so user/project/local settings, CLAUDE.md, skills, agents and hooks all load");
  assert.equal(options.allowedTools, undefined, "no tool allow-list");
  assert.equal(options.disallowedTools, undefined, "no tool deny-list");
  assert.equal(options.mcpServers, undefined, "no injected MCP servers");
  assert.equal(options.pathToClaudeCodeExecutable, "/usr/local/bin/claude",
    "the host's installed CLI, not the SDK's vendored copy");
  assert.equal(options.sessionId, "abc");
  assert.equal(options.resume, undefined, "sessionId and resume are mutually exclusive");
  assert.equal(options.permissionMode, "bypassPermissions");
  assert.equal(options.allowDangerouslySkipPermissions, true);
});

test("a resumed session reopens by id and never sets sessionId", async () => {
  const { cwd, home } = await workspace("acceptEdits");
  const options = await buildLaunchOptions(
    { sessionId: "abc", mode: "resume", cwd, model: "opus" },
    { claudeExecutable: "claude", home });
  assert.equal(options.resume, "abc");
  assert.equal(options.sessionId, undefined);
  assert.equal(options.forkSession, undefined, "resuming must not fork the native session");
  assert.equal(options.model, "opus");
  assert.equal(options.allowDangerouslySkipPermissions, undefined,
    "the dangerous opt-in rides only with bypassPermissions");
});

test("an unconfigured workspace warns that tools will be denied", async () => {
  const { cwd, home } = await workspace(undefined);
  const warnings: string[] = [];
  const options = await buildLaunchOptions(
    { sessionId: "abc", mode: "create", cwd },
    { claudeExecutable: "claude", home, onWarning: (message) => warnings.push(message) });
  assert.equal(options.permissionMode, "default");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /denied/u);
});

test("the preparer builds a query with the resolved options", async () => {
  const { cwd, home } = await workspace("bypassPermissions");
  let seen: unknown;
  const prepare = sdkSessionPreparer(({ prompt, options }) => {
    seen = options;
    return new FakeQuery(prompt);
  }, { claudeExecutable: "claude", home });

  const host = new LocalClaudeHost(prepare);
  await host.open({ sessionId: "abc", mode: "create", cwd });
  assert.equal((seen as { permissionMode: string }).permissionMode, "bypassPermissions");
  assert.equal((seen as { cwd: string }).cwd, cwd);
  await host.shutdown();
});

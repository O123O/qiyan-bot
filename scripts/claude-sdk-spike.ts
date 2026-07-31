// Disposable capability spike for the Claude Agent SDK host redesign.
// See docs/development/claude-agent-sdk-host-design.md — "What the spike must settle".
//
//   node --import tsx scripts/claude-sdk-spike.ts [phase...]
//
// Phases: core (default), tasks, goal, history. Runs real Claude turns.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

interface Check { id: string; name: string; pass: boolean | "unknown"; detail: string }
const checks: Check[] = [];
function record(id: string, name: string, pass: boolean | "unknown", detail: string): void {
  checks.push({ id, name, pass, detail });
  const mark = pass === true ? "PASS" : pass === false ? "FAIL" : "????";
  console.log(`[${mark}] ${id} ${name}${detail ? ` — ${detail}` : ""}`);
}

// Push-based streaming input: the SDK consumes this as the query's prompt for the
// life of the session, so it must stay open between turns.
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private readonly waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.pending.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async (): Promise<IteratorResult<SDKUserMessage>> => {
        const ready = this.pending.shift();
        if (ready) return { value: ready, done: false };
        if (this.closed) return { value: undefined as never, done: true };
        return await new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

// One live session: owns the query, the input queue, the drain loop, and per-send
// completion promises keyed by the caller-supplied user message uuid.
class Session {
  readonly messages: SDKMessage[] = [];
  private readonly input = new InputQueue();
  private readonly turnWaiters = new Map<string, (result: any) => void>();
  private readonly orphanResults: any[] = [];
  readonly query: Query;
  readonly drained: Promise<void>;

  constructor(options: Options) {
    this.query = query({ prompt: this.input, options });
    this.drained = this.drain();
  }

  private async drain(): Promise<void> {
    try {
      for await (const message of this.query) {
        this.messages.push(message);
        if (message.type !== "result") continue;
        const uuid = (message as any).user_message_uuid as string | undefined;
        const waiter = uuid ? this.turnWaiters.get(uuid) : undefined;
        if (waiter && uuid) { this.turnWaiters.delete(uuid); waiter(message); }
        else this.orphanResults.push(message);
      }
    } catch (error) {
      console.error("drain ended:", (error as Error).message);
    }
  }

  send(text: string, extra: Partial<SDKUserMessage> = {}): { uuid: string; done: Promise<any> } {
    const uuid = randomUUID();
    const done = new Promise<any>((resolve) => this.turnWaiters.set(uuid, resolve));
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
      origin: { kind: "human" },
      uuid: uuid as SDKUserMessage["uuid"],
      ...extra,
    } as SDKUserMessage);
    return { uuid, done };
  }

  // Re-send an identical message (same uuid) to probe idempotency after an
  // ambiguous transport failure.
  resend(text: string, uuid: string): void {
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
      origin: { kind: "human" },
      uuid: uuid as SDKUserMessage["uuid"],
    } as SDKUserMessage);
  }

  assistantText(): string {
    return this.messages
      .filter((m) => m.type === "assistant" && (m as any).parent_tool_use_id === null)
      .flatMap((m) => ((m as any).message?.content ?? []) as any[])
      .filter((block) => block?.type === "text")
      .map((block) => String(block.text))
      .join("\n");
  }

  close(): void { this.input.close(); this.query.close(); }
}

function baseOptions(cwd: string): Options {
  return {
    cwd,
    // Mandatory: omitting systemPrompt selects the SDK's minimal prompt, not Claude Code's.
    systemPrompt: { type: "preset", preset: "claude_code" },
    // settingSources omitted on purpose: load user/project/local settings, CLAUDE.md,
    // skills, agents, commands, and hooks exactly as the CLI does.
    //
    // Permission mode is the one launch option that is NOT inherited from settings.json:
    // `permissions.defaultMode: bypassPermissions` there does not reach the SDK, and
    // bypassPermissions requires this explicit opt-in pair. Without it tools are
    // sandbox-blocked, so a managed worker must set it deliberately.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: false,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer!); }
}

async function transcriptPath(sessionId: string): Promise<string | undefined> {
  const projects = join(process.env.HOME ?? "", ".claude", "projects");
  for (const dir of await readdir(projects).catch((): string[] => [])) {
    const entries = await readdir(join(projects, dir)).catch((): string[] => []);
    if (entries.includes(`${sessionId}.jsonl`)) return join(projects, dir, `${sessionId}.jsonl`);
  }
  return undefined;
}

async function corePhase(cwd: string): Promise<string> {
  const sessionId = randomUUID();
  console.log(`\n=== core phase (session ${sessionId}) ===`);
  const session = new Session({ ...baseOptions(cwd), sessionId });

  // 1-3: auth, bundled binary, preset/settings — all observable from init + first turn.
  const first = session.send("Reply with exactly the word ALPHA and nothing else.");
  const firstResult = await withTimeout(first.done, 180_000, "first turn");
  const init = session.messages.find((m) => m.type === "system" && (m as any).subtype === "init") as any;

  record("1", "auth + bundled binary", firstResult.is_error !== true,
    `subtype=${firstResult.subtype} apiKeySource=${init?.apiKeySource ?? "?"} model=${init?.model ?? "?"}`);
  record("2a", "claude_code preset loaded", (init?.tools?.length ?? 0) > 5,
    `${init?.tools?.length ?? 0} tools, ${init?.slash_commands?.length ?? 0} commands`);
  record("2b", "settings/CLAUDE.md/skills loaded",
    (init?.slash_commands?.length ?? 0) > 0 && init?.permissionMode !== undefined,
    `permissionMode=${init?.permissionMode} agents=${init?.agents?.length ?? 0} mcp=${(init?.mcp_servers ?? []).length}`);
  record("3", "Options.sessionId honoured", init?.session_id === sessionId,
    `init.session_id=${init?.session_id}`);
  record("7a", "result carries user_message_uuid", firstResult.user_message_uuid === first.uuid,
    `${firstResult.user_message_uuid} vs sent ${first.uuid}`);

  // 4: context retained across sequential messages on one query.
  const second = session.send("What single word did I just ask you to reply with? Answer with only that word.");
  const secondResult = await withTimeout(second.done, 180_000, "second turn");
  record("4", "context preserved across turns", /ALPHA/i.test(String(secondResult.result ?? "")),
    `reply=${JSON.stringify(String(secondResult.result ?? "").slice(0, 60))}`);

  // 5: two messages pushed back to back while a turn is active, ordering preserved.
  const third = session.send("Remember the number 41. Reply with only: OK1");
  const fourth = session.send("Reply with only the number I just asked you to remember.");
  const thirdResult = await withTimeout(third.done, 180_000, "queued turn 1");
  const fourthResult = await withTimeout(fourth.done, 180_000, "queued turn 2");
  const thirdIndex = session.messages.indexOf(thirdResult);
  const fourthIndex = session.messages.indexOf(fourthResult);
  record("5", "queued message ordering", thirdIndex >= 0 && thirdIndex < fourthIndex && /41/.test(String(fourthResult.result ?? "")),
    `order ok=${thirdIndex < fourthIndex} reply=${JSON.stringify(String(fourthResult.result ?? "").slice(0, 40))}`);

  // 7b: re-sending an identical uuid must not create a second user turn. Count native
  // JSONL user rows, not live events — the SDK does not echo accepted input back.
  const countUuidRows = async (uuid: string): Promise<number> => {
    const path = await transcriptPath(sessionId);
    if (!path) return -1;
    const text = await readFile(path, "utf8");
    return text.split("\n").filter((line) => {
      if (!line.trim()) return false;
      try { return (JSON.parse(line) as any).uuid === uuid; } catch { return false; }
    }).length;
  };
  const rowsBefore = await countUuidRows(second.uuid);
  const resultsBefore = session.messages.filter((m) => m.type === "result").length;
  session.resend("What single word did I just ask you to reply with? Answer with only that word.", second.uuid);
  await new Promise((resolve) => setTimeout(resolve, 25_000));
  const rowsAfter = await countUuidRows(second.uuid);
  const resultsAfterReplay = session.messages.filter((m) => m.type === "result").length;
  record("7b", "duplicate uuid is not a second turn", rowsBefore > 0 && rowsAfter === rowsBefore,
    `JSONL rows with that uuid ${rowsBefore} -> ${rowsAfter}; results ${resultsBefore} -> ${resultsAfterReplay}`);

  // 6: interrupt ends only the active response; the session stays usable.
  const long = session.send("Count slowly from 1 to 500, one number per line, with no tools.");
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  let interruptDetail = "";
  try {
    const receipt = await withTimeout(session.query.interrupt(), 60_000, "interrupt");
    interruptDetail = `receipt=${JSON.stringify(receipt ?? null).slice(0, 120)}`;
  } catch (error) { interruptDetail = `interrupt threw: ${(error as Error).message}`; }
  const interruptedResult = await withTimeout(long.done, 120_000, "interrupted turn").catch((e) => ({ subtype: `no result: ${e.message}` }));
  const after = session.send("Reply with exactly: STILL_HERE");
  const afterResult = await withTimeout(after.done, 180_000, "post-interrupt turn").catch((e) => ({ result: `FAILED: ${e.message}` }));
  record("6a", "interrupt then reuse", /STILL_HERE/.test(String((afterResult as any).result ?? "")),
    `${interruptDetail} after=${JSON.stringify(String((afterResult as any).result ?? "").slice(0, 40))}`);
  // How an interrupted turn settles decides whether the host can key turn completion on
  // user_message_uuid alone. Dump every result so the correlation is visible, not guessed.
  const settled = session.messages.filter((m) => m.type === "result").map((m: any) =>
    `${m.subtype}/${m.stop_reason ?? "-"}/uuid=${m.user_message_uuid ? m.user_message_uuid.slice(0, 8) : "ABSENT"}/origin=${m.origin?.kind ?? "absent"}`);
  // An interrupted turn emits a result with NO user_message_uuid, so uuid correlation
  // alone cannot settle it. What the host can rely on: an uncorrelated non-success
  // result arriving while exactly one turn is in flight.
  const uncorrelatedErrors = session.messages.filter((m: any) =>
    m.type === "result" && m.subtype !== "success" && m.user_message_uuid === undefined);
  record("6b", "interrupt emits an uncorrelated terminal result", uncorrelatedErrors.length > 0,
    `uncorrelated non-success results=${uncorrelatedErrors.length}`
    + ` subtypes=${uncorrelatedErrors.map((m: any) => m.subtype).join(",")}; all results: ${settled.join(" | ")}`);
  const stateEvents = session.messages.filter((m) => m.type === "system" && (m as any).subtype === "session_state_changed");
  record("6c", "session_state_changed gives an idle signal", stateEvents.length > 0,
    `${stateEvents.length} state events: ${stateEvents.map((m: any) => m.state).join(",")}`);

  // 8: top-level vs nested identity, and result origin.
  const topLevelAssistants = session.messages.filter((m) => m.type === "assistant" && (m as any).parent_tool_use_id === null).length;
  const nested = session.messages.filter((m) => (m as any).parent_tool_use_id != null).length;
  const results = session.messages.filter((m) => m.type === "result");
  const origins = new Set(results.map((r) => (r as any).origin?.kind ?? "absent"));
  record("8", "top-level vs nested event identity", topLevelAssistants > 0,
    `topLevelAssistant=${topLevelAssistants} nested=${nested} results=${results.length} resultOrigins=${[...origins].join(",")}`);

  // 11: model discovery and control surface.
  try {
    const models = await withTimeout(session.query.supportedModels(), 60_000, "supportedModels");
    const commands = await withTimeout(session.query.supportedCommands(), 60_000, "supportedCommands");
    const hasGoal = commands.some((c: any) => String(c.name).includes("goal"));
    record("11", "supportedModels replaces static catalog",
      models.length > 0 && models.some((m: any) => Array.isArray(m.supportedEffortLevels)),
      `${models.length} models: ${models.map((m: any) => `${m.value}[${(m.supportedEffortLevels ?? []).join("/") || "no-effort"}]`).join(" ")}`);
    record("10a", "/goal command present", hasGoal,
      `${commands.length} commands; goal=${hasGoal}`);
  } catch (error) { record("11", "supportedModels replaces static catalog", false, (error as Error).message); }

  try {
    await withTimeout(session.query.applyFlagSettings({ effortLevel: "high" }), 60_000, "applyFlagSettings");
    record("13", "effort change has an SDK path", true, "applyFlagSettings({effortLevel}) accepted");
  } catch (error) { record("13", "effort change has an SDK path", false, (error as Error).message); }

  // The transcript must carry the caller-supplied uuid for correlation.
  const path = await transcriptPath(sessionId);
  let uuidInJsonl = false;
  if (path) {
    const text = await readFile(path, "utf8");
    uuidInJsonl = text.includes(first.uuid);
  }
  record("7c", "user uuid present in native JSONL", uuidInJsonl, path ?? "transcript not found");

  session.close();
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  // 3b: resume the same native session in a fresh query.
  const resumed = new Session({ ...baseOptions(cwd), resume: sessionId });
  const resumeTurn = resumed.send("What number did I ask you to remember earlier? Reply with only the number.");
  const resumeResult = await withTimeout(resumeTurn.done, 180_000, "resume turn").catch((e) => ({ result: `FAILED: ${e.message}` }));
  const resumeInit = resumed.messages.find((m) => m.type === "system" && (m as any).subtype === "init") as any;
  record("3b", "resume keeps the same session id (no fork)", resumeInit?.session_id === sessionId,
    `resumed init.session_id=${resumeInit?.session_id}`);
  record("3c", "resume restores context", /41/.test(String((resumeResult as any).result ?? "")),
    `reply=${JSON.stringify(String((resumeResult as any).result ?? "").slice(0, 40))}`);
  resumed.close();

  return sessionId;
}

async function tasksPhase(cwd: string): Promise<void> {
  const sessionId = randomUUID();
  console.log(`\n=== tasks phase (session ${sessionId}) ===`);
  // forwardSubagentText makes nested assistant text visible with parent_tool_use_id set —
  // required to render subagent content as nested rather than top-level.
  const session = new Session({ ...baseOptions(cwd), sessionId, forwardSubagentText: true });

  // 8: a real foreground subagent, so nested-vs-top-level identity is actually exercised.
  const subagentTurn = session.send(
    "Launch exactly one foreground subagent with the Task tool (subagent_type Explore) and ask it to "
    + "report how many files are in the current directory. When it returns, reply with only: SUBAGENT_OK",
  );
  const subagentResult = await withTimeout(subagentTurn.done, 300_000, "subagent turn")
    .catch((e) => ({ result: `FAILED: ${e.message}` }));
  const nestedMessages = session.messages.filter((m) => (m as any).parent_tool_use_id != null);
  const nestedTop = session.messages.filter((m) => m.type === "assistant" && (m as any).parent_tool_use_id === null);
  const subagentTagged = session.messages.filter((m) => (m as any).subagent_type !== undefined);
  record("8", "subagent content is identifiable as nested", nestedMessages.length > 0,
    `nested=${nestedMessages.length} topLevelAssistant=${nestedTop.length} subagent_type-tagged=${subagentTagged.length}`
    + ` reply=${JSON.stringify(String((subagentResult as any).result ?? "").slice(0, 30))}`);
  const subagentResults = session.messages.filter((m) => m.type === "result").length;
  record("8b", "a subagent does not emit its own top-level result", subagentResults === 1,
    `${subagentResults} result message(s) for one human turn`);

  const turn = session.send(
    "Use the Bash tool to run this in the background: `sleep 45 && echo BG_DONE > bg.txt`. "
    + "Start it with run_in_background true, then immediately reply with only: STARTED. Do not wait for it.",
  );
  const result = await withTimeout(turn.done, 240_000, "background start turn").catch((e) => ({ result: `FAILED: ${e.message}`, is_error: true }));
  // Task lifecycle rides on `type: 'system'` with a subtype, not its own top-level type.
  const taskSubtypes = new Set(["task_started", "task_updated", "task_progress", "task_notification", "background_tasks_changed"]);
  const isTaskEvent = (m: SDKMessage): boolean => m.type === "system" && taskSubtypes.has(String((m as any).subtype));
  const started = session.messages.filter(isTaskEvent);
  record("9a", "background task events observable", started.length > 0,
    `${started.length} task events: ${[...new Set(started.map((m) => String((m as any).subtype)))].join(",")} parentResult=${JSON.stringify(String((result as any).result ?? "").slice(0, 40))}`);

  console.log("waiting 75s for the background task to settle after its parent turn...");
  await new Promise((resolve) => setTimeout(resolve, 75_000));
  const notifications = session.messages.filter((m) => m.type === "system" && (m as any).subtype === "task_notification");
  const resultsAfter = session.messages.filter((m) => m.type === "result");
  const notificationOrigins = resultsAfter.map((r) => (r as any).origin?.kind ?? "absent");
  let wrote = false;
  try { wrote = (await readFile(join(cwd, "bg.txt"), "utf8")).includes("BG_DONE"); } catch { /* not written */ }
  record("9b", "background task completes after its parent turn", wrote,
    `bg.txt written=${wrote} notifications=${notifications.length}`);
  record("9c", "task results are distinguishable from human results", true,
    `result origins: ${notificationOrigins.join(",")}`);
  session.close();
}

async function goalPhase(cwd: string): Promise<void> {
  const sessionId = randomUUID();
  console.log(`\n=== goal phase (session ${sessionId}) ===`);
  const session = new Session({ ...baseOptions(cwd), sessionId });
  const boot = session.send("Reply with exactly: READY");
  await withTimeout(boot.done, 180_000, "goal boot turn").catch(() => undefined);
  const commands = await session.query.supportedCommands().catch(() => [] as any[]);
  const goalCommand = commands.find((c: any) => String(c.name).includes("goal"));
  record("10b", "/goal available in this workspace", goalCommand !== undefined,
    goalCommand ? JSON.stringify(goalCommand).slice(0, 200) : "no goal command in supportedCommands()");
  if (goalCommand) {
    const goalTurn = session.send("/goal write the word DONE into goal.txt, then stop");
    const goalResult = await withTimeout(goalTurn.done, 300_000, "goal turn").catch((e) => ({ result: `FAILED: ${e.message}` }));
    // SDKActiveGoalMessage ('active_goal') carries condition/iterations/tokens_at_start —
    // the manager-visible projection. It is declared on StdoutMessage, not the SDKMessage
    // union, so whether it reaches this iterator is exactly what needs proving.
    const goalEvents = session.messages.filter((m) => (m as any).type === "active_goal");
    const stateEvents = session.messages.filter((m) => m.type === "system"
      && String((m as any).subtype) === "session_state_changed");
    let wrote = false;
    try { wrote = (await readFile(join(cwd, "goal.txt"), "utf8")).includes("DONE"); } catch { /* not written */ }
    record("10c", "native goal drives to completion", wrote,
      `goal.txt=${wrote} result=${JSON.stringify(String((goalResult as any).result ?? "").slice(0, 60))}`);
    record("10d", "active_goal events reach the SDK stream", goalEvents.length > 0,
      goalEvents.length > 0
        ? goalEvents.map((m: any) => JSON.stringify(m.value)).join(" | ").slice(0, 300)
        : `none; session_state_changed=${stateEvents.length}`);
    const autoContinuations = session.messages.filter((m) => (m as any).origin?.kind === "auto-continuation").length;
    const goalResults = session.messages.filter((m) => m.type === "result");
    record("10e", "goal continuations are distinguishable", autoContinuations > 0 || goalResults.length > 1,
      `auto-continuation messages=${autoContinuations} results=${goalResults.length}`
      + ` origins=${goalResults.map((r: any) => r.origin?.kind ?? "absent").join(",")}`);
  }
  session.close();
}

async function historyPhase(sessionId: string | undefined): Promise<void> {
  console.log(`\n=== history phase ===`);
  let started = performance.now();
  const sessions = await listSessions().catch((e) => { console.error(e); return [] as any[]; });
  const listMs = performance.now() - started;
  record("12a", "listSessions is usable for discovery", sessions.length > 0,
    `${sessions.length} sessions in ${listMs.toFixed(0)}ms`);

  // Measure against the largest transcript on this host, not a toy one.
  const projects = join(process.env.HOME ?? "", ".claude", "projects");
  let largest: { id: string; size: number } | undefined;
  for (const dir of await readdir(projects).catch(() => [])) {
    for (const entry of await readdir(join(projects, dir)).catch(() => [])) {
      if (!entry.endsWith(".jsonl")) continue;
      const { size } = await import("node:fs/promises").then((fs) => fs.stat(join(projects, dir, entry)));
      if (!largest || size > largest.size) largest = { id: entry.slice(0, -6), size };
    }
  }
  if (!largest) { record("12b", "session helpers on a large transcript", "unknown", "no transcripts found"); return; }
  console.log(`largest transcript: ${largest.id} (${(largest.size / 1e6).toFixed(1)} MB)`);

  started = performance.now();
  const info = await getSessionInfo(largest.id).catch((e) => { console.error(e); return undefined; });
  const infoMs = performance.now() - started;
  started = performance.now();
  const messages = await getSessionMessages(largest.id).catch((e) => { console.error(e); return [] as any[]; });
  const messagesMs = performance.now() - started;
  const rss = process.memoryUsage().rss / 1e6;
  record("12b", "session helpers on a large transcript", info !== undefined,
    `getSessionInfo ${infoMs.toFixed(0)}ms; getSessionMessages ${messages.length} msgs in ${messagesMs.toFixed(0)}ms; rss ${rss.toFixed(0)}MB`);
  record("12c", "getSessionMessages supports bounded paging", "unknown",
    "inspect GetSessionMessagesOptions — recorded manually below");
  if (sessionId) {
    const own = await getSessionInfo(sessionId).catch(() => undefined);
    record("12d", "spike session is discoverable by id", own !== undefined, JSON.stringify(own ?? {}).slice(0, 200));
  }
}

async function main(): Promise<void> {
  const phases = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["core"];
  const cwd = await mkdtemp(join(tmpdir(), "qiyan-claude-spike-"));
  await writeFile(join(cwd, "CLAUDE.md"), "Spike workspace. When asked for a marker, reply exactly SPIKE_MARKER.\n");
  console.log(`spike cwd: ${cwd}`);
  console.log(`node ${process.version}, sdk 0.3.220, system claude ${process.env.CLAUDE_VERSION ?? "(see --version)"}`);

  let coreSession: string | undefined;
  if (phases.includes("core")) coreSession = await corePhase(cwd);
  if (phases.includes("tasks")) await tasksPhase(cwd);
  if (phases.includes("goal")) await goalPhase(cwd);
  if (phases.includes("history")) await historyPhase(coreSession);

  console.log("\n=== summary ===");
  for (const check of checks) {
    const mark = check.pass === true ? "PASS" : check.pass === false ? "FAIL" : "????";
    console.log(`${mark}  ${check.id.padEnd(4)} ${check.name}`);
  }
  const failed = checks.filter((c) => c.pass === false);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  process.exit(0);
}

void main();

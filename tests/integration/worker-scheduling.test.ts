import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createTestDatabase } from "../../src/storage/database.ts";
import { ScheduleStore, type ScheduleRow } from "../../src/scheduling/schedule-store.ts";
import { TriggerEngine } from "../../src/scheduling/trigger-engine.ts";
import { WorkerScheduleMcpServer } from "../../src/scheduling/worker-mcp.ts";

const enabled = process.env.RUN_CLAUDE_INTEGRATION === "1";

test("a real Claude worker calls the scheduling MCP tool; the engine then fires it", { skip: !enabled, timeout: 180_000 }, async (t) => {
  const store = new ScheduleStore(createTestDatabase());
  let clock = 1_000_000;
  const session = { nickname: "worker-1", endpointId: "claude-local", threadId: "thread-xyz" };
  const server = new WorkerScheduleMcpServer({ store, now: () => clock, resolveToken: (tok) => tok === "tok-secret" ? session : undefined });
  await server.start();
  t.after(() => server.stop());

  const dir = await mkdtemp(join(tmpdir(), "qiyan-worker-mcp-"));
  const configPath = join(dir, "mcp.json");
  await writeFile(configPath, JSON.stringify({
    mcpServers: { "qiyan-worker-scheduling": { type: "http", url: `http://127.0.0.1:${server.port}/mcp`, headers: { Authorization: "Bearer tok-secret" } } },
  }));

  // real claude worker: instruct it to schedule a wakeup via the MCP tool
  const status = await runClaude(dir, [
    "-p", "--output-format", "stream-json", "--verbose",
    "--mcp-config", configPath, "--strict-mcp-config",
    "--allowedTools", "mcp__qiyan-worker-scheduling__schedule_wakeup",
  ], "Call the schedule_wakeup tool with delay_seconds=60 and message='continue the build'. Then reply DONE.");
  assert.equal(status, 0);

  const rows = store.listForSession("claude-local", "thread-xyz");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.kind, "wakeup");
  assert.equal(rows[0]?.message, "continue the build");

  // the engine fires it once the delay elapses, driving a turn via send_to_session
  const fired: ScheduleRow[] = [];
  const engine = new TriggerEngine({ store, now: () => clock, fire: async (r) => { fired.push(r); }, runCheck: async () => false, setTimer: () => ({ cancel: () => undefined }) });
  clock = 1_000_000 + 61_000;
  await engine.tick();
  assert.equal(fired.length, 1);
  assert.equal(fired[0]?.message, "continue the build");
});

function runClaude(cwd: string, args: string[], prompt: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "ignore"] });
    child.stdout.resume();
    child.stdin.end(prompt);
    child.once("error", () => resolve(-1));
    child.once("close", (code) => resolve(code ?? -1));
  });
}

import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTestDatabase } from "../../src/storage/database.ts";
import { ScheduleStore } from "../../src/scheduling/schedule-store.ts";
import { WorkerScheduleMcpServer } from "../../src/scheduling/worker-mcp.ts";

// These tools are attached to no provider today (Claude sessions own scheduling natively);
// they are retained for a future Codex worker-side surface, so the guidance must stay
// provider-neutral — a claim about how one CLI's process lifetime works would be wrong here.
test("monitor guidance promises one fire and scopes the check to the session's host", async (t) => {
  const store = new ScheduleStore(createTestDatabase());
  const session = { nickname: "worker-1", endpointId: "worker-endpoint", threadId: "thread-xyz" };
  const server = new WorkerScheduleMcpServer({ store, now: () => 1, resolveToken: (token) => token === "tok-secret" ? session : undefined });
  await server.start();
  t.after(() => server.stop());

  const client = new Client({ name: "qiyan-scheduling-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { authorization: "Bearer tok-secret" } },
  }) as any);
  t.after(() => client.close());

  const monitor = (await client.listTools()).tools.find((tool) => tool.name === "monitor");
  assert.match(monitor?.description ?? "", /fires once/iu);
  assert.match(monitor?.description ?? "", /on your session's host/iu);
  assert.doesNotMatch(monitor?.description ?? "", /claude/iu);
});

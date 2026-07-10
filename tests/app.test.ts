import assert from "node:assert/strict";
import test from "node:test";
import { composeApp, createApp, StartupPhaseError, TerminalInbox, type AppPhase } from "../src/app.ts";
import type { BotConfig } from "../src/config.ts";
import type { WeixinCredentialHandle } from "../src/chat-apps/weixin/credential-store.ts";

test("composition starts in order, starts each worker once, and stops in reverse", async () => {
  const events: string[] = [];
  const phases: AppPhase[] = ["storage", "registry", "attachments", "mcp", "subscriptions", "endpoint", "reconciliation", "assistant", "scheduler", "delivery", "polling"].map((name) => ({
    name, start: async () => { events.push(`start:${name}`); }, stop: async () => { events.push(`stop:${name}`); },
  }));
  const app = composeApp(phases);
  await Promise.all([app.start(), app.start()]);
  await Promise.all([app.stop(), app.stop()]);
  assert.deepEqual(events.slice(0, phases.length), phases.map((phase) => `start:${phase.name}`));
  assert.deepEqual(events.slice(phases.length), [...phases].reverse().map((phase) => `stop:${phase.name}`));
});

test("startup failure cleans already started resources in reverse order", async () => {
  const events: string[] = [];
  const app = composeApp([
    { name: "one", start: async () => { events.push("start:one"); }, stop: async () => { events.push("stop:one"); } },
    { name: "two", start: async () => { events.push("start:two"); throw new Error("boom"); }, stop: async () => { events.push("stop:two"); } },
    { name: "three", start: async () => { events.push("start:three"); }, stop: async () => undefined },
  ]);
  let failure: unknown;
  try { await app.start(); } catch (error) { failure = error; }
  assert.ok(failure instanceof StartupPhaseError);
  assert.equal(failure.phase, "two");
  assert.match(String(failure.cause), /boom/u);
  assert.deepEqual(events, ["start:one", "start:two", "stop:one"]);
  await app.stop();
});

test("composition accepts phases without a scheduler option", () => {
  // @ts-expect-error Generic maintenance is intentionally not part of the composition API.
  void composeApp([], { maintenance: { intervalMs: 60_000, run: async () => undefined } });
});

test("terminal inbox preserves a completion that precedes attempt registration", () => {
  const inbox = new TerminalInbox<{ status: string }>();
  inbox.publish("turn", { status: "completed" });
  assert.deepEqual(inbox.take("turn"), { status: "completed" });
  assert.equal(inbox.take("turn"), undefined);
});

test("shutdown attempts every phase and propagates the first cleanup failure", async () => {
  const stopped: string[] = [];
  const app = composeApp([
    { name: "one", start: async () => undefined, stop: async () => { stopped.push("one"); } },
    { name: "two", start: async () => undefined, stop: async () => { stopped.push("two"); throw new Error("cleanup failed"); } },
  ]);
  await app.start();
  await assert.rejects(app.stop(), /cleanup failed/);
  assert.deepEqual(stopped, ["two", "one"]);
});

test("createApp keeps phase injection and opaque WeChat runtime options outside BotConfig", async () => {
  const events: string[] = [];
  const phase: AppPhase = {
    name: "injected",
    start: async () => { events.push("start"); },
    stop: async () => { events.push("stop"); },
  };
  const credential = {} as WeixinCredentialHandle;
  const app = await createApp({} as BotConfig, { phases: [phase], weixinCredential: credential });
  await app.start();
  await app.stop();
  assert.deepEqual(events, ["start", "stop"]);
  assert.equal("weixinCredential" in ({} as BotConfig), false);
});

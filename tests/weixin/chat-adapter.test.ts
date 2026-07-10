import assert from "node:assert/strict";
import test from "node:test";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { WeixinAccountStore, type WeixinAuthorizationIncidentSink } from "../../src/chat-apps/weixin/account-store.ts";
import { WeixinApiError } from "../../src/chat-apps/weixin/api-client.ts";
import { WeixinChatAdapter } from "../../src/chat-apps/weixin/chat-adapter.ts";
import { WeixinInboxStore } from "../../src/chat-apps/weixin/inbox-store.ts";
import { WeixinOutboundStore } from "../../src/chat-apps/weixin/outbound-store.ts";

function setup(
  responses: Array<"success" | "failure" | "authorization"> = ["success"],
  configFailure?: Error,
) {
  const db = createTestDatabase();
  const deliveries = new DeliveryStore(db);
  const accounts = new WeixinAccountStore(db, deliveries);
  const outbound = new WeixinOutboundStore(db);
  const inbox = new WeixinInboxStore(db, { botId: "bot", ownerUserId: "owner" });
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const sleeps: number[] = [];
  const serverTimeouts: Array<number | undefined> = [];
  const incidents: unknown[] = [];
  const incidentSink: WeixinAuthorizationIncidentSink & { reconcileUnwarned(): Promise<void> } = {
    async transition(value) {
      incidents.push(value);
      accounts.latchInactive(value.generationId, value.state, `test-incident-${incidents.length}`);
    },
    async reconcileUnwarned() { calls.push("reconcile-incidents"); },
  };
  let index = 0;
  const api = {
    async getConfig() { calls.push("config"); if (configFailure) throw configFailure; return {}; },
    async getUpdates(_cursor: string, signal: AbortSignal, serverTimeoutMs?: number) {
      calls.push("poll"); signals.push(signal);
      serverTimeouts.push(serverTimeoutMs);
      const response = responses[index++] ?? "pending";
      if (response === "failure") throw new WeixinApiError("service", "temporary");
      if (response === "authorization") throw new WeixinApiError("authorization", "stale", { protocolCode: -14 });
      if (response === "success") return { ret: 0 as const, cursor: "next", timeoutMs: 60_000, messages: [] };
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    },
    async notifyLifecycle(state: "start" | "stop") { calls.push(`notify-${state}`); },
    async sendTyping(state: "start" | "stop") { calls.push(`typing-${state}`); throw new Error("typing unavailable"); },
    async sendMessage() { return {}; },
  };
  const ingress = {
    async recoverAndDrain() { calls.push("recover-ingress"); },
    scheduleDrain() { calls.push("drain-ingress"); },
    start() { calls.push("start-ingress"); },
    async stop() { calls.push("stop-ingress"); },
  };
  const delivery = { id: "weixin", sendMessage: async () => ({}) } as never;
  const adapter = new WeixinChatAdapter({
    credential: {
      accountGenerationId: "generation", credentialRevisionId: "revision", botId: "bot", ownerUserId: "owner",
      apiBaseUrl: "https://ilinkai.weixin.qq.com",
    },
    api,
    accounts,
    inbox,
    outbound,
    ingress,
    delivery,
    incidentSink,
    sleep: async (ms) => { sleeps.push(ms); },
    jitter: () => 0,
  });
  return { db, adapter, accounts, outbound, calls, signals, sleeps, incidents, serverTimeouts };
}

test("authenticates, activates, recovers, polls one cursor, and stops abortably", async () => {
  const fixture = setup(["success"]);
  await fixture.adapter.initialize();
  assert.deepEqual(fixture.adapter.primaryBinding, {
    adapterId: "weixin",
    conversationKey: "weixin:generation:owner",
    destination: { generationId: "generation", botId: "bot", ownerUserId: "owner" },
  });
  assert.equal(fixture.accounts.authorization("generation"), "active");
  await fixture.adapter.start();
  await fixture.adapter.sendTyping("start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.all([fixture.adapter.stop(), fixture.adapter.close()]);
  assert.equal(fixture.signals.every((signal) => signal.aborted), true);
  assert.equal(fixture.calls.includes("drain-ingress"), true);
  assert.equal(fixture.calls.includes("notify-start"), true);
  assert.equal(fixture.calls.includes("notify-stop"), true);
  assert.equal(fixture.calls.filter((value) => value === "notify-stop").length, 1);
  assert.equal(fixture.calls.includes("typing-start"), true);
  assert.equal(fixture.adapter.health.state, "stopped");
  assert.deepEqual(fixture.serverTimeouts.slice(0, 2), [undefined, 60_000]);
  fixture.db.close();
});

test("stops polling as authorization-inactive when another WeChat operation trips the shared latch", async () => {
  const fixture = setup(["success"]);
  await fixture.adapter.initialize();
  fixture.accounts.latchInactive("generation", "credential_changed", "external-incident");

  await fixture.adapter.start();
  await fixture.adapter.idle();

  assert.equal(fixture.adapter.health.state, "authorization_inactive");
  assert.equal(fixture.calls.filter((value) => value === "poll").length, 0);
  await fixture.adapter.stop();
  fixture.db.close();
});

test("serializes a restart requested while stop is still draining the old poll", async () => {
  const fixture = setup(["success"]);
  await fixture.adapter.initialize();
  await fixture.adapter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));

  await Promise.all([fixture.adapter.stop(), fixture.adapter.start()]);

  assert.equal(fixture.adapter.health.state, "polling");
  await fixture.adapter.stop();
  assert.equal(fixture.signals.every((signal) => signal.aborted), true);
  fixture.db.close();
});

test("backs off exponentially and resets health only after a successful poll", async () => {
  const fixture = setup(["failure", "failure", "success"]);
  await fixture.adapter.initialize();
  await fixture.adapter.start();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await fixture.adapter.stop();
  assert.deepEqual(fixture.sleeps.slice(0, 2), [250, 500]);
  assert.equal(fixture.adapter.health.consecutiveFailures, 0);
  fixture.db.close();
});

test("routes poll authorization failures through the shared incident sink", async () => {
  const fixture = setup(["authorization"]);
  await fixture.adapter.initialize();
  await fixture.adapter.start();
  await fixture.adapter.idle();
  assert.deepEqual(fixture.incidents, [{
    generationId: "generation", state: "relogin_required", category: "authorization",
  }]);
  await fixture.adapter.stop();
  fixture.db.close();
});

test("a startup authorization failure latches durably without failing other adapters", async () => {
  const fixture = setup([], new WeixinApiError("authorization", "stale", { protocolCode: -14 }));

  await fixture.adapter.initialize();
  await fixture.adapter.start();

  assert.equal(fixture.accounts.authorization("generation"), "relogin_required");
  assert.equal(fixture.adapter.health.state, "authorization_inactive");
  assert.deepEqual(fixture.incidents, [{
    generationId: "generation", state: "relogin_required", category: "authorization",
  }]);
  assert.equal(fixture.calls.includes("poll"), false);
  await fixture.adapter.stop();
  fixture.db.close();
});

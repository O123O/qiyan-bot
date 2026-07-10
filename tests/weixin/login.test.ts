import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { WeixinApiError } from "../../src/chat-apps/weixin/api-client.ts";
import type { WeixinCredential, WeixinCredentialHandle, WeixinCredentialPublic } from "../../src/chat-apps/weixin/credential-store.ts";
import type { WeixinQrChallenge, WeixinQrState } from "../../src/chat-apps/weixin/auth-client.ts";
import {
  runWeixinLogin,
  createNodeWeixinLoginTerminal,
  type WeixinLoginAuthClient,
  type WeixinLoginCredentialStore,
  type WeixinLoginTerminal,
} from "../../src/chat-apps/weixin/login.ts";

const existingCredential: Readonly<WeixinCredential> = Object.freeze({
  accountGenerationId: crypto.randomUUID(),
  credentialRevisionId: crypto.randomUUID(),
  botId: "existing-bot",
  ownerUserId: "existing-owner",
  botToken: "existing-secret-token",
  apiBaseUrl: "https://ilinkai.weixin.qq.com",
  authenticatedAt: 1,
});

function handle(): WeixinCredentialHandle {
  return {
    public: publicCredential(existingCredential),
    async withVerifiedCredential(operation) { return operation(existingCredential); },
  };
}

function publicCredential(value: Readonly<WeixinCredential>): WeixinCredentialPublic {
  return {
    accountGenerationId: value.accountGenerationId,
    credentialRevisionId: value.credentialRevisionId,
    botId: value.botId,
    ownerUserId: value.ownerUserId,
    apiBaseUrl: value.apiBaseUrl,
  };
}

function fixture(input: {
  existing?: WeixinCredentialHandle;
  states: WeixinQrState[];
  challenges?: WeixinQrChallenge[];
  codes?: string[];
  probe?: () => Promise<void>;
}) {
  const commits: Array<{ botToken: string; botId: string; ownerUserId: string; apiBaseUrl: string; authenticatedAt: number }> = [];
  const createTokens: Array<string | undefined> = [];
  const polls: Array<{ challenge: WeixinQrChallenge; code?: string }> = [];
  const rendered: string[] = [];
  const statuses: string[] = [];
  let prompts = 0;
  const challenges = input.challenges ?? [{ token: "qr-token", payload: "private-qr-payload", baseUrl: "https://ilinkai.weixin.qq.com" }];
  const store: WeixinLoginCredentialStore = {
    async loadPinned() { return input.existing; },
    async commitConfirmed(value) {
      commits.push(value);
      return {
        accountGenerationId: "new-generation",
        credentialRevisionId: "new-revision",
        botId: value.botId,
        ownerUserId: value.ownerUserId,
        apiBaseUrl: value.apiBaseUrl,
      };
    },
  };
  const auth: WeixinLoginAuthClient = {
    async createQr(token) {
      createTokens.push(token);
      const challenge = challenges.shift();
      if (!challenge) throw new Error("unexpected QR refresh");
      return challenge;
    },
    async pollQr(challenge, code) {
      polls.push({ challenge, ...(code === undefined ? {} : { code }) });
      const state = input.states.shift();
      if (!state) throw new Error("unexpected QR poll");
      return state;
    },
    async probeCredential() { await input.probe?.(); },
  };
  const terminal: WeixinLoginTerminal = {
    renderQr(payload) { rendered.push(payload); },
    async promptVerificationCode() {
      prompts += 1;
      const value = input.codes?.shift();
      if (value === undefined) throw new Error("unexpected verification prompt");
      return value;
    },
    status(message) { statuses.push(message); },
  };
  return { store, auth, terminal, commits, createTokens, polls, rendered, statuses, prompts: () => prompts };
}

test("confirms a QR login with the effective regional base and never emits secrets in status", async () => {
  const fake = fixture({
    states: [
      { status: "scaned_but_redirect", redirectBaseUrl: "https://region.weixin.qq.com" },
      { status: "confirmed", botToken: "new-secret-token", botId: "new-bot", ownerUserId: "new-owner" },
    ],
  });
  const result = await runWeixinLogin({ ...fake, now: () => 123 });

  assert.equal(result.botId, "new-bot");
  assert.deepEqual(fake.commits, [{
    botToken: "new-secret-token",
    botId: "new-bot",
    ownerUserId: "new-owner",
    apiBaseUrl: "https://region.weixin.qq.com",
    authenticatedAt: 123,
  }]);
  assert.deepEqual(fake.rendered, ["private-qr-payload"]);
  assert.equal(fake.polls[1]?.challenge.baseUrl, "https://region.weixin.qq.com");
  assert.doesNotMatch(fake.statuses.join("\n"), /new-secret-token|new-bot|new-owner|private-qr-payload/u);
});

test("uses the prior token and treats a proven already-bound credential as a no-op", async () => {
  let probes = 0;
  const prior = handle();
  const fake = fixture({
    existing: prior,
    states: [{ status: "binded_redirect" }],
    probe: async () => { probes += 1; },
  });

  assert.deepEqual(await runWeixinLogin({ ...fake }), prior.public);
  assert.deepEqual(fake.createTokens, ["existing-secret-token"]);
  assert.equal(probes, 1);
  assert.deepEqual(fake.commits, []);
});

test("retries once without the prior token after an authorization-failed bound probe", async () => {
  let probes = 0;
  const fake = fixture({
    existing: handle(),
    challenges: [
      { token: "old-attempt", payload: "first-qr", baseUrl: "https://ilinkai.weixin.qq.com" },
      { token: "fresh-attempt", payload: "second-qr", baseUrl: "https://ilinkai.weixin.qq.com" },
    ],
    states: [
      { status: "binded_redirect" },
      { status: "confirmed", botToken: "fresh-token", botId: "fresh-bot", ownerUserId: "fresh-owner" },
    ],
    probe: async () => {
      probes += 1;
      throw new WeixinApiError("authorization", "authorization is stale", { protocolCode: -14 });
    },
  });

  await runWeixinLogin({ ...fake, now: () => 456 });
  assert.equal(probes, 1);
  assert.deepEqual(fake.createTokens, ["existing-secret-token", undefined]);
  assert.deepEqual(fake.rendered, ["first-qr", "second-qr"]);
  assert.equal(fake.commits.length, 1);
});

test("handles verification input, clears accepted codes, and bounds repeated prompts", async () => {
  const accepted = fixture({
    states: [
      { status: "need_verifycode" },
      { status: "scaned" },
      { status: "confirmed", botToken: "token", botId: "bot", ownerUserId: "owner" },
    ],
    codes: ["123456"],
  });
  await runWeixinLogin({ ...accepted });
  assert.deepEqual(accepted.polls.map(({ code }) => code), [undefined, "123456", undefined]);

  const rejected = fixture({
    states: Array.from({ length: 4 }, () => ({ status: "need_verifycode" as const })),
    codes: ["1111", "2222", "3333", "4444"],
  });
  await assert.rejects(runWeixinLogin({ ...rejected }), /verification attempt limit/u);
  assert.equal(rejected.prompts(), 3);
  assert.deepEqual(rejected.commits, []);
});

test("refreshes expired or blocked QR challenges only within a fixed bound", async () => {
  for (const status of ["expired", "verify_code_blocked"] as const) {
    const fake = fixture({
      challenges: [1, 2, 3].map((value) => ({
        token: `qr-${value}`, payload: `payload-${value}`, baseUrl: "https://ilinkai.weixin.qq.com",
      })),
      states: [{ status }, { status }, { status }],
    });
    await assert.rejects(runWeixinLogin({ ...fake }), /QR refresh limit/u);
    assert.equal(fake.createTokens.length, 3);
    assert.equal(fake.rendered.length, 3);
    assert.deepEqual(fake.commits, []);
  }
});

test("requires a complete confirmation and leaves the prior credential untouched on failure or cancellation", async () => {
  for (const state of [
    { status: "confirmed" as const, botId: "bot", ownerUserId: "owner" },
    { status: "confirmed" as const, botToken: "token", ownerUserId: "owner" },
    { status: "confirmed" as const, botToken: "token", botId: "bot" },
  ]) {
    const fake = fixture({ existing: handle(), states: [state] });
    await assert.rejects(runWeixinLogin({ ...fake }), /confirmation is incomplete/u);
    assert.deepEqual(fake.commits, []);
  }

  const controller = new AbortController();
  controller.abort();
  const cancelled = fixture({ existing: handle(), states: [] });
  await assert.rejects(
    runWeixinLogin({ ...cancelled, signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.deepEqual(cancelled.createTokens, []);
  assert.deepEqual(cancelled.commits, []);
});

test("does not turn a non-authorization bound probe failure into a fresh login", async () => {
  const fake = fixture({
    existing: handle(),
    states: [{ status: "binded_redirect" }],
    probe: async () => { throw new WeixinApiError("service", "temporary failure"); },
  });
  await assert.rejects(runWeixinLogin({ ...fake }), /temporary failure/u);
  assert.deepEqual(fake.createTokens, ["existing-secret-token"]);
  assert.deepEqual(fake.commits, []);
});

test("cancels during a verification prompt without committing credentials", async () => {
  const controller = new AbortController();
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => { promptStarted = resolve; });
  const fake = fixture({ states: [{ status: "need_verifycode" }] });
  fake.terminal.promptVerificationCode = async (signal) => {
    promptStarted();
    return new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  };

  const pending = runWeixinLogin({ ...fake, signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
  assert.deepEqual(fake.commits, []);

  const input = new PassThrough();
  const output = new PassThrough();
  const terminal = createNodeWeixinLoginTerminal(input, output);
  const readlineController = new AbortController();
  const question = terminal.promptVerificationCode(readlineController.signal);
  readlineController.abort();
  await assert.rejects(question, (error: unknown) => error instanceof Error && error.name === "AbortError");
});

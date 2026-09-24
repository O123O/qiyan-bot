import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationBinding } from "../../src/chat-apps/shared/binding.ts";
import { prepareSshControlMasterUnusableNotice, prepareSshFreshChannelUnavailableNotice } from "../../src/endpoints/ssh-recovery.ts";

test("the fresh-channel warning is actionable and uses the current cross-chat owner route", () => {
  const binding: ConversationBinding = {
    adapterId: "slack",
    conversationKey: "slack:D123",
    destination: { channelId: "D123" },
  };
  const prepared: Array<{
    kind: string;
    binding: ConversationBinding;
    body: string;
    mandatory: boolean;
  }> = [];

  prepareSshFreshChannelUnavailableNotice({
    prepare: (input) => { prepared.push(input); },
  }, binding, { endpointId: "prenyx-codex", sshHost: "prenyx" });

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0]?.kind, "system_warning");
  assert.equal(prepared[0]?.mandatory, true);
  assert.equal(prepared[0]?.binding, binding);
  assert.match(prepared[0]!.body, /prenyx-codex.*fresh SSH session.*prenyx ControlMaster/u);
  assert.match(prepared[0]!.body, /automatic restarts are paused/u);
  assert.match(prepared[0]!.body, /existing shell.*kinit/u);
  assert.match(prepared[0]!.body, /replace.*ControlMaster.*freshly authenticated/u);
  assert.match(prepared[0]!.body, /plain `ssh prenyx` may reuse the stale master/u);
  assert.match(prepared[0]!.body, /session\/channel policy/u);
});

test("the unusable-master warning stays short and states both causes without asserting one", () => {
  const binding: ConversationBinding = {
    adapterId: "slack",
    conversationKey: "slack:D123",
    destination: { channelId: "D123" },
  };
  const prepared: Array<{ kind: string; binding: ConversationBinding; body: string; mandatory: boolean }> = [];

  prepareSshControlMasterUnusableNotice({
    prepare: (input) => { prepared.push(input); },
  }, binding, { endpointId: "prenyx-codex", sshHost: "prenyx" });

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0]?.kind, "system_warning");
  assert.equal(prepared[0]?.mandatory, true);
  assert.equal(prepared[0]?.binding, binding);
  assert.match(prepared[0]!.body, /prenyx-codex is unreachable/u);
  assert.match(prepared[0]!.body, /no usable SSH ControlMaster for prenyx/u);
  // An `ask` master may be alive, so the cause is offered, never asserted.
  assert.match(prepared[0]!.body, /gone, or an `ask` mode QiYan cannot answer/u);
  assert.match(prepared[0]!.body, /ssh -N prenyx/u);
  // Retries continue, so the notice must never say they stopped.
  assert.match(prepared[0]!.body, /keeps retrying/u);
  assert.doesNotMatch(prepared[0]!.body, /paused/u);

  // One of these goes out per affected endpoint, so a single incident delivers several at once.
  // Length is the feature: the full remedies live in docs/ssh-workers.md.
  assert.ok(prepared[0]!.body.length < 260, `notice is ${prepared[0]!.body.length} chars`);
});

import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationBinding } from "../../src/chat-apps/shared/binding.ts";
import { prepareSshControlMasterAbsentNotice, prepareSshFreshChannelUnavailableNotice } from "../../src/endpoints/ssh-recovery.ts";

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

test("the absent-master warning names the host and a master that outlives a QiYan restart", () => {
  const binding: ConversationBinding = {
    adapterId: "slack",
    conversationKey: "slack:D123",
    destination: { channelId: "D123" },
  };
  const prepared: Array<{ kind: string; binding: ConversationBinding; body: string; mandatory: boolean }> = [];

  prepareSshControlMasterAbsentNotice({
    prepare: (input) => { prepared.push(input); },
  }, binding, { endpointId: "prenyx-codex", sshHost: "prenyx" });

  assert.equal(prepared.length, 1);
  assert.equal(prepared[0]?.kind, "system_warning");
  assert.equal(prepared[0]?.mandatory, true);
  assert.equal(prepared[0]?.binding, binding);
  assert.match(prepared[0]!.body, /prenyx-codex cannot reach prenyx/u);
  assert.match(prepared[0]!.body, /ControlMaster your ssh config points at is gone/u);
  assert.match(prepared[0]!.body, /cannot create one where authentication is interactive/u);
  // The same ssh failure is raised by a rebooting host, so this must never claim retries stopped.
  assert.match(prepared[0]!.body, /keeps retrying/u);
  assert.doesNotMatch(prepared[0]!.body, /paused/u);
  assert.match(prepared[0]!.body, /Ctrl-C would kill the master/u);
  // Without this the user re-establishes a master that the next restart kills again.
  assert.match(prepared[0]!.body, /outside QiYan's service/u);
  assert.match(prepared[0]!.body, /systemd-run --user --pty --unit=ssh-master-prenyx ssh -N prenyx/u);
});

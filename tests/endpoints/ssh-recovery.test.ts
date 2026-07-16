import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationBinding } from "../../src/chat-apps/shared/binding.ts";
import { prepareSshFreshChannelUnavailableNotice } from "../../src/endpoints/ssh-recovery.ts";

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

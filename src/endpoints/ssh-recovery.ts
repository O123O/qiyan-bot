import type { ConversationBinding } from "../chat-apps/shared/binding.ts";

interface DeliveryPreparer {
  prepare(input: {
    kind: string;
    binding: ConversationBinding;
    body: string;
    mandatory: boolean;
  }): unknown;
}

// The user configured a ControlMaster for this host that QiYan cannot use — either it is gone, or
// its mode demands interactive confirmation — so it fell back to establishing its own, which it
// cannot do where authentication is interactive. The notice must not assert either cause: an
// `ask` master may be alive and healthy, and telling its owner to start another would send them
// after a master that already exists.
//
// Keep it short. One notice goes out per affected endpoint, so a single event — a restart, a
// cluster going down — delivers this several times at once; every extra clause is paid for once
// per host. The remedies belong in docs/ssh-workers.md, not in a chat message the reader has
// already seen three times.
export function prepareSshControlMasterUnusableNotice(
  deliveries: DeliveryPreparer,
  binding: ConversationBinding,
  input: { endpointId: string; sshHost: string },
): void {
  deliveries.prepare({
    kind: "system_warning",
    binding,
    mandatory: true,
    body: `[system] ${input.endpointId} is unreachable: no usable SSH ControlMaster for ${input.sshHost} (gone, or an \`ask\` mode QiYan cannot answer). Run \`ssh -N ${input.sshHost}\` in a terminal you leave open; QiYan keeps retrying and reconnects on its own.`,
  });
}

export function prepareSshFreshChannelUnavailableNotice(
  deliveries: DeliveryPreparer,
  binding: ConversationBinding,
  input: { endpointId: string; sshHost: string },
): void {
  deliveries.prepare({
    kind: "system_warning",
    binding,
    mandatory: true,
    body: `[system] endpoint ${input.endpointId} cannot open a fresh SSH session through the live ${input.sshHost} ControlMaster; automatic restarts are paused. Renew the remote credential from an existing shell (for example, run kinit where applicable), or safely replace that ControlMaster with a freshly authenticated one, then retry the worker. A plain \`ssh ${input.sshHost}\` may reuse the stale master. If fresh authentication does not resolve this, check the server's SSH session/channel policy.`,
  });
}

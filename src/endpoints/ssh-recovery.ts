import type { ConversationBinding } from "../chat-apps/shared/binding.ts";

interface DeliveryPreparer {
  prepare(input: {
    kind: string;
    binding: ConversationBinding;
    body: string;
    mandatory: boolean;
  }): unknown;
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

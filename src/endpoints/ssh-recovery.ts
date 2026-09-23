import type { ConversationBinding } from "../chat-apps/shared/binding.ts";

interface DeliveryPreparer {
  prepare(input: {
    kind: string;
    binding: ConversationBinding;
    body: string;
    mandatory: boolean;
  }): unknown;
}

// The user configured a ControlMaster for this host and it is no longer there, so QiYan fell back
// to establishing its own — which it cannot do noninteractively on an MFA host. Only the user can
// restore it, so name the host and point at a master that survives a QiYan restart. Retries
// continue meanwhile: the failure that raised this is indistinguishable from a rebooting host.
export function prepareSshControlMasterAbsentNotice(
  deliveries: DeliveryPreparer,
  binding: ConversationBinding,
  input: { endpointId: string; sshHost: string },
): void {
  deliveries.prepare({
    kind: "system_warning",
    binding,
    mandatory: true,
    body: `[system] endpoint ${input.endpointId} cannot reach ${input.sshHost}, and the SSH ControlMaster your ssh config points at is gone — QiYan cannot create one where authentication is interactive. It keeps retrying on a slowing schedule, so it reconnects on its own once you restore the master. Start it outside QiYan's service so a bot restart cannot take it down again, for example \`systemd-run --user --pty --unit=ssh-master-${input.sshHost} ssh -N ${input.sshHost}\` in a terminal you can leave open (detach from it rather than interrupting it — Ctrl-C would kill the master you just authenticated).`,
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

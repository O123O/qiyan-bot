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
// cannot do where authentication is interactive. Both causes reach here and the remedies differ,
// so the notice must not assert either one: an `ask` master may be alive and healthy, and telling
// its owner to start another would send them after a master that already exists. Retries continue
// meanwhile, because the failure that raised this is indistinguishable from a rebooting host.
export function prepareSshControlMasterUnusableNotice(
  deliveries: DeliveryPreparer,
  binding: ConversationBinding,
  input: { endpointId: string; sshHost: string },
): void {
  deliveries.prepare({
    kind: "system_warning",
    binding,
    mandatory: true,
    body: `[system] endpoint ${input.endpointId} cannot reach ${input.sshHost}, and QiYan cannot use the SSH ControlMaster your ssh config names for it: either it is gone, or its ControlMaster mode needs interactive confirmation (\`ask\`/\`autoask\`), which QiYan has no way to answer. It keeps retrying on a slowing schedule, so it reconnects on its own once the master works. For a prompting mode, set \`ControlMaster auto\` for this host. Otherwise start the master outside QiYan's service so a bot restart cannot take it down again, for example \`systemd-run --user --pty --unit=ssh-master-${input.sshHost} ssh -N ${input.sshHost}\` in a terminal you can leave open (detach from it rather than interrupting it — Ctrl-C would kill the master you just authenticated).`,
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

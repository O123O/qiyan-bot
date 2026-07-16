# SSH channel reauthentication recovery

## Problem

QiYan can reuse a user-owned OpenSSH ControlMaster after the remote authentication
state needed for a new session channel has expired. The master process and its
underlying TCP connection can remain alive, so `ssh -O check` still succeeds, while
a new helper, tmux, or App Server proxy command exits with SSH's transport status
255. The exact lifetime behavior depends on the MFA or Kerberos service: the design
must not assume that expiry closes existing SSH channels or the ControlMaster.

Today that failure is treated like an ordinary endpoint outage. The endpoint manager
retries App Server activation on its normal backoff, repeatedly attempting commands
that cannot succeed until the user reauthenticates. The user sees only a generic
"reconnecting" notice and does not know that action is required.

## Decision

Recognize the operator-action state from behavior, only for a reused user-owned
ControlMaster:

1. An authoritative remote helper or App Server proxy operation fails with a
   structured SSH process exit status of 255.
2. A bounded `ssh -O check` against the same attested ControlMaster succeeds.
3. A fixed, argument-only `true` command through that same master also fails with
   structured exit status 255.

This combination means that the local master is alive but cannot open a fresh remote
session channel. It does not claim why the server rejected the channel. Expired MFA
or Kerberos state is the expected cause, but an SSH session limit or another
server-side channel policy can produce the same behavior. QiYan reports the endpoint
as requiring operator action, pauses automatic activation/restart attempts, and
prepares one durable owner delivery with the configured SSH host alias and recovery
instructions.

The diagnostic probe is never run for a QiYan-owned ControlMaster. It is also not run
for timeouts, signals, missing sockets, helper protocol failures, or non-255 exits.
Those remain ordinary endpoint failures with the existing bounded reconnect policy.
If the master check fails, or the fixed command succeeds, QiYan preserves the
original error and existing retry behavior.

## Error and state contract

SSH process failures retain their generic, non-sensitive messages and add only the
structured `exitCode` detail. Neither stdout nor stderr is copied into an error,
operational event, or delivery.

After the three-part diagnostic succeeds, the SSH client preserves the existing
`ENDPOINT_UNAVAILABLE` application error category and adds a stable
`recovery: "ssh_fresh_channel_unavailable"` detail plus the configured SSH host alias
as `sshHost`. Keeping the existing category preserves endpoint-unavailable handling
in operation, ownership, and recovery policy. The endpoint manager consumes the
stable recovery detail; it does not parse SSH error text or depend on process output.

Each endpoint record has an operator-action latch:

- The first classified failure cancels any pending reconnect timer, sets the latch,
  and attempts notification preparation once. Later direct classified failures retry
  that boundary only while `notificationPrepared` is false.
- Both background reconnect paths remain paused while the latch is set.
- Lifecycle restart/disconnect entry points set the same latch. Durable lifecycle
  reconciliation treats this recovery tag as waiting for endpoint/operator recovery,
  not as a transient failure for its capped 30-second retry timer.
- An explicit `ensureReady` still performs one direct attempt. This lets a user renew
  credentials or safely replace the stale master and then retry the worker without
  restarting QiYan.
- A successful endpoint publication clears the latch and resets normal backoff. A
  later fresh-channel failure is a new incident and can notify again.
- Repeated explicit failures while the same latch is set neither start a background
  retry ramp nor repeat the notification.

The owner delivery says that the ControlMaster is alive but new SSH sessions cannot
be opened and automatic restarts are paused. It asks the user either to renew the
server-side credential from an already-open shell using the site's mechanism (for
example, `kinit` where applicable), or to deliberately replace the stale
ControlMaster with a freshly authenticated one using the site's safe login procedure.
It explicitly warns that plain `ssh <host>` may reuse the stale master. If fresh
authentication does not resolve the failure, it directs the user to inspect the
server's session/channel policy. The delivery uses the existing cross-chat outbox,
so the behavior applies to the current owner route rather than only the Web UI.
Operational reporting contains the endpoint ID and classification, never a message
body or credential output.

The endpoint-manager callback reports whether the durable delivery was prepared.
The latch and retry pause are committed before calling it; a callback exception or
`false` result cannot replace the endpoint error or resume background retries. A
later directly triggered failure retries only delivery preparation until it succeeds,
while successful preparation is latched so the same incident does not notify again.
Notification-preparation failures are also emitted as sanitized operational events.

Every latch attempt is fenced to the endpoint generation that performed the failing
activation or lifecycle operation. If another activation publishes a newer ready
generation first, the older failure cannot restore the pause or emit a stale notice.

## Race handling

Channel authorization can change between a successful helper inspection and opening
the App Server proxy. Proxy startup therefore exposes the same structured process
exit status and uses the same diagnostic. An already-open channel may remain usable
after credentials expire; QiYan does not proactively close or probe healthy channels.

The diagnostic itself is bounded to one master check and one fixed session command
per candidate failure. Concurrent endpoint activation is already coalesced by the
manager, but a later direct attempt diagnoses again so it can observe recovered or
changed channel state. The operator-action latch deduplicates retry scheduling and
owner notification, not transport probes. If state changes during a diagnostic, a
non-matching result falls back to the ordinary endpoint failure path; it does not
create a false operator-action state.

## Security and non-goals

- The probe reuses the already attested, user-owned ControlPath and pinned SSH
  destination. It cannot establish, replace, stop, or otherwise operate that master.
- The remote probe is the fixed token `true`; no user input, shell fragment, message,
  attachment, token, or credential is included.
- SSH stdout and stderr remain bounded and are never exposed in the notice.
- QiYan does not perform interactive login, run `kinit`, collect MFA input, or decide
  which authentication mechanism the host uses, and it never closes a user-owned
  ControlMaster.
- This does not alter App Server/tmux restart limits for ordinary outages and does
  not add polling of healthy endpoints.

## Implementation plan

1. Add failing process tests that require a nonzero exit code to be available as
   structured error data without exposing stderr.
2. Add failing SSH argument/runtime tests for the fixed no-op probe and the exact
   helper/proxy failure classification matrix.
3. Add failing endpoint-manager tests for classified failures from activation-retry,
   loss-triggered retry, and lifecycle recovery paths; direct recovery attempts;
   notification preparation failure/retry; latch clearing; and re-arming after a
   successful publication. Cover a deferred `hasIdentityReferences` continuation and
   an older failed activation so neither can override a newer pause/publication state.
4. Add a failing notification test for the actionable, cross-chat owner delivery.
5. Implement the structured process error, narrow SSH diagnostic, endpoint-manager
   latch, production delivery callback, and sanitized operational event.
6. Run focused tests and `npm run check`, obtain independent re-review, then commit
   the task with a signed-off signed commit.

## Acceptance criteria

- A live user-owned ControlMaster that rejects new channels with exit 255 is reported
  as unable to open fresh channels after one bounded diagnostic, with reauthentication
  presented as the expected recovery rather than a proven cause.
- QiYan schedules no automatic App Server/tmux restart while that incident remains
  latched, including the durable lifecycle-operation retry timer, and sends one
  actionable owner message.
- Repeated direct worker requests make one direct recovery attempt each without
  rearming background retries or repeating the message.
- After credentials or the ControlMaster are safely refreshed, the next direct
  attempt can publish the endpoint, clear the latch, and restore the normal reconnect
  policy.
- A dead master, an ordinary network outage, a helper failure, a QiYan-owned master,
  and a working no-op channel are not classified as fresh-channel unavailable.
- No SSH diagnostic output or credential material reaches logs, errors, or chat.

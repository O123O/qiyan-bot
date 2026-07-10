# Unified App Server Endpoint Design

## Status

Revision 5, updated for local-filesystem ControlMaster-backed forwarding.

## Problem

QiYan currently has two classes that both implement the Codex App Server lifecycle:

- `LocalEndpoint` spawns `codex app-server` over stdio.
- `SshEndpoint` starts a remote runtime, creates an SSH byte-stream bridge, connects a local socket, initializes the App Server, checks authentication, handles notifications, handles approval requests, and tracks connection generations.

This duplicates the App Server protocol lifecycle and lets SSH concerns leak into the endpoint abstraction. It also encouraged session creation to run SSH workspace and rollout helpers after a successful App Server `thread/start`, allowing an auxiliary helper failure to relabel a confirmed native success as uncertain.

The App Server API has no SSH semantics. Once a connection exists, a local and remote App Server are the same protocol endpoint.

## Design rule

> One App Server endpoint implementation speaks RPC. Runtime services prepare and maintain its connection.

The endpoint must not know whether its connection came from a local child process, an SSH port forward, a container, or another future transport.

## Goals

- Use one implementation for App Server initialization, version checking, authentication checking, requests, notifications, approval handling, readiness, generation fencing, and connection-loss publication.
- Keep local process management in a local runtime service.
- Keep SSH, the detached remote App Server, ControlMaster-backed forwarding, and remote-runtime identity in an SSH runtime service.
- Make the SSH forward terminate at a private local Unix socket. The unified endpoint connects to that socket exactly as it would connect to any other local socket.
- Keep all session, pool, capacity, registry, and recovery code endpoint-neutral.
- Delete duplicated endpoint lifecycle code and the custom SSH helper tunnel operation when the standard OpenSSH stream-local forward replaces it.
- Preserve exact runtime identity checks, generation fencing, shutdown semantics, MCP client-process attestation, and secret-safe diagnostics.

## Non-goals

- Changing the Codex App Server protocol.
- Changing session adoption, removal, or external-turn policy beyond removing post-create transport work.
- Making remote project files local or mirroring workspaces.
- Automatically retrying a side-effecting RPC whose response was genuinely lost.
- Adding a generic plugin transport framework. Two concrete runtime services and one small interface are enough.

## Target structure

```text
                         AppServerPool / SessionLifecycle
                                      |
                                      v
                         ManagedAppServerEndpoint
                         - initialize / initialized
                         - version and auth checks
                         - request / notification RPC
                         - approval request policy
                         - generation and readiness
                                      |
                              AppServerConnection
                         (RpcWire + close notification)
                             /                    \
                            v                      v
              LocalAppServerRuntime       SshAppServerRuntime
              - spawn local process       - ensure detached remote process
              - stdio JsonlWire           - use authenticated ControlMaster
              - CODEX_HOME check          - local private Unix socket
              - MCP PID identity          - WebSocketWire to local socket
              - stop local process        - exact remote runtime identity
                                           - cancel forward or stop runtime
```

There is no `LocalEndpoint` protocol implementation and no `SshEndpoint` protocol implementation in the target structure. Production constructs the same `ManagedAppServerEndpoint` with one of the two runtime services.

## Minimal interfaces

```ts
interface AppServerConnectionIdentity {
  runtime: RuntimeIdentity;
  allowedClientProcess?: LinuxProcessIdentity;
}

interface AppServerConnection {
  readonly wire: RpcWire;
  onClose(listener: (error?: Error) => void): () => void;
  confirmInitialized(result: AppServerInitializeResult): Promise<AppServerConnectionIdentity>;
  close(): Promise<void>;
}

interface AppServerRuntimeService {
  open(): Promise<AppServerConnection>;
  runtimeIdentity(): Promise<RuntimeIdentity | undefined>;
  classifyLoss(): Promise<EndpointLossKind>;
  shutdownRuntime(expected: RuntimeIdentity): Promise<void>;
}
```

These are lifecycle interfaces, not transport abstractions exposed to sessions. The endpoint consumes them; all higher layers continue to use `ManagedAppServerEndpoint`.

`confirmInitialized` is deliberately connection-specific:

- The local connection rechecks the pinned assistant environment, validates the initialized `codexHome` when required, and resolves the exact App Server/MCP client process identity.
- The SSH connection rereads the detached runtime identity and requires it to equal the identity captured before the forward opened.

No SSH type or operation appears in `ManagedAppServerEndpoint`.

A ready connection always has the required exact identity returned by `confirmInitialized`. The separate `runtimeIdentity()` query remains nullable because an intentionally stopped or already-lost runtime is authoritative absence used by restart/disconnect recovery.

## Unified endpoint lifecycle

`ManagedAppServerEndpoint.start()` performs one generation-fenced sequence:

1. Close any previous connection.
2. Ask the runtime service for a connected `AppServerConnection`.
3. Attach one close listener and construct one `RpcClient` over its wire.
4. Register the common notification and server-request handlers.
5. Send `initialize` with QiYan client metadata.
6. Enforce the configured minimum Codex version without exposing the raw user-agent string.
7. Ask the connection to confirm its runtime-specific identity and initialization claims.
8. Send `initialized`.
9. Call `account/read` through the same App Server API, strictly validate its shape, and reject only when authentication is explicitly required and absent.
10. Publish the connection identity and transition the exact generation to `ready`.

Any stale or failed generation closes only its own connection and cannot overwrite a newer ready generation.

The endpoint owns the common behavior currently duplicated in `LocalEndpoint` and `SshEndpoint`:

- `request`
- `onNotification`
- `onReady`
- `onUnavailable`
- `onPermissionBlocked`
- approval decline/escalation policy
- App Server initialize/version/auth protocol
- generation fencing
- state publication

The endpoint exposes `mcpClientIdentity` from the confirmed connection identity for the assistant MCP admission check. Remote worker connections normally leave it undefined.

`PermissionBlockedEvent` moves to the common endpoint module. No common endpoint type may import `LocalEndpoint` or an SSH module.

`account/read` is performed and strictly validated once by the common endpoint for every runtime. A response must be an object with `account` and boolean `requiresOpenaiAuth`; malformed data fails initialization. The assistant-specific `startAuthenticatedAssistantEndpoint` startup wrapper and the SSH-specific authentication request are deleted so authentication is not checked twice.

The common endpoint emits a typed authentication-required error containing only the endpoint ID and a stable machine-readable reason. Assistant startup maps that reason through the existing `recordAssistantAuthenticationFailure` path to its actionable login instruction; worker activation maps it to the worker authentication guidance. Raw account data is never logged. Both `startAuthenticatedAssistantEndpoint` and `assertAssistantAuthenticated` are deleted after their production behavior moves to this single path.

## Local runtime service

`LocalAppServerRuntime` owns only local process details:

- Validate the configured environment before spawn.
- Spawn `codex app-server --listen stdio://`.
- Drain stderr without logging it.
- Expose child stdio through `JsonlWire`.
- Convert child error/exit into a connection close.
- During `confirmInitialized`, revalidate the environment, attest `codexHome` when configured, and resolve the exact protocol child identity.
- `runtimeIdentity` returns the confirmed local process identity.
- `classifyLoss` returns `runtime-lost`.
- Closing the connection stops the local process because the process is the connection owner.
- `shutdownRuntime` first requires the supplied exact local PID/start-time identity to match the current confirmed child, then stops it. A stale or wrong identity is rejected.

This service does not implement initialize, authentication, notifications, or requests.

## SSH runtime and forwarding service

`SshAppServerRuntime` owns every SSH-specific action:

- Resolve and pin the effective SSH destination.
- Run preflight and bootstrap the fixed remote helper assets once per runtime-service generation; repeated inspect/classify calls reuse the prepared paths and do not rerun bootstrap.
- Ensure the detached remote `codex app-server` is healthy.
- Capture its exact runtime identity.
- Require the endpoint's exact authenticated ControlMaster before any user-owned-master helper operation.
- Register one OpenSSH stream-local forward on that master from a private local Unix socket to the private remote App Server Unix socket.
- Connect `WebSocketWire` to the local forwarded socket and return that wire as an `AppServerConnection`.
- Treat WebSocket closure as the event-driven connection-loss signal; no forward process or polling monitor is needed.
- During `confirmInitialized`, reread and compare the exact remote runtime identity.
- On ordinary connection close, cancel the exact local forward but leave the ControlMaster and detached remote App Server running.
- On `shutdownRuntime`, cancel the forward and then stop only the exact expected remote runtime identity.
- Classify a lost forward with a healthy runtime as `connection-lost`; classify an absent runtime as `runtime-lost`.

The forward is registered and cancelled through the endpoint's authenticated OpenSSH master:

```text
ssh -S <control-path> -O check <pinned-alias>
ssh -S <control-path> -O forward -L <private-local-socket>:<private-remote-socket> <pinned-alias>
ssh -S <control-path> -O cancel  -L <private-local-socket>:<private-remote-socket> <pinned-alias>
```

Every helper and control command explicitly pins the same resolved `ControlPath`, host, user, and port. Each generation prefers a live configured user master and otherwise selects a private QiYan-owned master with `ControlPersist=yes`; normal service shutdown waits for in-flight open work, closes the forward, and exits only that owned master. This lets key-authenticated endpoints recover without manual master setup while still allowing one interactive MFA authentication to serve later noninteractive QiYan operations. Before probing a configured master, QiYan verifies that its socket and parent are canonical same-UID owner-only objects on a local filesystem; unsafe or NFS paths fall back without being contacted. The documented Linux path is `${XDG_RUNTIME_DIR}/qiyan-ssh-%C`, using the existing private runtime directory without setup, with `ControlPersist=yes`, `ServerAliveInterval=15`, and `ServerAliveCountMax=3` so an idle master stays usable and a dead transport fails within a bound. QiYan checks a selected user master before every helper or transfer and supplies `ControlMaster=no` on the actual command, so it never starts, stops, or replaces that master.

Control commands retain batch mode, strict host-key checking, bounded execution, and secret-safe output handling. `-O forward` must succeed before the App Server wire is opened. Each endpoint uses one short stable socket name inside its attested private directory. On open, an owner-only socket left by a crashed process is cancelled and reclaimed before the new forward is registered; an unsafe replacement fails closed. OpenSSH control-command exit status is not treated as cancellation proof. After every cancel attempt, QiYan probes the exact captured local Unix listener: an accepting listener preserves the socket and cleanup reservation, while `ENOENT` or `ECONNREFUSED` plus an exact inode recheck permits unlink. A live connection remains the runtime's active owner until listener shutdown and socket cleanup finish, so a newer generation cannot overlap an older cleanup.

Remote SSH servers must permit local Unix-socket forwarding while continuing to deny TCP forwarding. The supported fixture and documented worker prerequisite are:

```text
DisableForwarding no
AllowTcpForwarding no
AllowStreamLocalForwarding local
```

The fixture contract must assert these effective `sshd -T` values and run a real stream-local `-L` probe. A host that disallows stream-local forwarding is rejected as an unsupported endpoint configuration.

Once the standard forward is covered by the real SSH fixture, remove:

- the `tunnel` operation from the remote helper operation list;
- `tunnelSocket` from `qiyan-ssh-helper.mjs`;
- `SshTunnel` and `ProcessSshTunnel` from the endpoint layer;
- the `SshEndpoint` class.

Workspace, rollout, and file-transfer helper calls remain in their dedicated services. They are not App Server transport operations and are never called by the unified endpoint.

## Session creation boundary

Session creation is identical for local and remote endpoints:

1. Prepare and validate the project workspace before native dispatch.
2. Call `thread/start` through `AppServerPool`.
3. Validate the successful response in memory: nonempty exact ID, expected `threadSource`, exact requested cwd, idle status, and empty start-response turns.
4. Record an idempotent local `materialized=0`, offset-zero rollout ownership baseline. A missing rollout path is stored as the empty sentinel; recording it performs no filesystem, helper, or App Server I/O.
5. Commit registry, runtime, and epoch state locally immediately after the valid response.

There is no post-response workspace helper, rollout helper, SSH helper, endpoint restart, or remote/local branch.

A lost `thread/start` response remains the legitimate uncertain case because native side effects may have occurred without an observed ID. Once a valid exact thread ID is observed, creation is successful; missing rollout metadata cannot change that result and `thread/start` is never retransmitted.

## Failure and restart semantics

### Connection loss

- The unified endpoint publishes `unavailable` once for the current generation.
- The runtime service classifies the loss.
- If classification itself fails, the endpoint still publishes one conservative `connection-lost` event so EndpointManager reconnects and retains caller-owned claims.
- EndpointManager retains the existing event-driven restart/reconnect owner.
- A remote connection loss recreates only the forward when the detached runtime is still healthy.
- A remote runtime loss starts a new runtime only through the existing endpoint activation policy.
- A local process loss is always a runtime loss.

### Normal QiYan shutdown

- Close the unified endpoint connections.
- Stop local App Server processes.
- Cancel remote ControlMaster forwards.
- Exit QiYan-owned ControlMasters; never exit user-owned masters.
- Serialize shutdown with an in-flight SSH open so an owned persistent master cannot appear after its exit step.
- Leave detached remote App Servers running, as today.

### Explicit endpoint disconnect

- Drain endpoint work under the existing lifecycle fence.
- Require the exact runtime identity.
- Close the forward/connection.
- Stop only the exact remote runtime.

### Process restart

- Durable session and operation state remains authoritative.
- EndpointManager reconstructs runtime services from the endpoint catalog.
- SSH services reconnect to an existing healthy detached runtime before considering a new one.
- App Server endpoint initialization follows the same code for local and remote.

## Ownership and helper separation

Rollout ownership remains necessary only to detect a worker session used by an external Codex client. It is not part of App Server connection setup and not part of successful session creation.

For a fresh empty thread, `recordUnmaterialized` writes a local offset-zero baseline without filesystem, App Server, or SSH I/O. No schema migration is needed: `session_rollout_ownership.rollout_path=''` is the pathless sentinel. An empty string can never pass the absolute rollout-path validator. Persistence maps it to `undefined`; a validated absolute path is compare-and-set only from `''`. Existing materialized, external, and nonempty-path rows are never downgraded or replaced.

`SessionOwnershipGuard` receives one narrow endpoint-neutral metadata dependency:

```ts
type RolloutPathResolution =
  | { state: "resolved"; path: string }
  | { state: "pending" }
  | { state: "lost" };

type RolloutPathResolver = (
  identity: MappingIdentity,
  lease?: EndpointWorkLease,
) => Promise<RolloutPathResolution>;
```

When an ownership-sensitive send or watcher inspection encounters a pathless row, the guard asks this resolver for `thread/read(includeTurns:false)` on the exact thread ID. A returned non-null path is shape-validated and compare-and-set from `''`. A different existing path is a conflict. If the App Server still reports null, ownership remains `pending`: sends and relay history reads are blocked without native dispatch and the watcher retries on its normal event/timer path. Transport failure leaves the durable sentinel unchanged for endpoint recovery.

After an App Server replacement, exact `thread not loaded` evidence triggers one exact `thread/resume`. A returned path resumes ordinary ownership scanning. Exact `no rollout found` proves that the empty volatile thread did not survive; managed recovery ends its epoch, compare-removes only that mapping generation, releases its ownership row, and reports a terminal thread-not-found result. It never recreates or retransmits the original `thread/start`.

After a path is bound, the first send and the external ownership watcher scan the rollout from byte zero before accepting ownership-sensitive work. This preserves detection of an external turn racing immediately after creation.

## Code migration

The refactor should be mechanical and staged in tests, but land atomically so production never has two protocol implementations:

1. Add common endpoint contract tests using fake runtime services and wires.
2. Implement `ManagedAppServerEndpoint` and move common RPC/event logic into it.
3. Extract local spawn/identity/environment work into `LocalAppServerRuntime` and run the existing local tests through the common endpoint.
4. Change the SSH fixture and documented prerequisite to permit only local stream-forwarding, with a real forwarding contract test.
5. Extract SSH runtime/forward/identity work into `SshAppServerRuntime` and run the existing SSH tests through the common endpoint. Cache preflight/bootstrap once per service generation.
6. Switch production construction and integration tests to the common endpoint.
7. Replace the helper byte-stream bridge with a ControlMaster stream-local forward and validate it against the real SSH fixture.
8. Delete `LocalEndpoint`, `SshEndpoint`, duplicated approval/auth handlers, duplicated initialize/version code, `startAuthenticatedAssistantEndpoint`, and the remote helper `tunnel` operation.
9. Change fresh ownership recording to accept a pathless empty sentinel, resolve it lazily by exact ID, and keep the already-reviewed no-helper session-create boundary.

Do not retain compatibility subclasses that reimplement or override protocol lifecycle behavior. Small factory functions are acceptable if they only assemble a runtime service and the common endpoint.

## Test matrix

### Common endpoint

- Local and SSH-backed fake services produce the same initialize/initialized/account request sequence.
- Common version rejection redacts raw user-agent content.
- Missing required authentication and malformed `account/read` responses are rejected identically, with one request per initialization.
- Approval requests are declined and reported identically.
- Stale close/error events cannot affect a newer generation.
- Stop during initialization cannot publish ready.
- One current connection loss emits one unavailable event with the service's classification.
- A failed loss classifier still emits exactly one conservative `connection-lost` event.

### Local runtime

- Spawns the exact stdio App Server command and drains stderr.
- Validates the assistant environment before open and during confirmation.
- Attests the expected `CODEX_HOME`.
- Resolves one exact MCP client process and rejects ambiguous launcher topology.
- Stops the exact child and never lets an old exit affect a new connection.
- Rejects a stale or mismatched exact identity on shutdown.

### SSH runtime

- Ensures or reconnects to one detached runtime.
- Requires and pins one authenticated ControlMaster before user-owned-master remote work.
- Checks every user-owned-master helper and transfer, then dispatches with `ControlMaster=no`.
- Registers and cancels one exact stream-local forward on that master.
- Uses App Server wire closure as the event-driven forwarding-loss signal.
- Safely reclaims a stale master-owned listener left by a crashed QiYan process.
- Preserves cleanup ownership across cancellation failure until the exact listener is proven closed.
- Verifies exact listener shutdown instead of trusting `ssh -O cancel` exit status.
- Rejects noncanonical, non-owner, or broadly accessible user ControlMaster paths before invoking SSH.
- Applies owner-only permissions to the local socket.
- The fixture permits local stream forwarding, denies TCP forwarding, and passes a real `-L local_socket:remote_socket` probe.
- A forward loss with a healthy runtime is `connection-lost`.
- A missing runtime is `runtime-lost`.
- Normal close leaves the remote runtime alive.
- Explicit shutdown requires and stops the exact runtime identity.
- The Docker SSH fixture supports initialize, account/read, thread/start, reconnect, and exact shutdown through the common endpoint.

### Session creation

- A successful remote `thread/start` performs no later workspace or rollout helper call.
- Local and remote creation execute the same session lifecycle code.
- `thread/start(path:null)` commits with exactly one native RPC: `thread/start`.
- The first ownership-sensitive action receiving `thread/read(path:null)` blocks before native dispatch; a later exact-ID resolution binds the path and scans from zero without reopening creation.
- Malformed start responses do not publish a registry mapping.
- The unmaterialized ownership record is idempotent, does no I/O, and never overwrites materialized/external evidence.
- An external first turn after baseline recording is detected before QiYan dispatches.

## Acceptance criteria

- Exactly one class owns App Server protocol lifecycle.
- No file implementing that class imports an SSH module or checks endpoint kind.
- SSH process, remote runtime, and forward management live in one dedicated service.
- Session and pool code contain no local/remote branch.
- A confirmed `thread/start` cannot fail because of a later SSH workspace/rollout helper call.
- Existing reconnect, exact-identity shutdown, MCP admission, and external-turn tests remain green.
- Every published runtime and every shutdown has a non-optional exact runtime identity.
- `npm run check` and the real SSH integration fixture pass.

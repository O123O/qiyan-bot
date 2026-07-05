# SSH Remote Worker Endpoints Design

**Date:** 2026-07-05

**Status:** Approved for implementation

## Purpose

Extend QiYan's existing worker-session architecture from one local Codex App Server to a unified endpoint model. The built-in `local` endpoint remains the default and preserves its current lightweight process model. Configured SSH endpoints run Codex on prepared Linux hosts and preserve in-flight work across SSH interruptions by keeping each remote App Server detached inside an isolated `tmux` server.

The user should be able to ask QiYan to work locally or on a named SSH host without manually managing App Server processes. Session lifecycle, registry behavior, goals, status, notifications, and chat delivery must behave the same regardless of endpoint. Only process transport, filesystem access, and attachment transfer differ.

## Goals

- Treat `local` and every configured SSH host as worker endpoints behind shared interfaces.
- Default every optional worker `endpoint` argument to `local`.
- Let one App Server per endpoint serve multiple native Codex threads.
- Preserve an active remote turn when the SSH connection or QiYan process disappears.
- Reconnect to the same detached remote App Server after tunnel loss or QiYan restart.
- Resume persisted native threads with a new App Server after remote reboot or process loss.
- Preserve current native-cwd, idle-state, generation, rollback, and duplicate-identity session safeguards.
- Give remote endpoints the same safe project-placement and explicit `send_to_session`/`prepare_chat_attachment` behavior as local endpoints.
- Keep SSH trust, host preparation, Codex installation, Codex authentication, and operating-system administration under user control.
- Keep chat adapters, App Server transports, session policy, endpoint persistence, and host operations behind separate interfaces.

## Non-goals

- Installing or upgrading Codex, `tmux`, SSH, or other packages on a remote host.
- Copying local Codex credentials, configuration, skills, or project files to a remote host except user-requested attachments.
- Automating OpenAI login or SSH host-key acceptance.
- Supporting remote macOS or Windows hosts in the first release.
- Exposing a remote App Server on a public TCP port.
- Providing a remote QiYan daemon or installing QiYan code remotely.
- Persistently queuing new user operations while an endpoint is unreachable.
- Making QiYan's internal assistant App Server a worker endpoint.
- Guaranteeing exactly-once delivery across an unavoidable crash between a chat service accepting a message and QiYan recording that acknowledgement; existing adapter delivery semantics continue to apply.

## Endpoint model

An endpoint is a named worker location. The reserved endpoint ID `local` is always available and is used whenever a worker tool omits `endpoint`. It is not written to the SSH endpoint catalog.

Each SSH endpoint ID is passed directly to OpenSSH as its destination. It is expected to be a concrete `Host` alias in the user's SSH configuration. QiYan does not maintain another alias-to-host map.

For example:

```sshconfig
Host devbox
    HostName 192.168.1.50
    User xinmm
    IdentityFile ~/.ssh/id_ed25519
```

The corresponding QiYan endpoint ID is `devbox`, and the backend passes `devbox` directly to OpenSSH as the destination.

QiYan's internal assistant endpoint remains private infrastructure. It is not accepted by worker-session tools and is unaffected by `disconnect_endpoint` or `restart_endpoint`.

## Endpoint catalog

SSH endpoint definitions live in strict JSON at `${QIYAN_HOME}/endpoints.json`. The bootstrap file contains an empty endpoint map:

```json
{
  "version": 1,
  "endpoints": {}
}
```

A configured catalog may contain:

```json
{
  "version": 1,
  "endpoints": {
    "devbox": {
      "type": "ssh",
      "projects_root": "~/qiyan-projects"
    }
  }
}
```

The map key is both the QiYan endpoint ID and OpenSSH destination. `projects_root` is optional and defaults to `~/qiyan-projects`. It must resolve on the remote host to an absolute directory after remote-home expansion. Unknown versions, endpoint types, and fields are rejected so misspellings do not silently change behavior.

The live JSON file contains no comments. A separate `endpoints.example.jsonc` provides commented examples, and the managed QiYan instructions document the format. QiYan may inspect SSH configuration and edit `endpoints.json` with ordinary shell and filesystem tools when the user asks it to configure a host. No `add_endpoint` backend tool is added.

The catalog is read and validated whenever an inactive SSH endpoint is requested. It is not preloaded merely because an entry exists. Malformed catalog data does not prevent QiYan, the local endpoint, or other already-resolved endpoints from operating.

### Destination binding

On successful SSH activation, the backend normalizes the effective destination returned by `ssh -G`: host name, remote user, and port. It stores a hash of that tuple in backend-owned endpoint state under `QIYAN_HOME`, using atomic mode-0600 persistence.

If managed sessions reference the endpoint, a changed destination hash is rejected. This prevents an SSH-config edit from silently redirecting existing native thread IDs to another machine. If no managed sessions reference the endpoint, the binding may be replaced on the next successful activation. Changes to routes such as `ProxyJump` or identity-file selection do not by themselves change endpoint identity.

Renaming a catalog key creates a new endpoint identity. Removing or renaming an entry that still has managed sessions leaves those mappings intact but unavailable; the backend does not silently migrate them.

## Architecture

Higher-level services resolve an `EndpointRuntime` composed of three narrow capabilities:

- `AppServerTransport`: request/response messages, server notifications, permission events, initialization, health, and connection generations.
- `WorkspaceHost`: home discovery, canonical path identity, safe directory creation, project-root validation, and protected-root checks.
- `WorkerFileBridge`: bounded transfer for the existing QiYan-owned `send_to_session` and `prepare_chat_attachment` operations.

Session lifecycle, session registry, goals, status, model selection, notification routing, and chat adapters depend on these interfaces rather than on endpoint type. They must not contain scattered `local` versus `ssh` behavior.

The endpoint pool gains a resolver/factory. It preserves the current global turn-capacity policy and endpoint-scoped session identities. The built-in local runtime is created as it is today. SSH runtimes are created lazily, except that startup recovery activates SSH endpoints referenced by managed sessions.

### Local implementation

The `local` endpoint preserves the existing design:

- the current local App Server child process and JSONL-over-stdio transport;
- direct Node.js filesystem operations through `WorkspaceHost`;
- direct use of QiYan's retained attachment paths;
- current local Codex home, configuration, credentials, skills, and session store.

Unifying the public endpoint model does not require putting the local worker in `tmux` or converting it to a socket transport.

### SSH implementation

An SSH runtime contains separately testable components:

- an SSH configuration inspector and argument builder;
- a private ControlMaster manager when the user has not configured working multiplexing;
- a remote App Server supervisor implemented with a private `tmux` socket;
- an SSH Unix-socket tunnel;
- an App Server WebSocket transport over the locally forwarded Unix socket;
- fixed remote Linux filesystem operations; and
- streaming remote worker-file transfer operations.

Codex documents Unix-socket App Server listeners through `codex app-server --listen unix:///absolute/path.sock`. The socket uses the App Server's WebSocket framing without opening a network listener. The SSH implementation converts those frames to the same request and notification abstractions used by the local JSONL transport.

## SSH preparation and security boundary

The first release is connect-only. A usable remote host has:

- a working OpenSSH destination;
- a trusted host key already accepted by the user;
- noninteractive key or agent authentication;
- Linux;
- `codex` available from the remote login environment;
- Codex already authenticated under the remote user's own `~/.codex` or `CODEX_HOME`;
- `tmux`; and
- the bounded Linux filesystem utilities required by the remote host implementation.

The backend uses batch mode, no PTY for control and transfer channels, strict host-key checking, and bounded connection timeouts. It never uses `accept-new`, edits `~/.ssh/config`, writes `known_hosts`, initiates login, or copies credentials. The user may perform those actions directly or ask QiYan to do them with normal shell tools outside backend policy.

The checked-in App Server types remain generated reproducibly from Codex `0.142.5`, but runtime compatibility is not an exact package pin. Codex `0.142.5` is the minimum supported version for both local and SSH worker App Servers. Initialization accepts the same numeric release or any newer numeric release, including a newer release with a prerelease/build suffix, and rejects an older or unparseable version with a clear compatibility error. Required App Server behavior is still validated through initialization and capability calls. This lets users update Codex normally without forcing a matching QiYan release while preserving a defined lower compatibility boundary.

The Docker SSH fixture may continue installing and checking one exact Codex build for reproducible tests. That fixture build pin is separate from QiYan's runtime minimum-version gate.

Remote Codex uses the remote host's native configuration, auth, skills, plugins, tools, permissions, and thread store. Worker sessions are expected to use the user's normal automatic/non-approval mode; interactive approval mode is not supported by QiYan worker routing.

## SSH multiplexing

QiYan inspects effective SSH configuration with `ssh -G <endpoint>`.

- If the user already configured a usable `ControlMaster` and `ControlPath`, QiYan honors them and never owns or stops that master.
- Otherwise, QiYan creates a short private hashed control path in its local mode-0700 runtime directory and starts a process-local master with `ControlMaster=auto` and bounded `ControlPersist`.
- App Server tunnels, workspace operations, health probes, and attachment transfers reuse the master.
- Normal QiYan shutdown closes its tunnel and explicitly stops only a QiYan-owned master. A master surviving an abrupt QiYan crash expires through `ControlPersist`.

No SSH configuration file is modified. Socket paths are length-checked before use.

## Persistent remote App Server

Remote work must not depend on the lifetime of an SSH channel. Each SSH endpoint therefore has one detached App Server in QiYan's alternate tmux server. Every tmux command uses the fixed socket label `qiyan-bot`:

```text
tmux -L qiyan-bot list-sessions
```

Normal `tmux ls` uses the user's default socket and cannot see or modify QiYan's alternate server. The user can deliberately inspect it with `tmux -L qiyan-bot list-sessions`. QiYan stops only its endpoint session and never issues `kill-server` against the user's default tmux server.

Each endpoint uses a deterministic, safely encoded session name and a short private App Server runtime path. The App Server runtime directory is mode 0700 and its socket is owner-only. The first release assumes one QiYan deployment manages the `qiyan-bot` tmux server for a given remote operating-system account.

The tmux session launches the remote login environment and then:

```text
codex app-server --listen unix://<private-runtime>/app-server.sock
```

The App Server exposes no TCP port. The tmux pane is not used as a protocol channel and is not automatically captured or logged by QiYan.

### Connection flow

When activating an SSH endpoint, the backend:

1. validates the catalog entry and resolved destination binding;
2. completes the SSH, Linux, command, Codex, auth, and `tmux` preflight;
3. checks the endpoint session through `tmux -L qiyan-bot`;
4. removes an owned stale App Server socket only when the private tmux session is proven absent;
5. starts the detached App Server if absent;
6. creates a private local Unix socket forwarded to the remote App Server socket;
7. completes the WebSocket upgrade and normal App Server initialization; and
8. restores managed subscriptions and reconciles session state.

If the dedicated tmux session exists but its App Server socket remains unhealthy after a bounded startup grace period, QiYan reports the runtime as unhealthy. It does not automatically kill a process that may still contain active work.

### Connection loss

SSH keepalives detect a dead tunnel. Tunnel loss increments the local runtime generation and makes endpoint operations temporarily unavailable, but it does not stop the remote tmux session or active Codex turn.

While managed sessions reference the endpoint, QiYan reconnects with bounded exponential backoff. After SSH returns, it recreates the tunnel, connects to the existing App Server, initializes a new client connection, restores subscriptions, reads managed threads, and reconciles messages completed while disconnected. Stale callbacks and notifications from earlier connection generations are ignored.

Ordinary QiYan shutdown closes local tunnels but leaves remote App Servers running. On the next QiYan start, every SSH endpoint referenced by a managed session is reconnected automatically. Unused catalog endpoints remain dormant.

If the remote host rebooted or the private tmux session genuinely disappeared, QiYan starts a new App Server and resumes persisted native threads from the remote Codex store. It never replays an uncertain user operation automatically.

## Endpoint lifecycle tools

Worker tools accept an optional endpoint and normalize an omitted value to `local` before policy or registry work.

### `disconnect_endpoint(endpoint?)`

- Defaults to `local`.
- Proves all managed turns on the endpoint are idle. If the endpoint is unreachable and idleness cannot be proven, it refuses rather than risking active work.
- For `local`, shuts down the existing worker App Server.
- For SSH, closes the tunnel and stops the endpoint session through `tmux -L qiyan-bot`.
- Preserves native Codex threads, catalog data, endpoint bindings, and managed session mappings.
- Is a runtime disconnect, not a persistent disable. A later endpoint operation, or startup recovery for managed sessions, may activate it again.

### `restart_endpoint(endpoint?)`

- Defaults to `local`.
- Refuses unless every managed turn on the endpoint is proven idle.
- Validates the endpoint definition and reachable prerequisites before stopping the current runtime.
- Performs a generation-fenced stop and start.
- Reinitializes the App Server, restores subscriptions, and reconciles all managed sessions.
- Reloads process-startup-scoped Codex environment and configuration changes.
- If restart fails after stopping, only that endpoint remains unavailable; QiYan and other endpoints continue.

No separate `start_endpoint` tool is required because endpoint-scoped operations activate disconnected endpoints lazily.

## Workspace policy

The same workspace policy applies to local and SSH endpoints through `WorkspaceHost`:

- Explicit project paths are absolute or begin with `~/` and are resolved on the selected endpoint.
- Existing directories are canonicalized and identified by device and inode.
- A missing final directory may be created only after its existing parent is canonicalized and accepted.
- Symlink escapes, protected-root overlap, non-directory paths, and identity changes between reservation and promotion are rejected.
- Native cwd is validated when discovering or adopting an existing thread.
- Generation-safe reservation and promotion, duplicate endpoint/thread identity protection, and rollback after proven subscription remain unchanged.

If the user does not provide a suitable remote project location, QiYan uses that endpoint's `projects_root`, defaulting to `~/qiyan-projects/<semantic-project-name>`. The local endpoint retains its existing semantic placement and fallback behavior.

The first SSH implementation supports Linux hosts only. Remote filesystem operations are fixed and audited. Paths and operation parameters are transported as data and are never interpolated into arbitrary user-controlled shell commands.

## Explicit QiYan-managed worker file transfers

Chat attachment ingress and delivery remain owned by QiYan. Workers do not call chat tools, and the backend does not copy every chat attachment or every worker-created file automatically. `WorkerFileBridge` exists only behind two current QiYan tool paths.

### `send_to_session` attachments

When a user sends files through a chat adapter, QiYan ingests them into its existing private retained attachment store. The assistant may explicitly select attachment IDs from its active attempt in:

```json
{
  "nickname": "novel-56",
  "content": "Read the attached requirements.",
  "attachment_ids": ["file_abc123"],
  "mode": "start"
}
```

The existing attempt-scope checks continue to reject invented, expired, or unrelated attachment IDs. `/pass` continues to require the exact source attachment IDs in their original order.

For a local worker, the retained local path is passed to Codex as it is today. For an SSH worker, `WorkerFileBridge` uploads only the selected IDs to a private remote staging directory, writes each file atomically with restrictive permissions, verifies byte count and SHA-256, and passes the verified remote path to Codex. Repeated use may reuse a verified content-addressed object. Interrupted temporary files and expired staged objects are cleaned up best-effort.

The flow is:

```text
chat attachment -> QiYan attachment store -> send_to_session -> selected worker
```

### `prepare_chat_attachment` from a worker project

When QiYan wants to send a project file to the user, it explicitly calls:

```json
{
  "owner": "novel-56",
  "relative_path": "output/report.txt"
}
```

`owner` is either `assistant` or a managed worker nickname. The backend resolves a worker owner to that session's endpoint and project root. It accepts only a regular file canonically contained by the project, rejects traversal and symlink escapes, and enforces existing file-size limits.

For the assistant or a local worker, QiYan snapshots the local file as it does today. For an SSH worker, `WorkerFileBridge` streams that one selected remote file into a temporary object in QiYan's local attachment store, verifies its size, and atomically promotes it. The existing `send_chat_attachment({"file_handle":"file_def456","caption":"Here is the report."})` operation then delivers the ordinary retained local handle and requires no endpoint-specific behavior.

The reverse flow is:

```text
selected worker project file -> prepare_chat_attachment -> QiYan attachment store -> send_chat_attachment -> chat
```

## Notification and delivery recovery

Remote App Server work may finish while the SSH tunnel or QiYan is unavailable. Each managed session therefore keeps an automatic delivery checkpoint based on native turn/item identity. The checkpoint is backend-owned state; QiYan's assistant treats it as read-only.

On every connection generation and startup recovery, QiYan reads managed thread history and compares visible non-tool assistant items with the checkpoint. Missing items are handed to the existing outbound chat delivery path in native order. Successfully handled items advance the checkpoint, preventing intentional replay during repeated reconnects. Tool events remain excluded from user-visible worker messages.

The assistant receives the same compact worker metadata notifications as today, not an automatic copy of every worker message. Full worker messages are still delivered directly to the user under the session nickname.

If an endpoint becomes unreachable, the backend emits one transition warning. It suppresses repeated retry spam and emits one recovery notice after reconnection. A failed endpoint does not block the local endpoint, the assistant, chat adapters, or other SSH endpoints.

## QiYan instructions and user flow

Managed `AGENTS.md` guidance explains:

- `local` is the default endpoint;
- SSH endpoint keys are the user's OpenSSH host aliases;
- how to read and safely edit `endpoints.json`;
- that session JSON and backend endpoint state are read-only;
- how to inspect `~/.ssh/config` and use `ssh -G` and normal SSH commands;
- remote prerequisites and the connect-only boundary;
- per-endpoint project-root behavior;
- that remote project sessions use the remote user's Codex config and skills;
- that QiYan asks when the intended endpoint is ambiguous;
- how `disconnect_endpoint` and `restart_endpoint` behave; and
- how to inspect `tmux -L qiyan-bot` deliberately without confusing it with normal user tmux sessions.

A typical flow is:

1. The user asks QiYan to use an existing SSH host.
2. QiYan inspects SSH aliases and checks normal connectivity, Codex auth, Linux, and `tmux` with ordinary shell tools.
3. With user intent established, QiYan edits `endpoints.json`.
4. QiYan calls an ordinary endpoint-aware session operation such as discovery, creation, or adoption.
5. The backend validates and activates the endpoint.

The backend returns precise errors if QiYan's preliminary checks missed anything, allowing QiYan to explain or correct catalog data without guessing.

## Errors and diagnostics

Errors remain typed and endpoint-scoped. Important categories include:

- catalog syntax, version, field, and missing-entry errors;
- reserved or invalid endpoint identifiers;
- resolved destination rebind rejection;
- SSH host trust, authentication, timeout, and unreachable-host failures;
- unsupported remote operating system;
- missing remote `codex`, `tmux`, or required Linux command;
- unauthenticated or incompatible App Server;
- private tmux runtime missing or unhealthy;
- tunnel and WebSocket handshake failure;
- workspace safety rejection;
- attachment validation, transfer, and checksum failure;
- inability to prove idle state for disconnect or restart; and
- recovery failure.

Errors expose the endpoint ID, failed stage, and actionable next step without returning arbitrary remote output. Logs never contain Telegram or other chat message bodies, attachment contents, bot tokens, Codex credentials, complete SSH configuration, or authentication payloads. Child-process environments are never logged.

## Testing strategy

The ordinary repository suite remains offline and credential-free.

### Unit and contract tests

- Strict endpoint-catalog parsing, defaults, unknown fields, and actionable paths.
- Endpoint normalization with omitted arguments defaulting to `local`.
- Resolved SSH destination binding and safe rebinding only without managed sessions.
- SSH argument construction, batch/host-key policy, timeouts, and shell-injection resistance.
- User-configured versus QiYan-owned ControlMaster behavior without SSH-config writes.
- Consistent `tmux -L qiyan-bot` command construction and proof that no command touches the default tmux server.
- Local and SSH `WorkspaceHost` contract suites covering canonical identity, safe creation, symlinks, protected roots, and reservation races.
- Explicit `send_to_session` upload and `prepare_chat_attachment` download, including content reuse, checksum mismatch, interruption cleanup, bounds, traversal, and symlink rejection.
- Lazy endpoint creation, startup activation for managed sessions, generation fencing, backoff, and failure isolation.
- `disconnect_endpoint` and `restart_endpoint` local/SSH behavior, including active and unprovable-idle rejection.
- Delivery reconciliation and deduplication across repeated reconnects.
- Sanitized errors and logs.

### Docker SSH integration

The existing reusable SSH worker fixture is extended to include `tmux` while keeping authentication external to the image and repository. Deterministic integration tests use a protocol fixture where model execution is unnecessary; opt-in live acceptance uses the authenticated Codex installation.

Integration coverage proves:

1. strict SSH connectivity and preflight;
2. private tmux/App Server startup on a Unix socket;
3. local Unix-socket forwarding and App Server initialization;
4. multiple native threads through one remote App Server;
5. project creation and native-cwd validation on the remote host;
6. attachment upload and download round trips;
7. interruption of only the SSH tunnel during an active turn;
8. survival of the same remote App Server process and completion of the turn;
9. reconnection and one backend delivery of the completed assistant item;
10. QiYan-process restart followed by reconnection to the same remote runtime;
11. remote runtime loss followed by a new App Server and native-thread resume;
12. explicit endpoint restart and disconnect; and
13. proof that `tmux -L qiyan-bot` is invisible to and does not alter the user's default tmux server.

Malformed catalog, changed destination, untrusted host, missing auth, missing `tmux`, and remote-unavailable scenarios are also exercised without taking down local functionality.

Before implementation is considered complete, `npm run check` must pass and the documented Docker-backed acceptance flow must pass on the development machine. The live test must not print or package credentials, message content, or attachment content.

## Documentation and packaging

The distributable package adds the endpoint example and remote-worker documentation to its published files. Documentation covers:

- Linux, OpenSSH, Codex auth, and `tmux` prerequisites;
- SSH alias and host-trust setup;
- endpoint catalog format;
- local-default behavior;
- remote project roots;
- persistent runtime and `tmux -L qiyan-bot` inspection;
- exact examples for sending a chat attachment to a worker and sending a selected worker project file back to chat;
- disconnect, restart, recovery, and failure semantics;
- attachment behavior and storage; and
- troubleshooting without exposing secrets.

The feature is described as SSH remote-worker support, not remote provisioning. The existing Docker fixture remains development infrastructure and is not installed on user hosts.

## References

- [Codex App Server](https://developers.openai.com/codex/app-server)
- [Codex remote connections](https://developers.openai.com/codex/remote-connections)
- OpenSSH `ssh(1)` local Unix-socket forwarding and `ssh_config(5)` ControlMaster options
- Repository design: `docs/superpowers/specs/2026-07-05-reusable-ssh-worker-fixture-design.md`

# SSH worker endpoints

QiYan can run ordinary project sessions on remote Linux machines while the assistant remains local. The remote Codex App Server runs in a detached tmux session with a private per-endpoint control socket, so a dropped SSH connection does not abort its turn. Local remains the default endpoint.

## Remote requirements

Install Node.js 24 or newer, `tmux`, and Codex 0.144.4 or newer on the remote host. Authenticate Codex on that host as the SSH user and configure its normal Codex profile for non-interactive automatic work; chat approvals are unsupported. QiYan does not copy local authentication or configuration.

Verify the host key yourself. QiYan needs ordinary command channels only; TCP, stream-local, agent, X11, and tunnel-device forwarding can remain disabled. The endpoint name is an alias in the normal user SSH configuration.

For key authentication, a minimal configuration is:

```sshconfig
Host devbox
  HostName devbox.example
  User xin
  IdentityFile ~/.ssh/id_ed25519_devbox
  IdentitiesOnly yes
```

Prove unattended access before asking QiYan to use it:

```bash
ssh -o BatchMode=yes -o StrictHostKeyChecking=yes devbox true
ssh devbox 'node --version; tmux -V; codex --version; codex login status'
```

For an endpoint that requires interactive MFA, configure a persistent user-owned ControlMaster:

```sshconfig
Host devbox
  HostName devbox.example
  User xin
  ControlMaster auto
  ControlPath ${XDG_RUNTIME_DIR}/qiyan-ssh-%C
  ControlPersist yes
  ServerAliveInterval 15
  ServerAliveCountMax 3
```

Authenticate once interactively and verify the master before starting QiYan:

```bash
ssh devbox true
ssh -O check devbox
```

The ControlMaster socket must be in a canonical private filesystem directory owned by the service user. `${XDG_RUNTIME_DIR}` is the preferred location because it is local, private per-user runtime storage on a normal Linux login or systemd user session, so no extra directory is needed. An NFS-backed user-owned ControlMaster is also accepted when its directory and socket pass the same ownership, type, canonical-path, and mode checks; the subsequent `ssh -O check` and real helper/proxy commands remain the authoritative liveness checks. The server-alive settings keep an otherwise idle master active across network timeouts and make a dead connection fail within a bound. Otherwise QiYan falls back without contacting an unsafe socket. A usable master supplies noninteractive MFA; if it is absent, QiYan tries its private BatchMode ControlMaster, so key-authenticated endpoints continue automatically while MFA-only endpoints wait for you to authenticate a user-owned master. QiYan does not stop or replace a user-owned master.

The optional web UI's remote file features (browse, preview, download, upload, and git for a remote worker) **reuse this same ControlMaster** — they run `ssh -G` to discover the effective `ControlPath` and connect with `ControlMaster=no`, so they only ride the master QiYan already established and never open a second connection (important for MFA hosts, which allow only one authenticated login). These features therefore work only while that master is up; if it is down they fail fast with "remote host not connected". Browse, upload, and Git operations are confined to the worker's project directory; preview/download retains the documented owner-only readable-path policy. Uploads are size-capped, never overwrite a destination, and publish a complete staged file atomically.

QiYan never accepts a new host key automatically. Handle first connection and host-key changes through ordinary OpenSSH yourself, or explicitly ask QiYan to help inspect them.

## Endpoint catalog

Create `~/.qiyan-bot/endpoints.json` as strict JSON with owner-only permissions:

```json
{
  "version": 1,
  "endpoints": {
    "devbox": {
      "provider": "codex",
      "transport": "ssh",
      "host": "devbox",
      "projects_root": "~/qiyan-projects"
    },
    "claude-local": {
      "provider": "claude",
      "transport": "local",
      "model": "opus"
    },
    "devbox-claude": {
      "provider": "claude",
      "transport": "ssh",
      "host": "devbox",
      "model": "sonnet"
    }
  }
}
```

```bash
chmod 600 "$HOME/.qiyan-bot/endpoints.json"
```

Every configurable endpoint — local or remote, Codex or Claude — is declared here. Each entry has a `provider` (`codex` | `claude`) and a `transport` (`local` | `ssh`), which are independent. `host` is the SSH alias, required for `ssh` and forbidden for `local`; the map key is the endpoint id (decoupled from the alias). `projects_root` is optional (default `~/qiyan-projects`), forbidden for `local`. Claude entries may pin `model` and `effort`. Codex runs only over `ssh` (a local Codex worker is the built-in `local` endpoint). At most one `claude`/`local` endpoint is allowed. Remote (`ssh`) endpoints are read on demand — edits take effect without a restart; **local endpoint changes require a restart**. A malformed file is rejected with its field path.

You can then ask QiYan to create or adopt a session on `devbox`, inspect its models, disconnect it, or restart it. `disconnect_endpoint` and `restart_endpoint` default to local when no endpoint is supplied. Disconnect/restart refuses active or unprovable managed threads.

Attachments cross the SSH boundary only through explicit tools. Files selected in `send_to_session({nickname, content, attachment_ids, mode})` are hash-verified and staged in the selected worker runtime before the turn is dispatched. `prepare_chat_attachment({owner, relative_path})` reads one regular file below that managed project's root, verifies it, and imports it into QiYan's local attachment store; `send_chat_attachment({file_handle, caption?})` remains chat-platform neutral. QiYan does not mirror project trees or upload unrelated chat attachments.

QiYan resolves `ssh -G` on every connection generation and pins the resulting host, user, and port. If that destination changes while sessions or unresolved work still reference the endpoint, activation is rejected instead of silently moving thread IDs to another machine.

Remote helper commands and the App Server user-space proxy use the same endpoint ControlMaster. Each connection generation prefers a live configured user master and otherwise selects a private QiYan-owned master. Before a selected user-owned socket is used, QiYan revalidates its local identity; the actual helper or proxy command is the authoritative liveness check. The proxy connects to the App Server Unix socket as the authenticated login user, then rechecks the exact socket inode and runtime identity before declaring readiness. QiYan strips the private readiness preamble, carries the WebSocket directly over that command channel, and treats WebSocket or SSH closure as connection loss. QiYan keeps its own key-authenticated master for the service lifetime and exits it during normal shutdown; it never exits a user-owned MFA master.

The remote helper, App Server socket, identity, and tmux socket prefer `${XDG_RUNTIME_DIR}/qiyan-bot/<endpoint-hash>` after QiYan verifies that XDG runtime storage is canonical, same-user, private, non-NFS, and short enough for Unix sockets. Hosts without a valid XDG runtime directory fall back to `/tmp/qiyan-<uid>` only when `/tmp` has safe ownership and sticky/write semantics. This shared runtime root matters on MFA services that expose an isolated `/tmp` to each SSH channel even when those channels reuse one authenticated ControlMaster. QiYan executes locally digest-pinned helper bytes for every remote operation rather than trusting the cached remote helper, and revalidates the runtime root on every runtime-bearing operation. During an upgrade it reuses a healthy legacy `tmux -L qiyan-bot` App Server instead of starting a duplicate; after that exact generation is stopped, the next start uses the per-endpoint socket. The remote App Server uses its ordinary WebSocket API and has no SSH-specific behavior. Local endpoints never use SSH.

Ordinary `tmux ls` does not inspect QiYan's detached servers. To inspect a new App Server without loading user tmux configuration, use the endpoint's socket on the worker host:

```bash
tmux -S "${XDG_RUNTIME_DIR}/qiyan-bot/<endpoint-hash>/tmux.sock" -f /dev/null list-sessions
```

For a legacy generation that has not yet been stopped, use `tmux -L qiyan-bot -f /dev/null list-sessions`.

On QiYan startup, only endpoints referenced by managed sessions or unresolved work are contacted. An unavailable SSH endpoint does not prevent local sessions or other endpoints from starting; its sessions remain marked unavailable and reconnect automatically. Active and provisionally dispatched turn capacity stays reserved until full native history proves it terminal or absent. Normal QiYan shutdown closes SSH transports but intentionally leaves detached remote App Servers running; `disconnect_endpoint` is the explicit idle-only runtime shutdown.

## Development fixture

The repository’s [Docker SSH fixture](development/ssh-worker-fixture.md) provides a reusable localhost server with persistent but image-external Codex authentication. It is suitable for transport-loss and restart testing without a second physical machine.

# SSH worker endpoints

QiYan can run ordinary project sessions on remote Linux machines while the assistant remains local. The remote Codex App Server runs in an isolated `tmux -L qiyan-bot -f /dev/null` server, so a dropped SSH tunnel does not abort its turn. Local remains the default endpoint.

## Remote requirements

Install Node.js 24 or newer, `tmux`, and Codex 0.142.5 or newer on the remote host. Authenticate Codex on that host as the SSH user and configure its normal Codex profile for non-interactive automatic work; chat approvals are unsupported. QiYan does not copy local authentication or configuration.

Verify the host key yourself. The SSH daemon must permit local Unix-socket forwarding (`AllowStreamLocalForwarding local`); TCP, agent, X11, and tunnel-device forwarding are not required. The endpoint name is an alias in the normal user SSH configuration.

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
  ControlPath ${XDG_RUNTIME_DIR}/qiyan-ssh-controlmasters/%C
  ControlPersist yes
  ServerAliveInterval 15
  ServerAliveCountMax 3
```

Create its private socket directory, authenticate once interactively, and verify the master before starting QiYan:

```bash
install -d -m 700 "${XDG_RUNTIME_DIR:?}/qiyan-ssh-controlmasters"
ssh devbox true
ssh -O check devbox
```

The ControlMaster directory must be on a private local filesystem. NFS-backed ControlMaster sockets are not supported; OpenSSH cannot reliably retain or address them. `${XDG_RUNTIME_DIR}` is local per-user runtime storage on a normal Linux login or systemd user session. The server-alive settings keep an otherwise idle master active across network timeouts and make a dead connection fail within a bound. QiYan requires both the directory and socket to be canonical same-user objects without group or world permissions and rejects an NFS directory before dispatch. It reuses that authenticated connection and does not prompt for MFA. If the master exits or expires, the remote endpoint becomes unavailable until you authenticate a new master; QiYan does not stop or replace a user-owned master.

QiYan never accepts a new host key automatically. Handle first connection and host-key changes through ordinary OpenSSH yourself, or explicitly ask QiYan to help inspect them.

## Endpoint catalog

Create `~/.qiyan-bot/endpoints.json` as strict JSON with owner-only permissions:

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

```bash
chmod 600 "$HOME/.qiyan-bot/endpoints.json"
```

The object key must match the SSH alias. `projects_root` is optional and defaults to `~/qiyan-projects` on that host. QiYan reads the catalog when an inactive endpoint is requested, so edits do not require a bot restart. A malformed file is rejected with its field path.

You can then ask QiYan to create or adopt a session on `devbox`, inspect its models, disconnect it, or restart it. `disconnect_endpoint` and `restart_endpoint` default to local when no endpoint is supplied. Disconnect/restart refuses active or unprovable managed threads.

Attachments cross the SSH boundary only through explicit tools. Files selected in `send_to_session({nickname, content, attachment_ids, mode})` are hash-verified and staged in the selected worker runtime before the turn is dispatched. `prepare_chat_attachment({owner, relative_path})` reads one regular file below that managed project's root, verifies it, and imports it into QiYan's local attachment store; `send_chat_attachment({file_handle, caption?})` remains chat-platform neutral. QiYan does not mirror project trees or upload unrelated chat attachments.

QiYan resolves `ssh -G` on every connection generation and pins the resulting host, user, and port. If that destination changes while sessions or unresolved work still reference the endpoint, activation is rejected instead of silently moving thread IDs to another machine.

Remote helper commands and the App Server Unix-socket forward use the same endpoint ControlMaster. Every operation on a user-owned master first verifies it and cannot create a replacement. QiYan registers the forward with `ssh -O forward`, requests cancellation with `ssh -O cancel`, verifies that the exact local listener actually stopped, safely reclaims its private socket after a process crash, and uses App Server WebSocket closure as the connection-loss event. QiYan keeps its own key-authenticated master for the service lifetime and exits it during normal shutdown; it never exits a user-owned MFA master. The remote App Server uses its ordinary WebSocket API and has no SSH-specific behavior. Local endpoints never use SSH.

Ordinary `tmux ls` does not inspect QiYan's isolated server. To inspect its detached App Servers without loading user tmux configuration, run this on the worker host:

```bash
tmux -L qiyan-bot -f /dev/null list-sessions
```

On QiYan startup, only endpoints referenced by managed sessions or unresolved work are contacted. An unavailable SSH endpoint does not prevent local sessions or other endpoints from starting; its sessions remain marked unavailable and reconnect automatically. Active and provisionally dispatched turn capacity stays reserved until full native history proves it terminal or absent. Normal QiYan shutdown closes SSH transports but intentionally leaves detached remote App Servers running; `disconnect_endpoint` is the explicit idle-only runtime shutdown.

## Development fixture

The repository’s [Docker SSH fixture](development/ssh-worker-fixture.md) provides a reusable localhost server with persistent but image-external Codex authentication. It is suitable for tunnel-loss and restart testing without a second physical machine.

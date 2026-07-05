# SSH worker endpoints

QiYan can run ordinary project sessions on remote Linux machines while the assistant remains local. The remote Codex App Server runs in an isolated `tmux -L qiyan-bot -f /dev/null` server, so a dropped SSH tunnel does not abort its turn. Local remains the default endpoint.

## Remote requirements

Install Node.js 24 or newer, `tmux`, and Codex 0.142.5 or newer on the remote host. Authenticate Codex on that host as the SSH user and configure its normal Codex profile for non-interactive automatic work; chat approvals are unsupported. QiYan does not copy local authentication or configuration.

Configure key-only OpenSSH access and verify the host key yourself. The endpoint name is an alias in the normal user SSH configuration. For example:

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

## Development fixture

The repository’s [Docker SSH fixture](development/ssh-worker-fixture.md) provides a reusable localhost server with persistent but image-external Codex authentication. It is suitable for tunnel-loss and restart testing without a second physical machine.

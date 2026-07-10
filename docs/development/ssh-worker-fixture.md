# SSH worker development fixture

## Development fixture for remote-worker support

This Docker Compose fixture models a separate Linux machine for testing QiYan's SSH endpoint pool. It provides key-only SSH, an independently authenticated Codex profile, and persistent remote projects. QiYan's production endpoint uses a detached tmux App Server plus a ControlMaster-registered local Unix-socket forward to its private socket; the fixture check retains a short stdio probe as a prerequisite diagnostic.

The fixture is **source checkout only**. Its Docker files, TypeScript helpers, and npm development commands are not included in the QiYan release archive.

## Requirements

- Linux with Docker Engine and the Docker Compose CLI plugin that provides `docker compose`
- Node.js 24 and this repository's development dependencies (`npm ci`)
- `ssh`, `ssh-keygen`, and `ssh-keyscan` on the host
- outbound access from the image build to install the pinned Codex CLI

The SSH port is published only on `127.0.0.1`. The default is `2222`; set `QIYAN_SSH_WORKER_PORT` consistently for every command to select another unused local port.

## First run and independent authentication

From the repository root, build and start the worker:

```bash
npm run ssh-worker:up
```

This creates a dedicated client key, starts the Compose project, validates the effective SSH daemon policy, pins its Ed25519 host key, and proves strict key authentication. Generated host state lives below `.tmp/ssh-worker`; it must never be committed.

Authenticate the remote Codex profile deliberately:

```bash
npm run ssh-worker:login
```

This runs `codex login --device-auth` in the container through an inherited terminal. Complete the official device authentication flow yourself. The helper does not capture or copy the device code, token, or `auth.json`, and the login is independent from the host's Codex profile.

Then verify the complete boundary:

```bash
npm run ssh-worker:check
npm run ssh-worker:endpoint-check
```

The first check validates the remote `HOME`, `CODEX_HOME`, projects directory, exact pinned Codex version, App Server `initialize` response, and `account/read`. The endpoint check requires that independent login, starts the real detached App Server under QiYan's isolated tmux server, registers the same ControlMaster stream-local forward used in production, creates a thread in the fixture project directory, cancels only the forward, reconnects, and verifies the same attested runtime identity. It does not send a model task. Before login, the first check reports `authentication required` and the endpoint check intentionally fails.

## Daily operation and persistence

Use:

```bash
npm run ssh-worker:up
npm run ssh-worker:check
npm run ssh-worker:down
```

Ordinary `ssh-worker:down` removes the service container but retains the Codex profile, projects, and SSH host-key volumes as well as the host-side client key and trust state. Rebuilding or restarting therefore preserves device authentication and test projects.

For manual inspection, use only the generated strict configuration:

```bash
ssh -F .tmp/ssh-worker/config qiyan-ssh-worker
```

That configuration sets `IdentitiesOnly yes`, `StrictHostKeyChecking yes`, a fixture-specific `UserKnownHostsFile`, and forwarding restrictions. It does not modify `~/.ssh/config`.

The prerequisite App Server probe has this shape:

```bash
ssh -T -F .tmp/ssh-worker/config qiyan-ssh-worker codex app-server --listen stdio://
```

The current check opens that transport only long enough to initialize and read authentication status.

## Reset and secret handling

Only reset removes persistent fixture data:

```bash
npm run ssh-worker:reset
```

Type exactly `reset` at the prompt, or use `npm run ssh-worker:reset -- --yes` for deliberate noninteractive cleanup. Reset deletes the fixture's Compose volumes, remote Codex credentials, remote projects, server host key, and generated `.tmp/ssh-worker` files. It does not touch another checkout's Compose project or SSH state.

Authentication, private keys, host trust, and project files are runtime secrets or state. Never add them to Git, a Docker build context, an image layer, or a release package. The image contains no authentication material; device authentication writes only to its persistent runtime volume.

## Troubleshooting

- `Docker Compose is not available`: install a Compose CLI plugin that provides the exact `docker compose` command. The legacy standalone `docker-compose` command is not used.
- Port conflict: choose an unused loopback port with `QIYAN_SSH_WORKER_PORT`, and use the same value for `up`, `login`, `check`, and `down`.
- Host-key mismatch: do not bypass `StrictHostKeyChecking`. Confirm that you intended to replace the fixture, then use the explicit reset flow before starting again.
- `authentication required`: run `npm run ssh-worker:login`; never copy the host's credential file into the volume.
- Codex version mismatch: rebuild with the repository's pinned version. A deliberate test override must use the same `QIYAN_SSH_WORKER_CODEX_VERSION` for startup and checks.
- Changed generated files or unsafe permissions: stop, inspect `.tmp/ssh-worker`, and use reset if the fixture should be discarded. The helper fails closed instead of repairing suspicious state.

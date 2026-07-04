# Reusable SSH Worker Fixture Design

**Date:** 2026-07-05

**Status:** Approved for implementation planning

## Purpose

Create a committed, reusable Docker fixture that behaves like a separate SSH host with Codex installed. The fixture will let QiYan's future remote-worker transport be developed and tested on one machine without weakening the boundary between local and remote Codex environments.

The fixture is development infrastructure, not a production remote-worker implementation. It must reproduce the properties QiYan will depend on: key-only SSH, an independent remote home and `CODEX_HOME`, persistent remote projects and credentials, Codex on the remote login shell's `PATH`, and a Codex App Server reachable over SSH standard input/output.

## Approach

Use a repository-owned Dockerfile and Docker Compose service. This is preferred over installing Codex each time a generic SSH image starts because the Codex version is reproducible and startup does not depend on npm. It is also preferred over installing all of QiYan inside the container because the initial fixture needs to model only a remote Codex worker.

The fixture will live below `docker/ssh-worker/`. A small Node.js helper below `scripts/` will handle the operations that Compose cannot safely perform alone: generating a dedicated client key, waiting for SSH readiness, pinning the server host key, invoking device login, and running the live acceptance check. Package scripts will provide the supported user-facing commands.

## Container

The image will:

- use `node:24-bookworm-slim`;
- install OpenSSH server, Git, and CA certificates;
- install `@openai/codex@0.142.5` by default at image-build time;
- allow the pinned Codex version to be replaced through an explicit build argument;
- create an unprivileged `codex` user with `/home/codex` as its home; and
- run only the SSH daemon as the long-lived container process.

The image will not contain QiYan, Codex authentication, SSH private keys, project data, host-specific configuration, or generated host keys. The container entrypoint will create SSH host keys in their persistent private volume when absent, install the mounted test public key as the `codex` user's `authorized_keys`, enforce private ownership and modes, and start `sshd` in the foreground.

SSH configuration will disable root login, password authentication, keyboard-interactive authentication, empty passwords, and forwarding that the fixture does not need. Public-key authentication and standard-input/output execution must remain enabled so the host can run:

```bash
ssh -F .tmp/ssh-worker/config qiyan-ssh-worker codex app-server --listen stdio://
```

## Compose topology and persistence

Docker Compose will define one `ssh-worker` service. It will publish container port 22 only on `127.0.0.1`, using host port 2222 by default. A configurable host port may be supplied to resolve local conflicts without editing committed files.

Named Docker volumes will independently persist:

- `/home/codex/.codex` for the remote Codex profile and authentication;
- `/home/codex/projects` for remote test projects; and
- SSH server host keys.

`docker compose down` and the supported `ssh-worker:down` command will retain these volumes. Only the explicit reset operation will remove them. This lets device authentication and remote test state survive image rebuilds and ordinary restarts while preserving the option to return to a clean remote machine.

## Host SSH state

The helper will generate a dedicated Ed25519 client key on first use. Both key files, the fixture-specific `known_hosts` file, and a generated SSH client config will live under `.tmp/ssh-worker/`, which is already excluded from Git and package output. The config will define only the `qiyan-ssh-worker` alias with the loopback host, configured port, `codex` user, dedicated identity, dedicated host-key file, `IdentitiesOnly yes`, and strict host-key checking; it will not modify `~/.ssh/config`. The private key is never mounted into the container; only its public key is mounted read-only.

After the first healthy container start, the helper will obtain the server public host key through the local published port and pin it in the dedicated `known_hosts` file. Subsequent SSH commands will require strict host-key verification against that file. An unexpected host-key change will fail closed with reset/recovery guidance; the helper will never silently replace a trusted key or use `StrictHostKeyChecking=no`.

Generated client keys, host records, Codex credentials, project data, tokens, and authentication output will not be committed, packaged, or logged. Codex's `auth.json` is treated as a password.

## Commands and user flow

The supported flow will be:

1. `npm run ssh-worker:up` checks for Docker Compose, creates the dedicated client key if needed, builds and starts the service, waits for the SSH health boundary, and pins or verifies the server host key.
2. `npm run ssh-worker:login` runs `codex login --device-auth` interactively as the remote `codex` user. Authentication is a deliberate user action and is stored only in the Codex Docker volume.
3. `npm run ssh-worker:check` performs the live acceptance checks described below.
4. `npm run ssh-worker:down` stops and removes the service container while retaining volumes and host-side SSH state.
5. `npm run ssh-worker:reset` requires an interactive `reset` confirmation, removes the fixture's service and named volumes, and deletes only `.tmp/ssh-worker/` generated state. A deliberate `--yes` option permits noninteractive fixture cleanup.

The helper will use argument arrays rather than shell interpolation for subprocesses. It will print operation names and bounded diagnostics, not command environments, credentials, authentication payloads, project contents, or App Server message bodies.

## Health and failure handling

The container health check will test the SSH daemon locally. The host helper will separately prove the real boundary by making a strict key-authenticated SSH connection through `127.0.0.1`.

Failures will be actionable and distinct:

- missing Docker or Docker Compose;
- image build or service startup failure;
- host port already in use;
- SSH daemon unhealthy or readiness timeout;
- client-key rejection;
- missing or changed pinned host key;
- Codex missing from the remote login shell's `PATH`;
- Codex version mismatch; and
- Codex present but not authenticated.

Startup and checks will be bounded by timeouts and will clean up their child processes. Ordinary `down` will not delete state. Reset will be the only destructive operation and will name the fixture-owned state it is about to remove before asking for confirmation.

## Verification

The normal repository test suite must not require Docker, network access, or credentials. Unit tests will exercise the helper's path resolution, generated SSH arguments, readiness timeout, process failure mapping, host-key mismatch handling, reset confirmation, and redacted output with temporary directories and fake process runners. Tests will verify that repository package contents and ignore rules exclude generated SSH and authentication state.

The opt-in live check will:

1. build and start the actual Compose fixture;
2. connect through the published SSH port with the dedicated key and strict host-key verification;
3. verify the expected remote user, home, and project directory;
4. verify that `codex --version` matches the image's pinned or explicitly overridden version;
5. start `codex app-server --listen stdio://` over the SSH stream;
6. complete a bounded JSONL `initialize` request/response exchange; and
7. query authentication state without printing credentials.

Before device login, the live check may report `authentication required` only after the SSH, environment, Codex, and App Server transport checks pass. After the user completes device login, the whole acceptance check must pass. The check will not create a Codex thread or send a model task.

Before commit, `npm run check` must pass. The Docker-backed acceptance command will also be run on the current development machine, first far enough to prove the unauthenticated boundary and then fully after interactive device authorization.

## Documentation

Repository documentation will describe prerequisites, first startup, device authorization, daily start/stop commands, the reset boundary, configurable host port, the generated SSH alias/arguments, and troubleshooting for host-key and authentication failures. It will explicitly state that secrets are runtime state and must never be added to the image or repository.

The documentation will also show the future QiYan endpoint command shape without claiming that remote-worker routing is already implemented.

## Non-goals

- Implementing QiYan's SSH App Server endpoint or endpoint pool in this change.
- Installing or running the QiYan service inside the worker container.
- Baking, copying, or bind-mounting the host's existing `~/.codex` profile into the image.
- Automating OpenAI login or copying `auth.json` without an explicit user action.
- Exposing SSH beyond the local loopback interface.
- Modeling multiple remote hosts, network partitions, SSH jump hosts, or production hardening beyond the fixture's trust boundary.

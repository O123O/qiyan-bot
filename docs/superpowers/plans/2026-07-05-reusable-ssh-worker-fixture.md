# Reusable SSH Worker Fixture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable, secret-free Docker Compose fixture that exposes an independently authenticated Codex App Server through strict key-only SSH on localhost.

**Architecture:** A Codex-version-pinned Docker image and Compose service model the remote host. A testable TypeScript support module owns all generated host state, subprocess boundaries, host-key pinning, and the JSONL App Server probe; a thin CLI maps package commands to those operations. Unit and contract tests stay Docker-free, while one opt-in live check exercises the real container.

**Tech Stack:** TypeScript 6, Node.js 24 built-ins, Node test runner, Docker Engine with the `docker compose` CLI plugin, OpenSSH, `@openai/codex` 0.142.5

---

## File structure

- Create `docker/ssh-worker/Dockerfile`: Node/OpenSSH image with an exact Codex CLI version.
- Create `docker/ssh-worker/Dockerfile.dockerignore`: deny-all build-context allowlist.
- Create `docker/ssh-worker/compose.yaml`: localhost-only service and persistent volumes.
- Create `docker/ssh-worker/entrypoint.sh`: initialize fixture-owned keys and permissions, then run `sshd`.
- Create `docker/ssh-worker/sshd_config`: key-only, unprivileged SSH policy.
- Create `scripts/ssh-worker-support.ts`: paths, process abstraction, state safety, SSH configuration, Compose lifecycle, host-key trust, and live probe.
- Create `scripts/ssh-worker.ts`: small command-line dispatcher for `up`, `login`, `check`, `down`, and `reset`.
- Create `tests/scripts/ssh-worker-support.test.ts`: Docker-free unit tests with fake subprocesses and temporary state.
- Create `tests/scripts/ssh-worker-contract.test.ts`: static Docker/Compose/packaging/security contract tests.
- Create `docs/development/ssh-worker-fixture.md`: operator guide and acceptance procedure.
- Modify `package.json`: supported fixture commands.
- Modify `tsconfig.json`: include the TypeScript development scripts in strict checking.
- Modify `README.md`: link the development guide without presenting SSH workers as a released QiYan feature.
- Modify `tests/docs.test.ts`: require the new guide and its security boundaries.

### Task 1: Lock the container and Compose security contract

**Files:**
- Create: `tests/scripts/ssh-worker-contract.test.ts`
- Create: `docker/ssh-worker/Dockerfile`
- Create: `docker/ssh-worker/Dockerfile.dockerignore`
- Create: `docker/ssh-worker/compose.yaml`
- Create: `docker/ssh-worker/entrypoint.sh`
- Create: `docker/ssh-worker/sshd_config`

- [ ] **Step 1: Write failing static contract tests**

Create tests that read the four fixture files as text and assert the exact invariants before any Docker process is required:

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const fixture = resolve("docker/ssh-worker");

test("SSH worker image pins Codex and contains no credentials", async () => {
  const dockerfile = await readFile(resolve(fixture, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:24-bookworm-slim$/mu);
  assert.match(dockerfile, /ARG CODEX_VERSION=0\.142\.5/u);
  assert.match(dockerfile, /@openai\/codex@\$\{CODEX_VERSION\}/u);
  assert.match(dockerfile, /useradd[^\n]+codex/u);
  assert.match(dockerfile, /rm -f \/etc\/ssh\/ssh_host_\*/u);
  assert.doesNotMatch(dockerfile, /passwd -d/u);
  assert.doesNotMatch(dockerfile, /auth\.json|COPY\s+\.codex|QIYAN_HOME/iu);
});

test("Compose publishes SSH only on loopback and separates persistent state", async () => {
  const compose = await readFile(resolve(fixture, "compose.yaml"), "utf8");
  assert.match(compose, /context: \.\.\/\.\./u);
  assert.match(compose, /dockerfile: docker\/ssh-worker\/Dockerfile/u);
  assert.match(compose, /127\.0\.0\.1:\$\{QIYAN_SSH_WORKER_PORT:-2222\}:22/u);
  assert.match(compose, /QIYAN_SSH_WORKER_PUBLIC_KEY:\?[^}]+/u);
  for (const volume of ["codex-profile", "projects", "ssh-host-keys"])
    assert.match(compose, new RegExp(`^  ${volume}:$`, "mu"));
  assert.doesNotMatch(compose, /~\/?\.codex|auth\.json|network_mode:\s*host/iu);
  assert.doesNotMatch(compose, /^name:/mu);
});

test("sshd accepts only the dedicated unprivileged key", async () => {
  const config = await readFile(resolve(fixture, "sshd_config"), "utf8");
  for (const directive of [
    "PermitRootLogin no", "PasswordAuthentication no", "KbdInteractiveAuthentication no",
    "PermitEmptyPasswords no", "AllowUsers codex", "PubkeyAuthentication yes",
    "AuthenticationMethods publickey", "DisableForwarding yes",
    "UsePAM no",
    "HostKey /var/lib/ssh-host-keys/ssh_host_ed25519_key",
    "AuthorizedKeysFile .ssh/authorized_keys",
  ]) assert.match(config, new RegExp(`^${directive}$`, "mu"));
});

test("Docker build context is deny-all except fixture sources", async () => {
  const ignore = await readFile(resolve(fixture, "Dockerfile.dockerignore"), "utf8");
  assert.equal(ignore, "**\\n!docker/ssh-worker/entrypoint.sh\\n!docker/ssh-worker/sshd_config\\n");
});
```

- [ ] **Step 2: Run the contract test and verify it fails because fixture files are absent**

Run: `npm test -- tests/scripts/ssh-worker-contract.test.ts`

Expected: FAIL with `ENOENT` for `docker/ssh-worker/Dockerfile`.

- [ ] **Step 3: Add the minimal Codex-version-pinned Docker image**

Implement `docker/ssh-worker/Dockerfile` with this structure:

```dockerfile
FROM node:24-bookworm-slim
ARG CODEX_VERSION=0.142.5
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client openssh-server \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && rm -f /etc/ssh/ssh_host_* \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/bash codex \
    && usermod --password NP codex \
    && install -d -m 0700 -o codex -g codex /home/codex/.ssh /home/codex/.codex /home/codex/projects \
    && install -d -m 0700 /var/lib/ssh-host-keys
COPY docker/ssh-worker/sshd_config /etc/ssh/sshd_config
COPY docker/ssh-worker/entrypoint.sh /usr/local/bin/qiyan-ssh-worker-entrypoint
RUN chmod 0755 /usr/local/bin/qiyan-ssh-worker-entrypoint
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/qiyan-ssh-worker-entrypoint"]
```

The entrypoint must use `set -eu`, `umask 077`, create `/run/sshd` as mode `0755`, validate `/run/qiyan/authorized_key.pub` with `ssh-keygen -l -f`, generate only an Ed25519 server key when missing, install the public key as mode `0600` owned by `codex`, repair only the three fixture-owned volume directories, validate the daemon configuration with `sshd -t`, and finally `exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config`.

- [ ] **Step 4: Add the Compose service and SSH daemon policy**

Implement `docker/ssh-worker/compose.yaml` with one `ssh-worker` service, repository-root build context `../..`, Dockerfile `docker/ssh-worker/Dockerfile`, build argument `${QIYAN_SSH_WORKER_CODEX_VERSION:-0.142.5}`, loopback port `${QIYAN_SSH_WORKER_PORT:-2222}`, and these mounts. Do not declare a fixed Compose project name; the helper will supply one derived from the canonical checkout root so independent clones cannot share or delete each other's volumes.

```yaml
volumes:
  - type: bind
    source: ${QIYAN_SSH_WORKER_PUBLIC_KEY:?set by the QiYan SSH worker helper}
    target: /run/qiyan/authorized_key.pub
    read_only: true
  - codex-profile:/home/codex/.codex
  - projects:/home/codex/projects
  - ssh-host-keys:/var/lib/ssh-host-keys
```

The health check uses `test: ["CMD-SHELL", "ssh-keyscan -T 2 -t ed25519 -p 22 127.0.0.1 2>/dev/null | grep -q ' ssh-ed25519 '"]`, so it proves that the daemon is listening; the long-lived process remains the foreground daemon. Add explicit top-level declarations for all three named volumes. Add the deny-all `Dockerfile.dockerignore` shown in the contract test so `.env`, `.tmp`, `data`, and the rest of the repository never enter the build context.

- [ ] **Step 5: Run the focused test and Docker syntax checks**

Run:

```bash
npm test -- tests/scripts/ssh-worker-contract.test.ts
sh -n docker/ssh-worker/entrypoint.sh
```

Expected: test and shell syntax checks PASS. Compose parsing is deferred to the live acceptance task because this host does not yet provide the `docker compose` plugin.

- [ ] **Step 6: Commit the container contract**

```bash
git add tests/scripts/ssh-worker-contract.test.ts docker/ssh-worker
git commit -m "test: define SSH worker container contract"
```

### Task 2: Build secret-safe generated SSH state

**Files:**
- Create: `scripts/ssh-worker-support.ts`
- Create: `tests/scripts/ssh-worker-support.test.ts`

- [ ] **Step 1: Write failing tests for paths, SSH arguments, and generated configuration**

Define temporary-repository tests around the exported API:

```ts
import assert from "node:assert/strict";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSshArgs, ensureFixtureState, formatSshConfig, resolveFixturePaths,
  type CommandRunner,
} from "../../scripts/ssh-worker-support.ts";

test("fixture state is private and SSH never falls back to ambient identities", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-ssh-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = resolveFixturePaths(root);
  assert.deepEqual(buildSshArgs(paths, ["true"]), ["-F", paths.sshConfig, "qiyan-ssh-worker", "true"]);
  const config = formatSshConfig(paths, 2222);
  assert.match(config, /IdentitiesOnly yes/u);
  assert.match(config, /StrictHostKeyChecking yes/u);
  assert.doesNotMatch(config, /StrictHostKeyChecking no|UserKnownHostsFile \/dev\/null/u);

  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    if (command === "ssh-keygen" && args.includes("-f")) {
      await writeFile(paths.privateKey, "test-private-key", { mode: 0o600 });
      await writeFile(paths.publicKey, "ssh-ed25519 AAAATEST qiyan-ssh-worker\n", { mode: 0o600 });
    }
    if (command === "ssh-keygen" && args.includes("-y"))
      return { code: 0, signal: null, stdout: "ssh-ed25519 AAAATEST\n", stderr: "" };
    return { code: 0, signal: null, stdout: "", stderr: "" };
  };
  await ensureFixtureState(paths, runner);
  assert.equal((await lstat(paths.stateDir)).mode & 0o777, 0o700);
  assert.deepEqual(calls[0], {
    command: "ssh-keygen",
    args: ["-q", "-t", "ed25519", "-N", "", "-C", "qiyan-ssh-worker", "-f", paths.privateKey],
  });
});
```

Also test rejection of a symlinked state directory, a non-regular private key, group/world-readable private key modes, relative roots, invalid ports, and keys created without a matching `.pub` file.

- [ ] **Step 2: Run the focused test and verify the module is missing**

Run: `npm test -- tests/scripts/ssh-worker-support.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `scripts/ssh-worker-support.ts`.

- [ ] **Step 3: Implement typed paths and an injectable process boundary**

Create these public contracts in `scripts/ssh-worker-support.ts`:

```ts
export interface FixturePaths {
  repositoryRoot: string;
  composeFile: string;
  stateDir: string;
  privateKey: string;
  publicKey: string;
  trustedHostKey: string;
  knownHosts: string;
  sshConfig: string;
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; inherit?: boolean; timeoutMs?: number },
) => Promise<CommandResult>;

export const DEFAULT_SSH_PORT = 2222;
export const DEFAULT_CODEX_VERSION = "0.142.5";
export const SSH_ALIAS = "qiyan-ssh-worker";
```

`resolveFixturePaths` accepts only an absolute canonical repository root and anchors every generated path below `<root>/.tmp/ssh-worker`. `ensureFixtureState` requires every existing fixture-owned directory/file to belong to the current user and rejects symlinks, hard-linked files, special files, and group/world-accessible state. It creates the directory as `0700`, stages a new Ed25519 pair inside a private temporary directory, validates it, and atomically installs it only when both destination paths are absent. Existing and new pairs are checked by comparing the algorithm/key blob returned from `ssh-keygen -y` with the stored `.pub`; the private key must be mode `0600` or stricter. It never reads or prints private-key bytes.

- [ ] **Step 4: Implement strict generated SSH configuration**

`formatSshConfig` must emit one alias only:

```text
Host qiyan-ssh-worker
  HostName 127.0.0.1
  Port 2222
  User codex
  IdentityFile <absolute generated private key>
  IdentitiesOnly yes
  UserKnownHostsFile <absolute generated known_hosts>
  StrictHostKeyChecking yes
  BatchMode yes
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  ForwardAgent no
  ClearAllForwardings yes
```

Write it atomically with mode `0600`; reject replacement by a symlink or non-regular file. `buildSshArgs` always uses `-F <generated config>` and never accepts arbitrary SSH options.

- [ ] **Step 5: Run focused tests and type checking**

Run:

```bash
npm test -- tests/scripts/ssh-worker-support.test.ts
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit generated-state support**

```bash
git add scripts/ssh-worker-support.ts tests/scripts/ssh-worker-support.test.ts
git commit -m "feat: prepare isolated SSH worker state"
```

### Task 3: Implement bounded Compose lifecycle and trust-on-first-local-use

**Files:**
- Modify: `scripts/ssh-worker-support.ts`
- Modify: `tests/scripts/ssh-worker-support.test.ts`

- [ ] **Step 1: Write failing lifecycle and host-key tests**

Add fake-runner tests proving:

- two canonical checkout roots derive distinct stable Compose project names;
- `upFixture` checks `docker compose version`, creates state, runs `docker compose --project-name <derived> ... up --detach --build`, polls `ssh-keyscan` with a bounded timeout, pins the first local Ed25519 host key, writes the SSH config, and proves `ssh ... true`;
- after startup, one fixed `docker compose exec --user root` check proves the effective `sshd -T` settings and that no `/etc/ssh/ssh_host_*` key remains in the container;
- an existing identical host key is retained byte-for-byte;
- an existing different host key throws `SSH host key changed` without overwriting either file;
- changing only the published port with the same trusted algorithm/key blob rewrites the address-specific `known_hosts` record and succeeds;
- missing Compose, a busy port, key-scan timeout, and SSH key rejection have separate bounded errors;
- `downFixture` invokes `docker compose ... down` without `--volumes`; and
- `resetFixture` does nothing unless passed `{ confirmed: true }`, then invokes `down --volumes --remove-orphans` and removes only the resolved fixture state directory.

Use an injected clock/sleeper so timeout tests finish immediately. Assert that thrown messages and captured output do not contain a sentinel environment secret or fake key body.

- [ ] **Step 2: Run the focused tests and verify the lifecycle exports are absent**

Run: `npm test -- tests/scripts/ssh-worker-support.test.ts`

Expected: FAIL because `upFixture`, `downFixture`, and `resetFixture` are not exported.

- [ ] **Step 3: Implement Compose environment and lifecycle operations**

Derive a stable project name as `qiyan-ssh-worker-<12 lowercase hex characters>` from SHA-256 of the canonical repository root. Add `composeArgs(paths, args)` returning `['compose', '--project-name', projectName, '--file', paths.composeFile, ...args]`. Every lifecycle operation, including reset, must use that exact derived name. Build the Docker Compose child environment from the current process plus these fixture values, while passing no `environment:` entries into the container:

```ts
{
  ...process.env,
  QIYAN_SSH_WORKER_PUBLIC_KEY: paths.publicKey,
  QIYAN_SSH_WORKER_PORT: String(port),
  QIYAN_SSH_WORKER_CODEX_VERSION: codexVersion,
}
```

Do not log the environment. Validate the port as an integer from 1 through 65535 and the version as three decimal components before dispatch. Map known Docker stderr categories to stable errors without echoing arbitrary stderr. The real runner uses `shell: false`, caps captured stdout/stderr, waits for `close`, represents spawn errors/timeouts/signals separately, and escalates `SIGTERM` to `SIGKILL` after a bounded grace period.

- [ ] **Step 4: Implement bounded host-key pinning**

Poll `ssh-keyscan -T 1 -t ed25519 -p <port> 127.0.0.1` until a valid single Ed25519 record is returned or 30 seconds elapse. Validate the candidate through `ssh-keygen -lf <temporary candidate> -E sha256`. Persist the first trusted algorithm/key blob separately in `trusted-host-key.pub`, mode `0600`, and write the address/port-specific `known_hosts` record from it. On later starts, a matching blob may rewrite `known_hosts` for a changed port; a different blob fails closed without replacing either trust record. Never disable strict checking and always remove candidate temporary files.

After writing the SSH config, prove key-only access with `ssh -F <config> qiyan-ssh-worker true` under a 10-second timeout. Preserve the container and pinned state on failure so the user can diagnose them.

Also run fixed, non-user-controlled Compose exec commands to inspect `sshd -T -C user=codex,host=localhost,addr=127.0.0.1`. Require the effective persistent host-key path, public-key-only authentication, exact authorized-keys path, disabled forwarding, and disabled root/password/keyboard-interactive access. Fail if any `/etc/ssh/ssh_host_*` file exists. These checks supplement the host-side authenticated probe and avoid trusting text-regex configuration alone.

- [ ] **Step 5: Run lifecycle tests and the complete support test file**

Run: `npm test -- tests/scripts/ssh-worker-support.test.ts`

Expected: PASS with no Docker dependency.

- [ ] **Step 6: Commit lifecycle support**

```bash
git add scripts/ssh-worker-support.ts tests/scripts/ssh-worker-support.test.ts
git commit -m "feat: manage SSH worker fixture lifecycle"
```

### Task 4: Add interactive login and the real App Server probe

**Files:**
- Modify: `scripts/ssh-worker-support.ts`
- Modify: `tests/scripts/ssh-worker-support.test.ts`
- Create: `scripts/ssh-worker.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Write failing tests for remote checks and CLI dispatch**

Add tests proving `checkFixture`:

- executes a fixed, non-user-controlled remote environment probe and requires `codex`, `/home/codex`, `/home/codex/.codex`, and `/home/codex/projects`;
- accepts only `codex-cli 0.142.5` for the default image and honors the validated override;
- starts `ssh ... codex app-server --listen stdio://` with piped standard input/output;
- passes `-T` so no pseudo-terminal can contaminate App Server JSONL;
- sends one schema-typed JSONL `initialize` request containing `clientInfo`, `experimentalApi: true`, and `requestAttestation: false`;
- validates response ID, `userAgent`, `codexHome`, `platformFamily`, and `platformOs`;
- sends the schema-typed parameterless `initialized` notification, then requests `account/read` with `{ refreshToken: false }`;
- reports `authentication required` when `requiresOpenaiAuth` is true or `account` is null;
- bounds process startup, initialize, account read, and shutdown independently, and terminates the SSH child on success, timeout, malformed JSON, oversized lines, protocol error, stream error, or unexpected exit; and
- never returns or logs account details, JSON-RPC error data/messages, stderr, message bodies, or credentials.

Test `runCli` with injected operations so each exact command dispatches once, unknown commands return usage without subprocesses, and reset accepts only an interactive line equal to `reset` or an explicit `--yes`.

- [ ] **Step 2: Run the focused tests and verify the probe/CLI are missing**

Run: `npm test -- tests/scripts/ssh-worker-support.test.ts`

Expected: FAIL for missing `checkFixture` and `runCli` exports.

- [ ] **Step 3: Implement a bounded JSONL App Server probe**

Add a narrow injectable `StreamingChild` boundary separate from the short-command runner, rather than exposing all of `ChildProcessWithoutNullStreams`. It must represent stdin writes/backpressure, bounded stdout chunks, stream/process errors, exit and close, and `SIGTERM`/`SIGKILL`. Incrementally accumulate `Buffer` data so an unterminated line cannot exceed 1 MiB, preserve multibyte UTF-8 across chunks, correlate exact response IDs while ignoring bounded interleaved notifications, handle stdin `EPIPE`, and wait for `close` during cleanup. Bound process startup, initialize, account read, and termination; inject timers so every timeout path is deterministic in unit tests.

Construct protocol values with the checked-in Codex 0.142.5 types (`InitializeParams`, `ClientNotification`, `GetAccountParams`, `InitializeResponse`, and `GetAccountResponse`) and runtime-validate parsed `unknown` values. Use this initialize request shape:

```ts
{
  id: 1,
  method: "initialize",
  params: {
    clientInfo: { name: "qiyan_ssh_worker_check", title: "QiYan SSH Worker Check", version: APP_VERSION },
    capabilities: { experimentalApi: true, requestAttestation: false },
  } satisfies InitializeParams,
}
```

After a valid initialize response, require `codexHome === "/home/codex/.codex"`, `platformFamily === "unix"`, `platformOs === "linux"`, and the selected Codex version in `userAgent`. Send `{"method":"initialized"}` satisfying `ClientNotification`, then `{"id":2,"method":"account/read","params":{"refreshToken":false}}` with typed params. Retain only booleans and expected version/path fields needed for the verdict. Give `account/read` its own deadline. Terminate the child with `SIGTERM`, then `SIGKILL` after a bounded grace period, and await `close`. Do not create or resume a thread.

- [ ] **Step 4: Implement the CLI and package commands**

`runCli` is a pure exported function in `scripts/ssh-worker-support.ts` that returns an exit code and receives injected operations, line input, stdout, and stderr. `scripts/ssh-worker.ts` resolves the repository root from `import.meta.url`, constructs the real Node subprocess adapters, and invokes `runCli` only behind an `import.meta.main` guard so tests may import support without executing a command. Add:

```json
"ssh-worker:up": "node --import tsx scripts/ssh-worker.ts up",
"ssh-worker:login": "node --import tsx scripts/ssh-worker.ts login",
"ssh-worker:check": "node --import tsx scripts/ssh-worker.ts check",
"ssh-worker:down": "node --import tsx scripts/ssh-worker.ts down",
"ssh-worker:reset": "node --import tsx scripts/ssh-worker.ts reset"
```

`login` requires existing strict SSH state and runs `ssh -tt -F <config> qiyan-ssh-worker codex login --device-auth` with inherited terminal streams. It must not capture, parse, or log the authorization URL, device code, token, or resulting credential. The App Server check uses `ssh -T`. `check` prints only stable phase names and the final authenticated/unauthenticated verdict.

Extend `tsconfig.json`'s `include` array with `scripts/**/*.ts` so both the support module and the executable remain under strict TypeScript checking.

- [ ] **Step 5: Run focused tests, type checking, and CLI usage**

Run:

```bash
npm test -- tests/scripts/ssh-worker-support.test.ts
npm run typecheck
node --import tsx scripts/ssh-worker.ts --help
```

Expected: tests and typecheck PASS; help lists exactly `up`, `login`, `check`, `down`, and `reset [--yes]`.

- [ ] **Step 6: Commit login and live checking**

```bash
git add scripts/ssh-worker-support.ts scripts/ssh-worker.ts tests/scripts/ssh-worker-support.test.ts package.json tsconfig.json
git commit -m "feat: verify Codex over the SSH worker fixture"
```

### Task 5: Document the fixture and packaging boundary

**Files:**
- Create: `docs/development/ssh-worker-fixture.md`
- Modify: `README.md`
- Modify: `tests/docs.test.ts`
- Modify: `tests/scripts/ssh-worker-contract.test.ts`

- [ ] **Step 1: Write failing documentation and package-boundary tests**

Extend `tests/docs.test.ts` to require the README's absolute GitHub link to `https://github.com/O123O/qiyan-bot/blob/main/docs/development/ssh-worker-fixture.md` and require the local guide to contain:

```ts
for (const required of [
  "Development fixture", "Docker Compose", "127.0.0.1", "ssh-worker:up",
  "ssh-worker:login", "ssh-worker:check", "ssh-worker:down", "ssh-worker:reset",
  "device authentication", ".tmp/ssh-worker", "StrictHostKeyChecking",
  "source checkout only", "does not implement QiYan remote-worker routing",
]) assert.equal(guide.includes(required), true, `SSH worker guide is missing: ${required}`);
```

Extend the contract test to inspect `package.json`'s narrow `files` allowlist and assert it excludes `.tmp`, `scripts`, and `docker`. Do not add another `npm pack` call: `tests/bin.test.ts` already builds one archive and asserts its exact contents, and a second concurrent prepack build would race on `dist/`. The fixture commands are deliberately source-checkout-only development scripts, not installed QiYan binary commands. The absolute README link remains valid in the packed README even though the local development guide and fixture source are omitted.

- [ ] **Step 2: Run the focused tests and verify they fail on missing docs**

Run: `npm test -- tests/docs.test.ts tests/scripts/ssh-worker-contract.test.ts`

Expected: FAIL because the guide and README link are absent.

- [ ] **Step 3: Write the operator guide**

Document:

1. Docker Engine, a Compose CLI plugin that provides `docker compose`, `ssh`, `ssh-keygen`, and `ssh-keyscan` prerequisites.
2. First run with `npm run ssh-worker:up`.
3. Independent remote device authentication with `npm run ssh-worker:login`.
4. Full verification with `npm run ssh-worker:check`.
5. Daily `up`/`down`, persistence behavior, configurable `QIYAN_SSH_WORKER_PORT`, and explicit reset.
6. The generated alias command `ssh -F .tmp/ssh-worker/config qiyan-ssh-worker`.
7. Host-key mismatch, port conflict, unauthenticated state, and image rebuild troubleshooting.
8. The rule that auth, keys, and project state are runtime secrets/state and must never be copied into Git or the image.
9. The future endpoint command shape and an explicit statement that this change does not implement QiYan remote-worker routing.
10. The source-checkout-only boundary: the Docker fixture and its npm development scripts are not included in release packages.

Add one concise absolute GitHub README development link without marketing SSH support as implemented or creating a broken link in the packed README.

- [ ] **Step 4: Run documentation and packaging tests**

Run: `npm test -- tests/docs.test.ts tests/scripts/ssh-worker-contract.test.ts`

Expected: PASS; the package allowlist and existing archive test exclude fixture source, generated state, and secrets without a second prepack race.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/development/ssh-worker-fixture.md tests/docs.test.ts tests/scripts/ssh-worker-contract.test.ts
git commit -m "docs: explain the reusable SSH worker fixture"
```

### Task 6: Run the real container acceptance and full verification

**Files:**
- Modify only if a verified defect is found in files introduced by Tasks 1-5.

- [ ] **Step 1: Run the full Docker-free repository check**

Run: `npm run check`

Expected: 0 type errors and all non-live tests PASS; existing intentional live-test skips remain skipped.

- [ ] **Step 2: Verify the host provides the Compose CLI**

Run: `docker compose version`

Expected: PASS. This development host currently lacks the Compose plugin even though Docker Engine is running. If it is still absent at execution time, stop and request user authorization before installing the host distribution's `docker-compose` package; do not silently mutate system packages or substitute an unreviewed Compose binary.

Then run:

```bash
QIYAN_SSH_WORKER_PUBLIC_KEY=/dev/null docker compose -f docker/ssh-worker/compose.yaml config --quiet
```

Expected: Compose configuration PASS and renders the SSH publication on loopback only.

- [ ] **Step 3: Build and start the real fixture**

Run: `npm run ssh-worker:up`

Expected: image builds with Codex 0.142.5, Compose reports the service healthy, host key is pinned once, and strict key-only SSH succeeds on `127.0.0.1:2222`.

- [ ] **Step 4: Verify the unauthenticated boundary before login**

Run: `npm run ssh-worker:check`

Expected on a fresh volume: SSH, remote environment, Codex version, and App Server initialize PASS, followed by the stable `authentication required` verdict and a nonzero exit code. No thread or model task is created.

- [ ] **Step 5: Perform independent device authentication**

Run: `npm run ssh-worker:login`

Expected: Codex's official device-auth flow appears in the interactive terminal. The user completes it; the helper does not capture or repeat the device code or token.

- [ ] **Step 6: Verify the authenticated App Server path and persistence**

Run:

```bash
npm run ssh-worker:check
npm run ssh-worker:down
npm run ssh-worker:up
npm run ssh-worker:check
```

Expected: both checks PASS; the second proves the named Codex profile, project, and server-host-key volumes survive ordinary `down`/`up`.

- [ ] **Step 7: Re-run the repository check after live acceptance**

Run: `npm run check`

Expected: all tests PASS with no generated fixture state in `git status --short`.

- [ ] **Step 8: Commit only verified acceptance fixes, if any**

If live acceptance required a source fix, first add a reproducing Docker-free test, then commit the minimal fix:

```bash
git add docker/ssh-worker scripts/ssh-worker.ts scripts/ssh-worker-support.ts tests/scripts docs/development/ssh-worker-fixture.md README.md package.json tsconfig.json
git commit -m "fix: harden SSH worker live acceptance"
```

If no fix was required, do not create an empty commit.

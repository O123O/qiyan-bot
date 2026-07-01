# Isolated Coordinator Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the dedicated coordinator app-server a private `HOME` and `CODEX_HOME` while keeping all project sessions on the unchanged user-profile worker endpoint.

**Architecture:** Add a filesystem-backed coordinator profile under `DATA_DIR`, attest the app-server's initialized Codex home, verify isolated authentication before migration, and use a durable activation marker to replace only the legacy coordinator thread identity. Production startup reconciles any old active coordinator attempt through existing operation-ledger rules before activating the new profile; workers retain the original environment and registry mappings.

**Tech Stack:** TypeScript 6, Node.js 24 filesystem/process APIs, Zod, Codex app-server JSON-RPC v2, Node test runner, esbuild, SQLite.

---

## File structure

- Create `src/coordinator/profile.ts`: private profile directory preparation, marker parsing/writing, child-environment override, authentication preflight, and login guidance.
- Create `tests/coordinator/profile.test.ts`: filesystem, environment, authentication, marker, and fail-closed tests.
- Create `src/coordinator/login.ts`: safely launch device authentication through the installed binary.
- Create `tests/coordinator/login.test.ts`: command environment, inherited stdio, exit handling, and pre-spawn filesystem rejection.
- Modify `src/cli.ts`, `src/config.ts`, and `src/main.ts`: dispatch `coordinator-login` without requiring Telegram configuration.
- Modify `tests/cli.test.ts` and `tests/config.test.ts`: command parsing and login-only configuration coverage.
- Modify `src/app-server/local-endpoint.ts`: optionally attest the `codexHome` returned by app-server initialization.
- Modify `tests/app-server/local-endpoint.test.ts`: expected/mismatched Codex-home initialization tests.
- Modify `src/coordinator/identity.ts`: first-profile activation with existing identity validation and crash-safe registry/marker ordering.
- Modify `tests/coordinator/identity.test.ts`: activation, ordering, retry, and project-mapping preservation tests.
- Create `src/coordinator/profile-migration.ts`: reconcile and terminalize legacy coordinator attempts before identity replacement.
- Create `tests/coordinator/profile-migration.test.ts`: real SQLite recovery behavior for no-effect and dispatched-effect attempts.
- Create `src/coordinator/auth-recovery.ts`: deduplicate actionable coordinator-authentication warnings by endpoint incident.
- Create `tests/coordinator/auth-recovery.test.ts`: warning idempotency and incident separation.
- Modify `src/production-app.ts`: prepare the profile, isolate only `coordinator-local`, preflight authentication, and recover legacy active attempts before activation.
- Modify `tests/production-startup.test.ts`: prove profile preparation occurs before endpoint failure.
- Modify `tests/mcp/server.test.ts`: prove worker and coordinator environment behavior remains secret-safe.
- Modify `tests/integration/mcp-coordinator.test.ts`: real app-server skill/config isolation and manager-MCP regression coverage.
- Modify `src/coordinator/workspace.ts` and `tests/coordinator/workspace.test.ts`: accurately warn about nested repository instructions, configuration, and skills.
- Modify `README.md`: setup/login/migration/skills/backup/troubleshooting documentation.

### Task 1: Private coordinator profile and isolated environment

**Files:**
- Create: `src/coordinator/profile.ts`
- Create: `tests/coordinator/profile.test.ts`
- Modify: `tests/mcp/server.test.ts`

- [ ] **Step 1: Write failing profile filesystem tests**

Add tests that call the desired API:

```ts
const prepared = await prepareCoordinatorProfile(dataRoot);
assert.equal(prepared.root, await realpath(join(dataRoot, "coordinator-profile")));
assert.equal(prepared.home, await realpath(join(dataRoot, "coordinator-profile/home")));
assert.equal(prepared.codexHome, await realpath(join(dataRoot, "coordinator-profile/codex")));
assert.equal(prepared.activationRequired, true);
assert.equal((await stat(prepared.root)).mode & 0o777, 0o700);
assert.equal((await stat(prepared.home)).mode & 0o777, 0o700);
assert.equal((await stat(prepared.codexHome)).mode & 0o777, 0o700);
```

Add separate tests replacing each managed directory and `profile.json` with a symlink or wrong filesystem type. Each must reject with `CONFIGURATION_ERROR`. Add marker tests for absent, valid version 1, malformed JSON, extra keys, unsupported version, and symbolic-link markers.

- [ ] **Step 2: Run the profile tests and verify RED**

Run:

```bash
npm test -- tests/coordinator/profile.test.ts
```

Expected: FAIL because `src/coordinator/profile.ts` and its exports do not exist.

- [ ] **Step 3: Implement private directory preparation and marker state**

Implement these public shapes:

```ts
export interface PreparedCoordinatorProfile {
  root: string;
  home: string;
  codexHome: string;
  markerPath: string;
  activationRequired: boolean;
  creationNonce: string;
  pendingThreadId: string | null;
  markActivated(): Promise<void>;
  recordPendingThread(threadId: string): Promise<void>;
  clearPendingThread(threadId: string): Promise<void>;
}

export async function prepareCoordinatorProfile(dataRoot: string): Promise<PreparedCoordinatorProfile>;
```

Use `lstat` before trusting existing objects; directories must be real directories rather than symbolic links. Create/chmod profile directories to `0700`, canonicalize them, pin their bigint device/inode identities, and require that they remain descendants of the canonical data root. Expose integrity revalidation for app-server starts and marker transitions, including the exact `0700` mode. Parse `profile.json` through a no-follow descriptor with a strict schema equivalent to `{ version: z.literal(1), creation_nonce: z.string().uuid(), pending_thread_id: z.string().min(1).nullable() }`. For an absent marker, generate `creationNonce` with `randomUUID()`. Every marker transition is a mode-`0600`, file-and-directory-`fsync` atomic replacement guarded by the expected current nonce/pending ID and revalidated parent identities. `markActivated`, `recordPendingThread`, and `clearPendingThread` update the returned in-memory state only after the durable write and reject conflicting transitions.

- [ ] **Step 4: Run the profile tests and verify GREEN**

Run:

```bash
npm test -- tests/coordinator/profile.test.ts
```

Expected: all profile filesystem/marker tests PASS.

- [ ] **Step 5: Write a failing child-environment isolation test**

Add a test for the desired helper:

```ts
const worker = buildCodexChildEnvironment(host);
const coordinator = buildCoordinatorChildEnvironment(host, {
  home: "/private/manager-home",
  codexHome: "/private/manager-codex",
}, "manager-token");
assert.equal(worker.HOME, "/home/user");
assert.equal(worker.CODEX_HOME, "/home/user/.codex");
assert.equal(worker.CODEX_BOT_MCP_TOKEN, undefined);
assert.equal(coordinator.HOME, "/private/manager-home");
assert.equal(coordinator.CODEX_HOME, "/private/manager-codex");
assert.equal(coordinator.CODEX_BOT_MCP_TOKEN, "manager-token");
assert.equal(coordinator.TELEGRAM_BOT_TOKEN, undefined);
```

- [ ] **Step 6: Run the environment test and verify RED**

Run:

```bash
npm test -- tests/mcp/server.test.ts
```

Expected: FAIL because `buildCoordinatorChildEnvironment` does not exist.

- [ ] **Step 7: Implement the coordinator environment helper**

Export from `src/coordinator/profile.ts`:

```ts
export function buildCoordinatorChildEnvironment(
  host: NodeJS.ProcessEnv,
  profile: Pick<PreparedCoordinatorProfile, "home" | "codexHome">,
  mcpToken: string,
): NodeJS.ProcessEnv {
  return {
    ...buildCodexChildEnvironment(host, mcpToken),
    HOME: profile.home,
    CODEX_HOME: profile.codexHome,
  };
}
```

Keep generic filtering in `src/mcp/server.ts`; do not change worker behavior.

- [ ] **Step 8: Run focused tests and commit**

Run:

```bash
npm test -- tests/coordinator/profile.test.ts tests/mcp/server.test.ts
git add src/coordinator/profile.ts tests/coordinator/profile.test.ts tests/mcp/server.test.ts
git commit -m "feat: prepare isolated coordinator profile"
```

Expected: focused tests PASS and commit succeeds.

### Task 2: Safe installed coordinator login command

**Files:**
- Create: `src/coordinator/login.ts`
- Create: `tests/coordinator/login.test.ts`
- Modify: `src/cli.ts`
- Modify: `tests/cli.test.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Write failing command/config tests**

Specify a discriminated CLI result:

```ts
assert.deepEqual(parseCliArgs([]), { command: "run" });
assert.deepEqual(parseCliArgs(["--workdir", "./manager"]), { command: "run", coordinatorWorkdir: "./manager" });
assert.deepEqual(parseCliArgs(["coordinator-login"]), { command: "coordinator-login" });
assert.throws(() => parseCliArgs(["coordinator-login", "--workdir", "x"]), /unknown argument/);
```

Add `loadCoordinatorLoginConfig` tests proving it resolves only `DATA_DIR` and `CODEX_BINARY` and does not require or inspect Telegram variables.

- [ ] **Step 2: Write the failing safe-login launcher tests**

Inject a fake spawn and assert `runCoordinatorLogin` first prepares the profile and then invokes exactly:

```ts
spawn(codexBinary, ["login", "--device-auth"], {
  env: expectedIsolatedEnvironment,
  stdio: "inherit",
});
```

Prove `HOME` and `CODEX_HOME` use the prepared profile, Telegram secrets are absent, no MCP token is present, and a nonzero child exit rejects. Add a pre-existing profile-directory symlink fixture and assert the launcher rejects before spawn is called.

- [ ] **Step 3: Run login tests and verify RED**

Run:

```bash
npm test -- tests/cli.test.ts tests/config.test.ts tests/coordinator/login.test.ts
```

Expected: FAIL because the command variant, login configuration, and launcher do not exist.

- [ ] **Step 4: Implement command parsing, login configuration, and launcher**

Make `parseCliArgs` return:

```ts
type CliCommand =
  | { command: "run"; coordinatorWorkdir?: string }
  | { command: "coordinator-login" };
```

`loadCoordinatorLoginConfig` resolves `DATA_DIR` with the same default and resolution rules as bot startup plus `CODEX_BINARY` with the same default. `runCoordinatorLogin` calls `prepareCoordinatorProfile`, builds a sanitized child environment with the isolated home paths but no manager token, spawns Codex with an argument array and inherited stdio, and rejects a nonzero/signal exit without exposing child output. `main` dispatches this command before loading Telegram configuration or creating the app.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm test -- tests/cli.test.ts tests/config.test.ts tests/coordinator/login.test.ts
git add src/cli.ts src/config.ts src/main.ts src/coordinator/login.ts tests/cli.test.ts tests/config.test.ts tests/coordinator/login.test.ts
git commit -m "feat: add safe coordinator login command"
```

Expected: focused tests PASS and commit succeeds.

### Task 3: App-server Codex-home attestation and authentication preflight

**Files:**
- Modify: `src/app-server/local-endpoint.ts`
- Modify: `tests/app-server/local-endpoint.test.ts`
- Modify: `src/coordinator/profile.ts`
- Modify: `tests/coordinator/profile.test.ts`

- [ ] **Step 1: Write failing app-server home-attestation tests**

Extend the fake initialization tests so a `LocalEndpoint` with `expectedCodexHome` accepts the exact canonical path and rejects a different returned `codexHome` before becoming ready:

```ts
const endpoint = new LocalEndpoint({
  id: "coordinator-local",
  codexBinary: "codex",
  spawn,
  expectedCodexHome,
});
await assert.rejects(endpoint.start(), /unexpected CODEX_HOME/);
assert.equal(endpoint.state, "unavailable");
```

- [ ] **Step 2: Run the endpoint test and verify RED**

Run:

```bash
npm test -- tests/app-server/local-endpoint.test.ts
```

Expected: FAIL because `expectedCodexHome` is not accepted or enforced.

- [ ] **Step 3: Implement initialization attestation**

Add `expectedCodexHome?: string` and an optional environment-integrity callback to `LocalEndpoint` options. Request `codexHome` in the initialization response type, resolve only the reported path, and compare it with the already-canonical pinned expected path after initialization but before publishing process identity or `ready`. Run integrity validation before spawn and again after initialization so a replaced same-path inode also fails. Missing or mismatched values under this option must throw `AppError("CONFIGURATION_ERROR", ...)`. Endpoints without the options retain current compatibility.

- [ ] **Step 4: Run the endpoint test and verify GREEN**

Run:

```bash
npm test -- tests/app-server/local-endpoint.test.ts
```

Expected: all endpoint tests PASS.

- [ ] **Step 5: Write failing authentication-preflight tests**

Add a fake endpoint with `request("account/read", { refreshToken: false })`. Prove:

```ts
await assert.rejects(
  assertCoordinatorAuthenticated(endpointWithoutAccount, profile, "/opt/codex bin"),
  (error: unknown) => error instanceof AppError
    && error.code === "CONFIGURATION_ERROR"
    && error.message.includes(profile.home)
    && error.message.includes(profile.codexHome)
    && error.message.includes("login --device-auth"),
);
await assert.doesNotReject(assertCoordinatorAuthenticated(chatgptEndpoint, profile, "codex"));
await assert.doesNotReject(assertCoordinatorAuthenticated(externalProviderEndpoint, profile, "codex"));
```

The no-account fixture returns `{ account: null, requiresOpenaiAuth: true }`; the external-provider fixture returns `{ account: null, requiresOpenaiAuth: false }`.
Also test `startAuthenticatedCoordinatorEndpoint`: authentication failure after `start()` must call `stop()` and rethrow the actionable configuration error; success leaves the endpoint ready. This helper is the single path used by initial startup and reconnect.

- [ ] **Step 6: Run authentication tests and verify RED**

Run:

```bash
npm test -- tests/coordinator/profile.test.ts
```

Expected: FAIL because `assertCoordinatorAuthenticated` does not exist.

- [ ] **Step 7: Implement authentication preflight and safe login guidance**

Implement `assertCoordinatorAuthenticated`. It must call `account/read` without token refresh, accept any returned account, accept providers that do not require OpenAI authentication, and otherwise throw an actionable configuration error directing the user to `codex-bot coordinator-login` with the resolved data directory. Implement `startAuthenticatedCoordinatorEndpoint` to start, preflight, and stop on preflight failure. Do not render or execute shell command text.

- [ ] **Step 8: Run focused tests and commit**

Run:

```bash
npm test -- tests/app-server/local-endpoint.test.ts tests/coordinator/profile.test.ts
git add src/app-server/local-endpoint.ts src/coordinator/profile.ts tests/app-server/local-endpoint.test.ts tests/coordinator/profile.test.ts
git commit -m "feat: verify coordinator profile authentication"
```

Expected: focused tests PASS and commit succeeds.

### Task 4: Crash-safe first-profile coordinator identity migration

**Files:**
- Modify: `src/coordinator/identity.ts`
- Modify: `tests/coordinator/identity.test.ts`

- [ ] **Step 1: Write failing activation tests**

Add tests for a desired `activateCoordinatorProfileIdentity` function. Use a real `SessionRegistry` containing one coordinator and two project mappings. Record callback/write order and assert:

```ts
assert.equal(await activateCoordinatorProfileIdentity({
  registry,
  endpointId: "coordinator-local",
  legacyEndpointId: "local",
  coordinatorDir: dir,
  activationRequired: true,
    beforeReset: async () => { order.push("reconcile"); },
    markActivated: async () => { order.push("marker"); },
}), true);
assert.deepEqual(order, ["reconcile", "marker"]);
assert.equal(registry.snapshot().coordinator.thread_id, "pending");
assert.equal(registry.snapshot().coordinator.endpoint, "coordinator-local");
assert.deepEqual(registry.snapshot().sessions, originalSessions);
```

Intercept the registry write or read the file after each callback to prove the durable order is `beforeReset` → registry pending → marker. Add tests that no activation work happens when `activationRequired` is false; endpoint/workdir mismatch fails before `beforeReset`; and marker failure leaves the registry pending so retry is safe.

Add pending-identity receipt tests. Prove a fresh create calls `thread/start` with `threadSource: creationNonce`, durably records the returned ID, calls `thread/name/set` with `codex-bot-coordinator:<nonce>`, commits the registry, then clears the receipt. For an existing receipt, require `thread/read` and resume to match ID, cwd, nonce, and name. Exact structured JSON-RPC `-32600` plus `thread not loaded` clears the receipt and retries creation; timeouts, transport errors, auth errors, other `-32600` messages, or any provenance mismatch preserve the receipt and fail closed. A non-pending registry resume clears only a matching stale receipt after successful verification.

- [ ] **Step 2: Run identity tests and verify RED**

Run:

```bash
npm test -- tests/coordinator/identity.test.ts
```

Expected: FAIL because the activation function does not exist.

- [ ] **Step 3: Refactor shared identity validation and implement activation**

Extract the current endpoint/workdir validation so both activation and `resumeCoordinatorIdentity` use exactly the same rules. Implement:

```ts
export async function activateCoordinatorProfileIdentity(input: {
  registry: SessionRegistry;
  endpointId: string;
  legacyEndpointId: string;
  coordinatorDir: string;
  activationRequired: boolean;
  beforeReset(): Promise<void>;
  markActivated(): Promise<void>;
}): Promise<boolean>;
```

If activation is required, validate first, await `beforeReset`, atomically set only the coordinator to `{ endpoint: endpointId, thread_id: "pending", project_dir: coordinatorDir }`, then persist the activation marker. Do not catch failures and do not mutate project mappings.

When `resumeCoordinatorIdentity` sees `thread_id: "pending"`, recover the exact pending receipt or execute the two-phase start/record/name-set/registry/clear sequence. Add structured `JsonRpcResponseError` code/message preservation in `json-rpc-client.ts`; only exact thread-not-loaded clears a receipt. Add `creationNonce`, `pendingThreadId`, `recordPendingThread`, and `clearPendingThread` to identity input.

- [ ] **Step 4: Run identity tests and verify GREEN**

Run:

```bash
npm test -- tests/coordinator/identity.test.ts
```

Expected: all identity tests PASS.

- [ ] **Step 5: Commit identity migration**

```bash
git add src/coordinator/identity.ts tests/coordinator/identity.test.ts
git commit -m "feat: migrate coordinator identity to isolated profile"
```

### Task 5: Wire isolation and recovery into production startup

**Files:**
- Create: `src/coordinator/profile-migration.ts`
- Create: `tests/coordinator/profile-migration.test.ts`
- Create: `src/coordinator/auth-recovery.ts`
- Create: `tests/coordinator/auth-recovery.test.ts`
- Modify: `src/production-app.ts`
- Modify: `tests/production-startup.test.ts`

- [ ] **Step 1: Write failing startup preparation test**

Extend `tests/production-startup.test.ts` so the current missing-Codex startup still creates private coordinator profile directories before endpoint launch failure:

```ts
assert.equal((await stat(join(dataDir, "coordinator-profile"))).mode & 0o777, 0o700);
assert.equal((await stat(join(dataDir, "coordinator-profile/home"))).mode & 0o777, 0o700);
assert.equal((await stat(join(dataDir, "coordinator-profile/codex"))).mode & 0o777, 0o700);
```

- [ ] **Step 2: Run startup test and verify RED**

Run:

```bash
npm test -- tests/production-startup.test.ts
```

Expected: FAIL because the profile directories are not created.

- [ ] **Step 3: Write the failing legacy-attempt recovery tests**

Create real SQLite fixtures with `CoordinatorRuntime`, `OperationStore`, `DeliveryStore`, and `FinalMessageStore`. Cover three attempts:

1. SQLite still says active, but the old coordinator rollout contains the completed turn and final answer.
2. The old rollout has no matching turn and the attempt has no dispatched effect.
3. The old rollout has no matching turn and the attempt has a dispatched `send_to_session` effect.

Call the desired helper and assert:

```ts
await recoverCoordinatorProfileAttempts({
  runtime,
  legacyThreadId: "old-coordinator",
  readLegacyThread,
  reconcileOperations: async () => { reconciliations += 1; },
  completeTurn,
});
assert.equal(reconciliations, 1);
assert.deepEqual(runtime.activeAttempts(), []);
assert.equal(sourceState(completedContext), "completed");
assert.deepEqual(deliveries.listReady().map((row) => row.body), ["[coordinator] already finished"]);
assert.equal(sourceState(noEffectContext), "pending");
assert.equal(sourceState(effectContext), "superseded");
assert.equal(recoveryContextsFor(effectContext).length, 1);
```

The completed fixture begins with a provisional `pending:<attempt>` turn ID and is matched through its persisted user message `clientId`, proving the helper binds the real turn before terminalization. Add a test that failure to read a non-pending legacy thread while active attempts exist aborts migration without failing/requeueing any attempt; this avoids duplicate replay when terminal state cannot be established.

- [ ] **Step 4: Run recovery tests and verify RED**

Run:

```bash
npm test -- tests/coordinator/profile-migration.test.ts
```

Expected: FAIL because `recoverCoordinatorProfileAttempts` does not exist.

- [ ] **Step 5: Implement the focused recovery helper**

Implement this callback-oriented helper:

```ts
export async function recoverCoordinatorProfileAttempts(input: {
  runtime: CoordinatorRuntime;
  legacyThreadId: string;
  coordinatorDir: string;
  readLegacyThread(): Promise<{ id: string; cwd: string; turns: LegacyTurn[] }>;
  reconcileOperations(): Promise<void>;
  completeTurn(turn: LegacyTurn): Promise<void>;
}): Promise<void>;
```

Reconcile operations first. If no active attempts exist, return without reading legacy history. Otherwise require a successful legacy read when the old ID is not `pending`, require `thread.id === legacyThreadId`, and require `realpath(thread.cwd) === realpath(coordinatorDir)` before matching any attempt. Any read, identity, or cwd failure aborts migration without completing, failing, or requeueing attempts. Match provisional attempts to turns by the source context's persisted user-message `clientId`, bind the real turn ID, and pass completed turns to `completeTurn`. Failed/interrupted terminal turns and genuinely unresolved attempts go through `runtime.failAttempt` after operation reconciliation. Do not enqueue directly: the scheduler is still disabled, and its normal startup scan will select pending original or recovery sources after coordinator activation.

- [ ] **Step 6: Run recovery tests and verify GREEN**

Run:

```bash
npm test -- tests/coordinator/profile-migration.test.ts
```

Expected: all recovery tests PASS.

- [ ] **Step 7: Prepare and apply the isolated profile**

In the `coordinator-workspace` phase, call `prepareCoordinatorProfile(prepared.dataRoot)` after canonical workspace preparation. Store the result for later phases. Construct endpoints as:

```ts
endpoint = new LocalEndpoint({
  id: "local",
  codexBinary: config.codexBinary,
  env: buildCodexChildEnvironment(process.env),
  expectedVersion: SUPPORTED_CODEX_VERSION,
});
coordinatorEndpoint = new LocalEndpoint({
  id: "coordinator-local",
  codexBinary: config.codexBinary,
  env: buildCoordinatorChildEnvironment(process.env, coordinatorProfile, token),
  expectedCodexHome: coordinatorProfile.codexHome,
  validateEnvironment: () => coordinatorProfile.assertIntact(),
  expectedVersion: SUPPORTED_CODEX_VERSION,
});
```

Do not change the worker endpoint configuration.

- [ ] **Step 8: Add authentication and first-activation recovery in production**

Use `startAuthenticatedCoordinatorEndpoint` for the initial coordinator start and for every reconnect; never call `coordinatorEndpoint.start()` directly. In the coordinator phase, before starting/resuming identity, call `activateCoordinatorProfileIdentity`. Its `beforeReset` callback must call:

```ts
await recoverCoordinatorProfileAttempts({
  runtime: coordinator,
  legacyThreadId: registry.snapshot().coordinator.thread_id,
  coordinatorDir,
  readLegacyThread: async () => (await endpoint.request("thread/read", {
    threadId: registry.snapshot().coordinator.thread_id,
    includeTurns: true,
  })).thread,
  reconcileOperations: () => reconcileOperations({ includeActiveAttempt: true }),
  completeTurn: completeLegacyCoordinatorTurn,
});
```

`completeLegacyCoordinatorTurn` persists terminal agent messages under the semantic `coordinator-local` identity, then calls `CoordinatorRuntime.handleTerminal` so an already-produced user answer is queued exactly once. Then start/resume the coordinator with the existing manager MCP config. Leave scheduler and polling disabled until this completes. The existing post-start operation and attempt reconciliation remains in place for ordinary restarts.

The activation call supplies `markActivated: () => coordinatorProfile.markActivated()`. Every call to `resumeCoordinatorIdentity` supplies the nonce, pending ID, and guarded receipt callbacks, including reconnect. Thus only the exact two-phase bot creation can become the manager.

On reconnect, authentication failure must leave the coordinator endpoint stopped/unavailable, keep scheduling disabled, and call `recordCoordinatorAuthenticationFailure(deliveries, destination, endpointIncident, error)`. Implement that function in `src/coordinator/auth-recovery.ts`; it prepares `id: coordinator-auth-required:<incident>` as a mandatory `system_warning` containing only the actionable `coordinator-login` instruction and structural error text. `DeliveryStore.prepare` provides same-incident idempotency. Bounded reconnect continues without accepting coordinator turns.

Write `tests/coordinator/auth-recovery.test.ts` first, verify it fails without the helper, implement the helper, and prove two calls in one incident produce one outbox row while a later incident produces a second row. Include this test in the focused run below.

- [ ] **Step 9: Run focused tests and verify GREEN**

Run:

```bash
npm test -- tests/production-startup.test.ts tests/coordinator/identity.test.ts tests/coordinator/profile-migration.test.ts tests/coordinator/auth-recovery.test.ts tests/mcp/server.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 10: Commit production wiring**

```bash
git add src/coordinator/profile-migration.ts src/coordinator/auth-recovery.ts src/production-app.ts tests/coordinator/profile-migration.test.ts tests/coordinator/auth-recovery.test.ts tests/production-startup.test.ts
git commit -m "feat: isolate coordinator app-server profile"
```

### Task 6: Real skill isolation and operator documentation

**Files:**
- Modify: `tests/integration/mcp-coordinator.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the real app-server isolation test**

Add an opt-in test that creates:

```text
normal-home/.agents/skills/normal-user-only/SKILL.md
coordinator-home/.agents/skills/coordinator-only/SKILL.md
coordinator-workdir/.agents/skills/coordinator-workdir/SKILL.md
coordinator-codex-home/
```

Start a `LocalEndpoint` with `HOME=coordinator-home`, `CODEX_HOME=coordinator-codex-home`, and `expectedCodexHome=coordinator-codex-home`. Call `skills/list` with `cwds: [coordinatorWorkdir]` and `forceReload: true`. Assert that `coordinator-only` and `coordinator-workdir` are present and `normal-user-only` is absent. This test does not make a model request and must not read or copy real credentials.

On the same isolated app-server, call `thread/start` with a random `threadSource` nonce, verify the zero-turn thread does not survive a restart, then repeat with `thread/name/set` using the nonce-tagged coordinator name. Restart and assert `thread/read` preserves the exact ID, cwd, name, and `threadSource`. This protocol check proves the two-phase materialization boundary without a model turn.

Add a second workdir nested beneath a temporary `.git` root containing `.agents/skills/repository-parent/SKILL.md`. Assert Codex discovers `repository-parent`, while still excluding `normal-user-only`. This defines the promised boundary precisely: real-home skills are isolated, but repository skills intentionally follow Codex project discovery.

- [ ] **Step 2: Run the protocol isolation test**

Run:

```bash
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/mcp-coordinator.test.ts
```

Expected: the real app-server reports the isolated Codex home, discovers both coordinator-only skill roots, excludes the normal-user fixture skill, and preserves the existing real manager-MCP model test. This is a protocol/integration confirmation of the already test-driven environment and endpoint code, so it need not manufacture a new production failure.

- [ ] **Step 3: Re-run the complete real coordinator integration file**

Re-run without changing production behavior merely to satisfy the fixture:

```bash
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/mcp-coordinator.test.ts
```

Expected: both real app-server tests PASS; the worker still cannot enumerate or call manager MCP tools.

- [ ] **Step 4: Update README**

Document the profile layout and one-time login command:

```bash
DATA_DIR="$HOME/.codex-bot/data" codex-bot coordinator-login
```

State that the coordinator excludes real-home user configuration/skills, while workers continue using the real home and `~/.codex`. Document `<COORDINATOR_WORKDIR>/.agents/skills` and `<DATA_DIR>/coordinator-profile/home/.agents/skills`, and explain that a coordinator workdir nested in Git still inherits that repository's guidance, project config, and repo skills. Update the existing workspace warning and its unit test accordingly. Document two-phase coordinator creation recovery, preserved worker/backend state, reconnect authentication warnings, and backup sensitivity of isolated auth/session data. Update troubleshooting for the authentication error.

- [ ] **Step 5: Run docs/package checks and commit**

Run:

```bash
npm test -- tests/coordinator/workspace.test.ts
npm run build
npm pack --dry-run
git diff --check
git add README.md src/coordinator/workspace.ts tests/coordinator/workspace.test.ts tests/integration/mcp-coordinator.test.ts
git commit -m "docs: explain coordinator profile isolation"
```

Expected: build succeeds, package still contains only intended distributable files, diff check is clean, and commit succeeds.

### Task 7: Review, full verification, merge, install, and live migration

**Files:**
- Review all files changed since the implementation base.

- [ ] **Step 1: Run the complete automated suite**

```bash
npm run check
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/app-server.test.ts
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/mcp-coordinator.test.ts
npm test -- tests/integration/recovery.test.ts
npm run build
npm pack --dry-run
git diff --check
git status --short
```

Expected: zero failures, intended opt-in skips only, clean diff checks, and only committed branch changes.

- [ ] **Step 2: Request two independent agent reviews**

Give both reviewers the design, this plan, base SHA, and head SHA. One reviewer focuses on requirements, migration, and user experience. The other focuses on security, filesystem races, authentication, recovery/idempotency, and real app-server boundaries. Fix every Critical and Important finding, add a failing regression test before each behavioral fix, rerun focused tests, and repeat review until both return no Critical or Important issues.

- [ ] **Step 3: Re-run fresh verification after review fixes**

Repeat every command from Step 1 and record exact pass/fail counts. Inspect the final diff against the implementation base and verify every design requirement maps to code or documentation.

- [ ] **Step 4: Merge locally only after verification**

Merge the reviewed implementation branch into local `main` without pushing. Re-run `npm run check`, the real manager-MCP integration, `npm run build`, and `npm pack --dry-run` on the merge result.

- [ ] **Step 5: Back up and stop the live bot**

Identify the installed bot process without printing environment values. Stop it gracefully, confirm both old app-server process trees exit, and make a mode-`0700` stopped-state backup of SQLite, registry, coordinator workdir, and any existing profile data.

- [ ] **Step 6: Install the verified package**

```bash
archive=$(npm pack --silent)
npm install --global --prefix "$HOME/.local" "./$archive"
rm -- "$archive"
```

Verify the installed binary contains the coordinator-profile logic and remains independent of the source tree/runtime dependency tree.

- [ ] **Step 7: Authenticate the isolated profile**

Use the installed profile initializer with the live deployment's resolved `DATA_DIR` without printing credentials:

```bash
DATA_DIR="$DATA_DIR" CODEX_BINARY="$CODEX_BINARY" codex-bot coordinator-login
```

Complete the device flow, then verify through `account/read` on a temporary isolated app-server or a secret-free login-status helper. Do not create directories manually and do not inspect or print `auth.json` contents.

- [ ] **Step 8: Restart and verify the live topology**

Start the installed bot with the existing secret environment. Verify:

- exactly one worker and one coordinator app-server process tree;
- coordinator process environment contains the isolated `HOME` and `CODEX_HOME` paths, while worker process environment retains the real values, without printing unrelated environment or token values;
- registry coordinator ID changed once and project mappings are unchanged;
- `profile.json` is version 1 and private;
- dashboard parses as version 2;
- one real Telegram coordinator request receives a response and manager tools remain available;
- a normal project session still sees its expected user/project configuration and cannot enumerate `codex_bot_manager`.

If any live check fails, stop the new process and restore the stopped-state backup rather than editing identity or auth files manually.

- [ ] **Step 9: Report outcome**

Report the merged commit, automated test counts, real integration results, review rounds, backup path, installed binary path, new coordinator profile paths, live process topology, and whether a push remains pending. Never print Telegram, MCP, OAuth, API, or access tokens.

# QiYan Home, Identity, and Managed Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship QiYan v0.3.0 with prefix-free assistant replies, a configurable private application home and `.env`, safe user-work placement, and a smaller race-safe managed-session lifecycle.

**Architecture:** A bootstrap configuration loader resolves and validates `QIYAN_HOME`, reads a no-follow private dotenv file without mutating `process.env`, and feeds the existing strict config schema. Worker identity moves to registry v3 with immutable `mapping_id` and lifecycle state; a shared per-thread gate serializes adoption, removal, and execution while native cwd and project-path checks run immediately before mutations. Public session lifecycle tools become create, adopt, unadopt, archive, and rename.

**Tech Stack:** TypeScript 6, Node.js 24+ (`node:util.parseEnv`, `node:fs/promises`, `node:test`), Zod 4, SQLite, Codex app-server JSON-RPC, MCP, Telegram Bot API, esbuild, systemd user services, GitHub Actions/Releases.

---

## File map

- Create `src/config-source.ts`: bootstrap `QIYAN_HOME`, private dotenv descriptor validation, supported-key filtering, merge precedence, and central secret-key metadata.
- Create `src/sessions/thread-gate.ts`: keyed in-process serialization shared by lifecycle and execution services.
- Create `tests/config-source.test.ts`: private-home/dotenv security and precedence tests.
- Create `tests/sessions/thread-gate.test.ts`: same-thread serialization and cross-thread independence tests.
- Modify `src/cli.ts`, `src/config.ts`, `src/main.ts`: `--home`, home-derived defaults, dotenv loading, and command wiring.
- Modify `src/production-app.ts`: process cwd phase, QiYan-home workspace policy, registry v3, shared gate, lifecycle actions/recovery, and current tool wiring.
- Modify `src/assistant/workspace.ts`, `src/sessions/project-workspace.ts`: context v2, `~/qiyan-projects`, QiYan-home disjointness, and protected-root enforcement.
- Modify `src/registry/session-registry.ts`: v3 mapping generations, lifecycle reservations/transitions, compare-promote/delete, and managed snapshots.
- Modify `src/storage/database.ts`, `src/storage/migrations.ts`: fresh database state v2 and generation-keyed runtime/epoch storage.
- Modify `src/core/types.ts`, `src/storage/runtime-store.ts`, `src/assistant/dashboard-schema.ts`: adopting/unadopting/archiving states and projection rules.
- Modify `src/sessions/lifecycle.ts`, `src/sessions/service.ts`: native-cwd adoption, unadopt/archive removal, startup reconciliation, and dispatch-time checks.
- Modify `src/assistant/tools.ts`, `src/mcp/server.ts`, `assets/assistant/AGENTS.md`: reduced tool surface, credential stripping, QiYan identity, and placement policy.
- Modify tests under `tests/assistant`, `tests/sessions`, `tests/registry`, `tests/mcp`, and production/integration suites for the new contracts.
- Modify `.env.example`, `README.md`, `docs/setup.md`, `docs/chat-apps/telegram.md`: private dotenv as the normal setup path and the new defaults/lifecycle.
- Modify `package.json`, `package-lock.json`, `src/version.ts`, release/version tests: v0.3.0.

### Task 1: Bootstrap QiYan home and private dotenv configuration

**Files:**
- Create: `src/config-source.ts`
- Create: `tests/config-source.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/config.ts`
- Modify: `src/main.ts`
- Modify: `src/mcp/server.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/mcp/server.test.ts`
- Modify: `tests/assistant/login.test.ts`
- Modify: `tests/bin.test.ts`

- [ ] **Step 1: Write failing bootstrap and dotenv tests**

Add tests that express the public API before implementation:

```ts
const loaded = await loadConfigSource({
  HOME: home,
  TELEGRAM_OWNER_ID: "env-owner",
  OPENAI_API_KEY: "host-provider-key",
}, { cliHome: qiyanHome });
assert.equal(loaded.qiyanHome, await realpath(qiyanHome));
assert.equal(loaded.values.TELEGRAM_BOT_TOKEN, "file-token");
assert.equal(loaded.values.TELEGRAM_OWNER_ID, "env-owner");
assert.equal(process.env.TELEGRAM_BOT_TOKEN, processTokenBeforeLoad);
assert.equal(loaded.hostEnv.OPENAI_API_KEY, "host-provider-key");
assert.equal(loaded.hostEnv.TELEGRAM_BOT_TOKEN, undefined);
```

Cover CLI `--home` over `QIYAN_HOME` over `$HOME/.qiyan-bot`; `.env` over defaults but below host environment; absent dotenv; comments/quotes; `QIYAN_HOME` or any unsupported key inside dotenv; arbitrary relative homes; a QiYan home equal to or containing the real user home; either-direction overlap with the project root; missing and symlinked home paths; symlinked, special, oversized, malformed, wrong-owner (through an injected stat fixture), and group/world-accessible dotenv files. Assert errors never contain secret values.

Update CLI expectations:

```ts
assert.deepEqual(parseCliArgs(["--home", "/srv/qiyan", "--workdir", "/srv/qiyan/work"]), {
  command: "run", qiyanHome: "/srv/qiyan", assistantWorkdir: "/srv/qiyan/work",
});
assert.deepEqual(parseCliArgs(["assistant-login", "--home", "/srv/qiyan"]), {
  command: "assistant-login", qiyanHome: "/srv/qiyan",
});
assert.deepEqual(parseCliArgs(["config-check", "--home", "/srv/qiyan"]), {
  command: "config-check", qiyanHome: "/srv/qiyan",
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npm test -- tests/config-source.test.ts tests/cli.test.ts tests/config.test.ts tests/mcp/server.test.ts \
  tests/assistant/login.test.ts tests/bin.test.ts
```

Expected: FAIL because `loadConfigSource`, `qiyanHome`, and `--home` do not exist and current defaults still use `assistant`.

- [ ] **Step 3: Implement the secure configuration source**

Create a focused loader with this contract:

```ts
export const BOT_SECRET_ENV_NAMES = new Set([
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_OWNER_ID",
  "TELEGRAM_DESTINATION_CHAT_ID",
  "QIYAN_BOT_MCP_TOKEN",
]);

export interface LoadedConfigSource {
  qiyanHome: string;
  dotenvPath: string;
  hostEnv: Record<string, string | undefined>;
  values: Record<string, string | undefined>;
}

export async function loadConfigSource(
  host: Record<string, string | undefined>,
  options: { cliHome?: string; maxDotenvBytes?: number; expectedUid?: number } = {},
): Promise<LoadedConfigSource>;
```

Resolve only absolute or leading-`~/` homes, project missing paths through the nearest real ancestor, reject symlinks/ownership/mode violations and a home equal to/containing real `HOME` or overlapping `~/qiyan-projects`, create a missing home as `0700`, open `.env` with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, validate the opened regular-file descriptor against `expectedUid ?? process.geteuid()`, cap it at 64 KiB, read and parse with `parseEnv`, and reject `QIYAN_HOME` plus every key outside an explicit `SUPPORTED_DOTENV_KEYS` set. Return an untouched clone as `hostEnv`; merge only allowed dotenv keys below host values into `values`. Never assign dotenv values to `process.env`.

Extend final config:

```ts
export interface BotConfig {
  qiyanHome: string;
  // existing fields...
}

const defaultRoot = overrides.qiyanHome;
assistantWorkdir: resolve(parsed.ASSISTANT_WORKDIR ?? join(defaultRoot, "qiyan-workdir"));
```

Make login use the same resolved source/default data directory but pass only `loaded.hostEnv` to `runAssistantLogin` and child-environment builders. Update MCP child filtering to import the central secret set while retaining exact-key removal only. Test that dotenv-only Telegram/provider-looking keys cannot enter worker, assistant, or login-spawn environments.

Wire `main` so `--version` and `--update` remain config-independent, and run/login load the source before Zod config parsing. Add packaged `config-check [--home PATH]`: it loads the private dotenv, validates the complete `BotConfig` and pure path-disjointness rules, performs no Telegram/app-server/network calls, prints only `Configuration OK.`, and never prints resolved values.

- [ ] **Step 4: Verify GREEN and type safety**

Run:

```bash
npm test -- tests/config-source.test.ts tests/cli.test.ts tests/config.test.ts tests/mcp/server.test.ts \
  tests/assistant/login.test.ts tests/bin.test.ts
npm run typecheck
```

Expected: all focused tests pass; TypeScript reports no errors.

- [ ] **Step 5: Commit the configuration slice**

```bash
git add src/config-source.ts src/cli.ts src/config.ts src/main.ts src/mcp/server.ts \
  tests/config-source.test.ts tests/cli.test.ts tests/config.test.ts tests/mcp/server.test.ts \
  tests/assistant/login.test.ts tests/bin.test.ts
git commit -m "feat: load private QiYan home configuration"
```

### Task 2: Establish the workdir, context, fallback, and protected home

**Files:**
- Modify: `src/assistant/workspace.ts`
- Modify: `src/sessions/project-workspace.ts`
- Modify: `src/production-app.ts`
- Modify: `tests/assistant/workspace.test.ts`
- Modify: `tests/sessions/project-workspace.test.ts`
- Modify: `tests/production-startup.test.ts`
- Modify: `tests/bin.test.ts`

- [ ] **Step 1: Write failing workspace and guard tests**

Require context v2 and the new project root:

```ts
assert.deepEqual(JSON.parse(await readFile(prepared.contextPath, "utf8")), {
  version: 2,
  user_home: canonicalUserHome,
  qiyan_home: canonicalQiYanHome,
  default_projects_root: join(canonicalUserHome, "qiyan-projects"),
});
```

Add project-policy cases for `QIYAN_HOME`, every descendant (including an unrelated sibling and `qiyan-workdir`), an ancestor containing the home, projected missing descendants, traversal, and symlink aliases. Preserve external project acceptance and configured assistant/data/registry protection. Change fallback expectation to `~/qiyan-projects/<nickname>`.

Inject a `chdir` spy into production startup and assert it receives the canonical prepared assistant root before storage/endpoints start.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -- tests/assistant/workspace.test.ts tests/sessions/project-workspace.test.ts tests/production-startup.test.ts tests/bin.test.ts
```

Expected: FAIL on context version/content, old fallback, missing QiYan-home guard, and missing working-directory phase.

- [ ] **Step 3: Implement context v2 and the protected root**

Extend workspace options and policy construction:

```ts
interface AssistantWorkspaceOptions {
  qiyanHome: string;
  // existing fields...
}

new ProjectWorkspacePolicy({
  userHome: prepared.userHome,
  qiyanHome: prepared.qiyanHome,
  assistantWorkdir: prepared.root,
  dataDir: prepared.dataRoot,
  registryPath: prepared.registryPath,
  defaultProjectsRoot: prepared.defaultProjectsRoot,
});
```

Generate context v2 with `qiyan_home`; default to `join(userHome, "qiyan-projects")`. Include canonical/projected QiYan home in `assertSafe` so the existing lexical/projected/final/device-inode pipeline rejects both containment directions.

Add a production phase immediately after assistant workspace preparation:

```ts
{
  name: "assistant-working-directory",
  start: async () => options.chdir(assistantDir),
  stop: async () => undefined,
}
```

Resolve all configured paths before this phase; default `options.chdir` to `process.chdir` and inject a no-op/spy in tests.

- [ ] **Step 4: Verify GREEN**

```bash
npm test -- tests/assistant/workspace.test.ts tests/sessions/project-workspace.test.ts tests/production-startup.test.ts tests/bin.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit workspace safety**

```bash
git add src/assistant/workspace.ts src/sessions/project-workspace.ts src/production-app.ts \
  tests/assistant/workspace.test.ts tests/sessions/project-workspace.test.ts tests/production-startup.test.ts tests/bin.test.ts
git commit -m "feat: protect the QiYan home workspace"
```

### Task 3: Establish fresh database/registry generation foundations

**Files:**
- Modify: `src/storage/database.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/runtime-store.ts`
- Modify: `src/registry/session-registry.ts`
- Modify: `src/core/types.ts`
- Modify: `src/assistant/session-dashboard.ts`
- Modify: `src/assistant/session-observer.ts`
- Modify: `src/events/relay.ts`
- Modify: `src/sessions/lifecycle.ts`
- Modify: `src/sessions/service.ts`
- Modify: `src/production-app.ts`
- Modify: `tests/storage/database.test.ts`
- Modify: `tests/storage/runtime-store.test.ts`
- Modify: `tests/registry/session-registry.test.ts`
- Modify: `tests/assistant/session-dashboard.test.ts`
- Modify: `tests/assistant/session-dashboard-notifications.test.ts`
- Modify: `tests/assistant/identity.test.ts`
- Modify: `tests/events/relay.test.ts`
- Modify: `tests/sessions/lifecycle.test.ts`
- Modify: `tests/sessions/service.test.ts`
- Modify: `tests/fresh-cutover.test.ts`

- [ ] **Step 1: Write failing database and registry generation tests**

Require `qiyan_state.state_version = 2` for newly created databases and prove a state-version-1 database is rejected read-only before WAL/SHM or mutation. Add non-null `mapping_id` to `session_runtime` and `managed_epochs` and include it in their identity/primary-key lookups; every current-state, settings, active-turn, observation, and epoch API must require a mapping generation so a re-adopted thread cannot inherit stale execution state.

Define the v3 entry shape in tests:

```ts
{
  endpoint: "local",
  thread_id: "t1",
  project_dir: dir,
  mapping_id: "mapping-1",
  lifecycle_state: "adopting",
}
```

Test compare-and-reserve uniqueness by nickname and endpoint/thread, compare-and-promote by `mapping_id`, transition from managed to unadopting/archiving, compare-and-delete that cannot delete a reused nickname, and rename preserving the generation. Reject registry v2 without migration.

Add startup/open tests where a v3 transitional mapping's project directory is missing, replaced, or now a symlink. Registry parsing must preserve the exact recorded absolute path and lifecycle checkpoint rather than calling `realpath`; live filesystem safety belongs to lifecycle/dispatch.

Keep current public lifecycle behavior temporarily for a green checkpoint, but make existing create/adopt generate a managed `mapping_id` and pass it through runtime/epoch/event/dashboard consumers. Test that `create_session` stores and returns the exact generated mapping, concurrent create/adopt cannot claim one native thread twice, and stale runtime from `mapping-old` is invisible to `mapping-new`. Task 5 extends uncertain create recovery to require that same generation.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -- tests/storage/database.test.ts tests/storage/runtime-store.test.ts \
  tests/registry/session-registry.test.ts tests/assistant/session-dashboard.test.ts \
  tests/assistant/session-dashboard-notifications.test.ts tests/assistant/identity.test.ts \
  tests/events/relay.test.ts tests/sessions/lifecycle.test.ts \
  tests/sessions/service.test.ts tests/fresh-cutover.test.ts
```

Expected: FAIL because database marker 1, registry v2, and runtime/epochs have no generation identity.

- [ ] **Step 3: Implement fresh state v2 and registry v3 primitives without breaking consumers**

Use strict types:

```ts
export type MappingLifecycleState = "adopting" | "managed" | "unadopting" | "archiving";
export interface RegistrySession {
  endpoint: string;
  thread_id: string;
  project_dir: string;
  mapping_id: string;
  lifecycle_state: MappingLifecycleState;
  description?: string;
}
```

Keep the assistant identity as a separate endpoint/thread/project record without worker mapping state. Implement `reserve`, `promote`, `transition`, `removeIfMatch`, `rename`, `getByIdentity`, and `managedSnapshot` for worker mappings under the existing registry write lock. Every compare operation checks nickname, endpoint, thread, and mapping generation. Keep raw `snapshot` for recovery/validation, but expose only `managedSnapshot` to the assistant/dashboard. Add adopting/unadopting/archiving alongside the temporarily retained old runtime states; transitional entries never appear in `session-status.json`.

Do not canonicalize worker paths during registry normalize/open/write. Require each stored path to be absolute and already normalized (`path === resolve(path)`), then preserve the field exactly; only the lifecycle reservation API may introduce a new path after live workspace validation has produced its canonical form.

Change fresh migration SQL to state version 2 and generation-key runtime/epoch rows. Update every runtime consumer (`production-app`, lifecycle, service, dashboard, observer, relay) to obtain the current mapping from registry and pass its exact `mapping_id`. Keep old detach/attach/archive tools and their old runtime states only until Task 4 so this task reaches a genuine green/typecheck checkpoint; add new states to the union without removing old ones yet. Replace `registry.register` calls with a temporary coherent `createManaged` v3 API used by both new-thread creation and current adoption.

Mechanically update every registry fixture located by `rg -l 'assistant:\s*\{' tests` and inspect each match, updating registry documents to v3 without changing dashboard document version 2 fixtures.

- [ ] **Step 4: Verify GREEN**

```bash
npm test -- tests/storage/database.test.ts tests/storage/runtime-store.test.ts \
  tests/registry/session-registry.test.ts tests/assistant/session-dashboard.test.ts \
  tests/assistant/session-dashboard-notifications.test.ts tests/assistant/identity.test.ts \
  tests/events/relay.test.ts tests/sessions/lifecycle.test.ts \
  tests/sessions/service.test.ts tests/fresh-cutover.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit generation foundations**

```bash
git add src/storage/database.ts src/storage/migrations.ts src/storage/runtime-store.ts \
  src/registry/session-registry.ts src/core/types.ts src/assistant/session-dashboard.ts \
  src/assistant/session-observer.ts src/events/relay.ts src/sessions/lifecycle.ts \
  src/sessions/service.ts src/production-app.ts tests
git commit -m "feat: add generation-safe QiYan state"
```

### Task 4: Serialize adoption, execution, unadoption, and archive

**Files:**
- Create: `src/sessions/thread-gate.ts`
- Create: `tests/sessions/thread-gate.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/sessions/lifecycle.ts`
- Modify: `src/production-app.ts`
- Modify: `src/assistant/tools.ts`
- Modify: `src/assistant/dashboard-schema.ts`
- Modify: `src/assistant/session-dashboard.ts`
- Modify: `src/assistant/session-observer.ts`
- Modify: `src/sessions/service.ts`
- Modify: `src/events/relay.ts`
- Modify: `assets/assistant/AGENTS.md`
- Modify: `tests/sessions/lifecycle.test.ts`
- Modify: `tests/assistant/tools.test.ts`
- Modify: `tests/assistant/dashboard-schema.test.ts`
- Modify: `tests/assistant/session-dashboard.test.ts`
- Modify: `tests/assistant/policy.test.ts`
- Modify: `tests/assistant/session-dashboard-notifications.test.ts`
- Modify: `tests/sessions/service.test.ts`
- Modify: `tests/events/relay.test.ts`
- Modify: `tests/mcp/server.test.ts`

- [ ] **Step 1: Write failing gate and lifecycle tests**

Test that same-thread operations serialize while different threads proceed independently:

```ts
const first = gate.run("local", "t1", async () => { await barrier; order.push("first"); });
const second = gate.run("local", "t1", async () => { order.push("second"); });
release();
await Promise.all([first, second]);
assert.deepEqual(order, ["first", "second"]);
```

Replace old register/detach/attach tests with:

- adopt requires idle before reservation, reads native cwd, reserves before `thread/resume`, supplies no cwd override, re-reads and again requires idle plus safe unchanged cwd, promotes the exact mapping, and begins its generation-keyed epoch;
- duplicate nickname/identity fails before resume;
- lost resume/rollback remains adopting and startup reconciliation touches only its generation;
- unadopt requires idle inside the gate with busy rejection/no mutation, transitions, blocks a racing turn, unsubscribes, closes the exact mapping generation's epoch, removes the exact mapping, frees nickname, and leaves native thread unarchived;
- archive requires idle inside the gate with busy rejection/no mutation, transitions, proves `thread/archive`, closes the exact generation's epoch, removes the exact mapping, and does not invoke delete;
- startup reconciles adopting/unadopting/archiving before returning managed entries for resume;
- reused nickname with a different `mapping_id` survives old-operation recovery.
- rename captures the expected mapping before gate acquisition, revalidates the exact generation inside, and cannot rename a nickname reused while waiting.

Update the expected assistant tool set so it contains `create_session`, `adopt_session`, `unadopt_session`, `archive_session`, and `rename_session`, but not `register_session`, `attach_session`, or `detach_session`; `adopt_session` rejects `project_dir`. Require dashboard projection to expose only managed/unavailable mappings and remove detached/attaching/archived states.

Replace old-state behavior tests before removing the union members: session observation no longer has an attaching-settings branch; service rejects execution for adopting/unadopting/archiving mappings; relay suppresses worker delivery for every non-managed mapping. Keep unavailable restore behavior only for an exact managed `mapping_id`.

- [ ] **Step 2: Run lifecycle tests and verify RED**

```bash
npm test -- tests/sessions/thread-gate.test.ts tests/sessions/lifecycle.test.ts \
  tests/assistant/tools.test.ts tests/assistant/dashboard-schema.test.ts \
  tests/assistant/session-dashboard.test.ts tests/assistant/session-dashboard-notifications.test.ts \
  tests/assistant/policy.test.ts tests/sessions/service.test.ts tests/events/relay.test.ts tests/mcp/server.test.ts
```

Expected: FAIL because the gate, reservation lifecycle, unadopt, and compare-removal APIs do not exist.

- [ ] **Step 3: Implement the shared gate and lifecycle state machine**

Create:

```ts
export class ThreadGate {
  private readonly tails = new Map<string, Promise<void>>();
  run<T>(endpointId: string, threadId: string, action: () => Promise<T>): Promise<T>;
}
```

Ensure cleanup removes only the completed tail so a later waiter cannot be skipped.

For every nickname operation, capture the complete expected mapping before waiting, acquire its endpoint/thread gate, then compare nickname, endpoint, thread, lifecycle state, and `mapping_id` again inside. Never resolve the nickname to a potentially reused mapping after gate acquisition. Route rename through this protocol as well.

Refactor lifecycle constructor to receive the shared gate. Adopt without a project argument: read and require idle, prepare/pin native cwd, reserve v3 mapping, resume with `{ threadId }`, re-read and require idle plus unchanged safe cwd, then promote and begin an epoch keyed by `mapping_id`. Implement unadopt/archive so their idle check and transition occur inside the same gate; busy state returns without checkpoint/native/registry mutation. After native unsubscribe/archive is proven, end only the checkpointed mapping generation's epoch before compare-removal. Recovery methods use stable checkpoint identity rather than nickname lookup and can never close a newer generation's epoch.

Remove register/attach/detach tool schemas, handlers, and operation-recovery branches; add unadopt. Remove obsolete detached/attaching/archived core/dashboard states. Update the managed policy's tool catalog now so the repository-wide contract remains green; Task 6 will refine its identity/placement prose without changing lifecycle names.

Startup reconciliation order must be:

```ts
await lifecycle.reconcileAdopting();
await lifecycle.reconcileRemovals();
await resumeManagedSessions(registry.managedSnapshot());
```

Internal reconnect may resume only exact managed generations; removed/transitional mappings never reach it.

- [ ] **Step 4: Verify GREEN**

```bash
npm test -- tests/sessions/thread-gate.test.ts tests/sessions/lifecycle.test.ts \
  tests/assistant/tools.test.ts tests/assistant/dashboard-schema.test.ts \
  tests/assistant/session-dashboard.test.ts tests/assistant/session-dashboard-notifications.test.ts \
  tests/assistant/policy.test.ts tests/sessions/service.test.ts tests/events/relay.test.ts tests/mcp/server.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit lifecycle serialization**

```bash
git add src/sessions/thread-gate.ts src/core/types.ts src/sessions/lifecycle.ts src/production-app.ts \
  src/assistant/tools.ts src/assistant/dashboard-schema.ts src/assistant/session-dashboard.ts \
  src/assistant/session-observer.ts src/sessions/service.ts src/events/relay.ts \
  assets/assistant/AGENTS.md tests/sessions tests/assistant tests/events tests/mcp/server.test.ts
git commit -m "feat: add race-safe session adoption lifecycle"
```

### Task 5: Enforce native cwd and protected paths at every execution mutation

**Files:**
- Modify: `src/sessions/service.ts`
- Modify: `tests/sessions/service.test.ts`
- Modify: `src/production-app.ts`
- Modify: `tests/production-app.test.ts`
- Modify: `tests/integration/app-server.test.ts`
- Modify: `tests/integration/mcp-assistant.test.ts`

- [ ] **Step 1: Write failing dispatch/recovery tests**

Inject the gate and workspace policy into `SessionService`. Add tests proving `turn/start`, `turn/steer`, `set_goal`, and `resume_goal` perform a fresh `thread/read`, require native cwd equality with the exact managed mapping, revalidate the canonical/pinned path, and issue no mutating request after:

- project replacement;
- symlink redirection into `QIYAN_HOME`;
- native cwd drift;
- mapping transition to unadopting/archiving;
- mapping generation replacement.

Assert `turn/start` carries the identical verified cwd, while pause, cancel, and interrupt remain usable to stop work. Add a barrier test showing unadopt waits for an in-flight execution check and a turn cannot cross the removal transition.

Add production recovery tests for stable checkpoint fields:

```ts
{
  endpoint: "local",
  threadId: "t1",
  projectDir: canonical,
  mappingId: "mapping-1",
  step: "native_archived",
}
```

Recovery must not resolve a current nickname to another mapping.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -- tests/sessions/service.test.ts tests/production-app.test.ts \
  tests/integration/app-server.test.ts tests/integration/mcp-assistant.test.ts
```

Expected: FAIL because `SessionService` currently mutates directly from cached registry/runtime state.

- [ ] **Step 3: Implement the dispatch choke point and operation recovery**

Add one internal helper that captures the expected generation before acquiring the shared gate and revalidates it inside:

```ts
private runVerifiedExecution<T>(nickname: string, mutate: (session: RegistrySession, cwd: string) => Promise<T>): Promise<T> {
  const expected = this.registry.requireManaged(nickname);
  return this.gate.run(expected.endpoint, expected.thread_id, async () => {
    const session = this.registry.assertExactManaged(nickname, expected.mapping_id);
    const native = await this.pool.request<ThreadResponse>(session.endpoint, "thread/read", {
      threadId: session.thread_id,
      includeTurns: false,
    });
    const project = await this.workspaces.prepareExisting(native.thread.cwd);
    await this.workspaces.assertDispatchable(project);
    if (project.path !== session.project_dir) throw new AppError("CWD_MISMATCH", "managed thread cwd changed");
    this.registry.assertExactManaged(nickname, expected.mapping_id);
    return mutate(session, project.path);
  });
}
```

Keep the read/check/mutation inside `ThreadGate.run`. Pass `cwd` only where the protocol accepts it and only unchanged. Extend production operation checkpoints/reconciliation for v3 create/adopt/unadopt/archive and remove obsolete register/attach/detach branches. Ensure startup removal recovery runs before managed resume and registry reload rejects protected/transitional inconsistencies.

- [ ] **Step 4: Run focused and real app-server integration tests**

```bash
npm test -- tests/sessions/service.test.ts tests/production-app.test.ts \
  tests/integration/app-server.test.ts tests/integration/mcp-assistant.test.ts
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/app-server.test.ts tests/integration/mcp-assistant.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit dispatch enforcement**

```bash
git add src/sessions/service.ts src/production-app.ts tests/sessions/service.test.ts \
  tests/production-app.test.ts tests/integration
git commit -m "fix: guard every managed worker dispatch"
```

### Task 6: Update QiYan identity, managed policy, and user documentation

**Files:**
- Modify: `src/assistant/runtime.ts`
- Modify: `tests/assistant/runtime.test.ts`
- Modify: `assets/assistant/AGENTS.md`
- Modify: `tests/assistant/policy.test.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/setup.md`
- Modify: `docs/chat-apps/telegram.md`
- Modify: `tests/docs.test.ts`
- Modify: `tests/rename-contract.test.ts`

- [ ] **Step 1: Write failing identity, policy, and docs tests**

Change the runtime assertion to:

```ts
assert.deepEqual(deliveries.listReady().map((item) => item.body), ["answer"]);
```

Policy tests require “Your name is QiYan,” direct work for simple tasks, Documents only as an example, semantic location ordering, `default_projects_root/<project-name>`, no user work in QiYan home/workdir, and the reduced lifecycle catalog. Preserve the concise prompt budget and `/pass`/`/collect` as the only detailed examples.

Docs tests require Telegram's canonical setup to create `~/.qiyan-bot/.env`, write the three Telegram variables, `chmod 600`, run `assistant-login`, and start without temporary exports or an external service `EnvironmentFile`. README/setup must link there and document `--home`, `QIYAN_HOME`, `qiyan-workdir`, `~/qiyan-projects`, prefix behavior, and full-access same-user secret limits.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm test -- tests/assistant/runtime.test.ts tests/assistant/policy.test.ts tests/docs.test.ts tests/rename-contract.test.ts
```

Expected: FAIL on `[assistant]`, old policy/tool catalog/defaults, and export-based Telegram instructions.

- [ ] **Step 3: Implement identity and documentation changes**

Persist QiYan finals unchanged:

```ts
body: finalText
```

Keep worker `[nickname]` and `[system]` warning formatting unchanged. Rewrite only the necessary managed-policy lines and tool catalog. Update `.env.example` and the three primary documents to match the approved setup; never include live credentials.

- [ ] **Step 4: Verify GREEN**

```bash
npm test -- tests/assistant/runtime.test.ts tests/assistant/policy.test.ts tests/docs.test.ts tests/rename-contract.test.ts
npm run typecheck
```

- [ ] **Step 5: Commit identity and guides**

```bash
git add src/assistant/runtime.ts tests/assistant/runtime.test.ts assets/assistant/AGENTS.md \
  tests/assistant/policy.test.ts .env.example README.md docs/setup.md docs/chat-apps/telegram.md \
  tests/docs.test.ts tests/rename-contract.test.ts
git commit -m "feat: refine QiYan identity and workspace guidance"
```

### Task 7: Version, package, and verify v0.3.0

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/version.ts`
- Modify: `tests/rename-contract.test.ts`
- Modify: `tests/bin.test.ts`
- Modify: `tests/distribution/package-info.test.ts`
- Modify: `tests/app-server/local-endpoint.test.ts`
- Modify: other exact-version fixtures found by `rg '0\.2\.0'`

- [ ] **Step 1: Write the failing release-version expectations**

Change canonical assertions to `0.3.0` while leaving third-party dependency versions untouched. Assert packaged execution creates context v2/default workdir and can load a private dotenv without leaking it into process/app-server environments. Run the packed `config-check --home <fixture>` and assert it exits zero with exactly `Configuration OK.` and starts no network or child process.

- [ ] **Step 2: Run version/package tests and verify RED**

```bash
npm test -- tests/distribution/package-info.test.ts tests/app-server/local-endpoint.test.ts \
  tests/rename-contract.test.ts tests/bin.test.ts
```

- [ ] **Step 3: Update release identity mechanically**

Set `package.json`, root/package entries in `package-lock.json`, and `APP_VERSION` to `0.3.0`. Update only first-party expectations identified by the focused search.

- [ ] **Step 4: Run the full verification gate**

```bash
npm run check
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/app-server.test.ts \
  tests/integration/mcp-assistant.test.ts tests/integration/recovery.test.ts
npm pack --dry-run
```

Expected: zero failures; only intentional integration skips when not explicitly enabled; package listing remains the exact approved runtime files.

Build from a no-Git source archive, install the produced tarball into a clean prefix, and verify `qiyan-bot --version` prints `0.3.0`.

- [ ] **Step 5: Commit the release slice**

```bash
git add package.json package-lock.json src/version.ts tests
git commit -m "build: prepare QiYan Bot v0.3.0"
```

### Task 8: Independent reviews and correction loop

**Files:** all changes since design commit `4e3513d`.

- [ ] **Step 1: Request parallel implementation reviews**

Give one reviewer the security/lifecycle brief (dotenv descriptor safety, secret propagation, path projection, gates, mapping generations, crash recovery) and another the product/distribution brief (tool contract, policy clarity, docs, package/version, no compatibility surface).

- [ ] **Step 2: Verify every finding against the code**

Classify Critical/Important/Minor. Fix all valid Critical and Important findings test-first; push back with code/test evidence on invalid findings. Commit focused corrections.

- [ ] **Step 3: Re-review until clear**

Ask both reviewers to inspect the corrected head. Do not proceed while either reports a Critical or Important issue.

- [ ] **Step 4: Run fresh full verification after the final fix**

```bash
npm run check
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/app-server.test.ts \
  tests/integration/mcp-assistant.test.ts tests/integration/recovery.test.ts
npm pack --dry-run
git diff --check main...HEAD
git status --short
```

Expected: all checks pass and the worktree is clean.

### Task 9: Merge, release, and perform the authorized fresh live cutover

**Files outside repository:**
- `~/.qiyan-bot/.env`
- `~/.qiyan-bot/qiyan-workdir/`
- `~/.config/systemd/user/qiyan-bot.service`

- [ ] **Step 1: Merge and push the reviewed branch**

Fast-forward `main`, rerun `npm run check` on merged main, push `main` to `git@github.com:O123O/qiyan-bot.git`, and verify the remote SHA.

- [ ] **Step 2: Tag and verify the GitHub release**

Create annotated `v0.3.0`, push it, wait for the release workflow, require the `qiyan-bot.tgz` asset and nonempty GitHub `sha256:` digest, download it, and verify the local digest and clean-prefix `--version` before touching the service.

- [ ] **Step 3: Stage only live credentials/config and auth safely**

Create an exclusive `0700` temporary directory outside `~/.qiyan-bot`. Without printing values, validate and stage only supported QiYan/Telegram settings from the current private systemd environment file into a `0600` dotenv file. Validate required owner/destination equality and absence of `QIYAN_HOME`.

Stop/disable the service and prove the bot plus all app-server descendants exited. Open old isolated `auth.json` no-follow, validate regular type/current UID/private mode/size/JSON, copy it exclusively as `0600`, and hash-verify it. Abort before deletion on any failure.

- [ ] **Step 4: Perform the explicitly authorized no-backup reset**

Remove current `~/.qiyan-bot` without creating a new backup. Create fresh `0700` home/data/qiyan-workdir, atomically install `.env` as `0600`, run `qiyan-bot config-check --home "$HOME/.qiyan-bot"`, prepare the isolated profile, and atomically restore only the staged auth cache as `0600`.

Replace the user unit with `WorkingDirectory=%h/.qiyan-bot/qiyan-workdir`, no `EnvironmentFile`, and `UnsetEnvironment` for QiYan/chat configuration keys. Run `systemd-analyze --user verify`, daemon-reload, and enable/start.

- [ ] **Step 5: Verify live invariants and destroy staging secrets**

Require: one QiYan process, two expected app-server wrapper/vendor pairs, zero restarts, registry v3 with fresh assistant and zero workers, correct database marker, context v2, managed files/dirs modes, successful `account/read`, and no dotenv-only Telegram secrets in bot or child `/proc/<pid>/environ`.

Delete the temporary auth/config files and staging directory only after those checks. Send one Telegram message and verify durable records for accepted input, completed user attempt, and confirmed prefix-free assistant final. Confirm worker-prefix behavior with a harmless worker only if needed for release acceptance.

# SSH Remote Worker Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution decision:** The user selected inline execution by the primary agent with `superpowers:executing-plans`. Do not delegate implementation. Use one persistent reviewer after the plan and at review checkpoints.

**Goal:** Add persistent SSH Codex worker endpoints while keeping the existing local worker as the default endpoint and preserving all current session, workspace, delivery, and safety invariants.

**Architecture:** Introduce a lazy endpoint manager that composes an App Server transport, endpoint-specific workspace host, and explicit QiYan-managed worker file bridge. Local keeps the current stdio child and direct filesystem behavior. SSH endpoints are catalogued by OpenSSH alias, run App Server on a private Unix socket inside `tmux -L qiyan-bot`, connect through an SSH Unix-socket forward, and reuse the detached process after tunnel or QiYan loss.

**Tech Stack:** Strict TypeScript, Node.js 24 built-ins, Zod, SQLite, OpenSSH, tmux, Codex App Server JSON-RPC, `ws` 8.x for WebSocket-over-Unix-socket, Node test runner, Docker Compose SSH fixture.

---

## File map

New focused units:

- `src/endpoints/types.ts` — shared endpoint runtime, workspace host, and worker file bridge contracts.
- `src/endpoints/catalog.ts` — strict `${QIYAN_HOME}/endpoints.json` bootstrap, secure reads, and field-level validation.
- `src/endpoints/binding-store.ts` — SQLite-backed resolved SSH destination binding.
- `src/endpoints/admission-gate.ts` — endpoint-scoped work leases and atomic drain fencing for lifecycle operations.
- `src/endpoints/manager.ts` — built-in local endpoint, lazy SSH runtime creation, startup activation, disconnect, restart, and generation events.
- `src/endpoints/ssh-process.ts` — bounded child-process runner and redacted failure mapping.
- `src/endpoints/ssh-config.ts` — `ssh -G` parsing, strict common options, and ControlMaster selection.
- `src/endpoints/ssh-host.ts` — fixed Linux remote filesystem commands and streaming transfer primitives.
- `src/endpoints/ssh-runtime.ts` — `tmux -L qiyan-bot` App Server supervision and SSH Unix-socket forwarding.
- `src/endpoints/ssh-endpoint.ts` — reconnectable App Server endpoint over the forwarded Unix socket.
- `src/endpoints/workspace-router.ts` — endpoint-aware routing into the shared project workspace policy.
- `src/endpoints/worker-file-bridge.ts` — explicit `send_to_session` upload and `prepare_chat_attachment` download only.
- `assets/remote/qiyan-ssh-helper.mjs` — fixed digest-verified remote helper for no-shell process/filesystem operations and descriptor-safe transfers.
- `assets/remote/qiyan-app-server-launcher.sh` — fixed digest-verified login-environment launcher that records and then execs the actual App Server process.
- `src/app-server/rpc-client.ts` — transport-neutral JSON-RPC peer.
- `src/app-server/jsonl-wire.ts` — current JSONL stream framing.
- `src/app-server/websocket-wire.ts` — WebSocket framing over a Unix socket.
- `src/app-server/version-compat.ts` — parse App Server user agents and enforce a minimum, rather than exact, Codex version.

Existing files with intentional changes:

- `src/app-server/json-rpc-client.ts` — compatibility wrapper around the shared RPC client.
- `src/app-server/local-endpoint.ts` — implement the expanded endpoint lifecycle contract without changing local process behavior.
- `src/app-server/pool.ts` — lazy async endpoint resolution and replacement-safe generations.
- `src/sessions/project-workspace.ts` — move filesystem effects behind `WorkspaceHost` while retaining one safety algorithm.
- `src/sessions/lifecycle.ts`, `src/sessions/service.ts` — route workspace checks by endpoint.
- `src/chat/output-actions.ts`, `src/attachments/store.ts` — use the worker file bridge for managed worker owners.
- `src/assistant/tools.ts`, `src/production-app.ts` — lifecycle tools, default-local normalization, dynamic endpoint subscriptions, recovery, and explicit transfer calls.
- `src/storage/migrations.ts` — endpoint destination bindings.
- `src/config.ts`, `src/assistant/workspace.ts` — endpoint catalog paths and bootstrap assets.
- `assets/assistant/AGENTS.md`, `assets/endpoints.example.jsonc` — assistant rules and commented endpoint example.
- `docker/ssh-worker/Dockerfile`, SSH fixture scripts/tests — tmux and persistent App Server acceptance.
- `package.json`, `package-lock.json` — direct `ws` dependency, endpoint integration script, and packaged endpoint helper/example/docs.
- `README.md`, `docs/setup.md`, `docs/development/ssh-worker-fixture.md`, new `docs/ssh-workers.md` — user and developer instructions.

## Task 1: Strict endpoint catalog and destination binding state

**Files:**
- Create: `src/endpoints/catalog.ts`
- Create: `src/endpoints/binding-store.ts`
- Modify: `src/config.ts`
- Modify: `src/storage/migrations.ts`
- Modify: `assets/endpoints.example.jsonc`
- Test: `tests/endpoints/catalog.test.ts`
- Test: `tests/endpoints/binding-store.test.ts`
- Test: `tests/storage/migrations.test.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write failing catalog tests**

Cover bootstrap, strict schema, no implicit `local` entry, secure mode, symlink/special-file rejection, maximum size, unknown fields, `~/` or absolute `projects_root`, and field-level error paths.

```ts
test("bootstraps a strict empty SSH endpoint catalog", async (t) => {
  const home = await privateTempDir(t);
  const catalog = await EndpointCatalog.open(join(home, "endpoints.json"));
  assert.deepEqual(catalog.snapshot(), { version: 1, endpoints: {} });
  assert.equal((await stat(join(home, "endpoints.json"))).mode & 0o777, 0o600);
});

test("uses the map key as the OpenSSH alias", async (t) => {
  const catalog = await catalogFixture(t, {
    version: 1,
    endpoints: { devbox: { type: "ssh", projects_root: "~/work" } },
  });
  assert.deepEqual(catalog.require("devbox"), {
    id: "devbox", type: "ssh", projectsRoot: "~/work",
  });
  assert.throws(() => catalog.require("local"), /built-in endpoint/iu);
});
```

- [ ] **Step 2: Run catalog tests and verify RED**

Run: `npm test -- tests/endpoints/catalog.test.ts tests/config.test.ts`

Expected: FAIL because `EndpointCatalog` and `endpointCatalogPath` do not exist.

- [ ] **Step 3: Implement the catalog and config path**

Use this public contract:

```ts
export interface SshEndpointDefinition {
  id: string;
  type: "ssh";
  projectsRoot: string;
}

export class EndpointCatalog {
  static open(path: string): Promise<EndpointCatalog>;
  reload(): Promise<void>;
  snapshot(): { version: 1; endpoints: Record<string, { type: "ssh"; projects_root?: string }> };
  require(id: string): SshEndpointDefinition;
}
```

The Zod entry is strict, defaults `projects_root` to `~/qiyan-projects`, reserves `local` and `assistant-local`, and accepts endpoint IDs matching the existing nickname-safe character set. Open the existing file with no-follow semantics, require an ordinary owner file no broader than mode 0600, cap input at 1 MiB, and write the bootstrap atomically as mode 0600.

Add `endpointCatalogPath: join(qiyanHome, "endpoints.json")` and `endpointBindingsPath` only if a sidecar remains necessary after Step 6; prefer SQLite below.

- [ ] **Step 4: Write failing destination-binding tests**

```ts
test("rejects a destination change while managed mappings reference the endpoint", () => {
  const store = new EndpointBindingStore(db);
  const first = { hostname: "one", user: "xin", port: 22 };
  store.checkExisting("devbox", first, false);
  assert.equal(store.get("devbox"), undefined);
  store.commitAfterActivation("devbox", first, false);
  assert.throws(
    () => store.checkExisting("devbox", { hostname: "two", user: "xin", port: 22 }, true),
    (error: unknown) => error instanceof AppError && error.code === "ENDPOINT_IDENTITY_CHANGED",
  );
});

test("read-only validation never binds a failed first activation", () => {
  const store = new EndpointBindingStore(db);
  store.checkExisting("devbox", { hostname: "one", user: "xin", port: 22 }, false);
  assert.equal(store.get("devbox"), undefined);
});
```

- [ ] **Step 5: Run binding tests and verify RED**

Run: `npm test -- tests/endpoints/binding-store.test.ts tests/storage/migrations.test.ts`

Expected: FAIL because the binding table and store do not exist.

- [ ] **Step 6: Implement SQLite binding persistence**

Add an append-only migration for:

```sql
CREATE TABLE endpoint_bindings (
  endpoint_id TEXT PRIMARY KEY,
  destination_sha256 TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

The store hashes `hostname\0user\0port` and never stores complete SSH configuration. Expose separate APIs:

```ts
checkExisting(endpointId: string, destination: SshDestination, hasReferences: boolean): void;
commitAfterActivation(endpointId: string, destination: SshDestination, hasReferences: boolean): void;
get(endpointId: string): { destinationSha256: string } | undefined;
```

`checkExisting` is read-only: an absent binding passes, the same binding passes, a change with managed/transitional references fails before any connection, and a change without references is eligible but not written. `commitAfterActivation` runs in a serialized SQLite transaction after successful App Server/account preflight, repeats the same conflict rules against current state, and inserts/replaces only then. Thus failed first activation writes nothing, while a referenced endpoint is never contacted at a changed destination.

- [ ] **Step 7: Run focused tests and commit**

Run: `npm test -- tests/endpoints/catalog.test.ts tests/endpoints/binding-store.test.ts tests/storage/migrations.test.ts tests/config.test.ts`

Expected: PASS.

```bash
git add src/endpoints/catalog.ts src/endpoints/binding-store.ts src/config.ts src/storage/migrations.ts assets/endpoints.example.jsonc tests/endpoints tests/storage/migrations.test.ts tests/config.test.ts
git commit -m "feat: add SSH endpoint catalog"
```

## Task 2: Minimum supported Codex version compatibility

**Files:**
- Create: `src/app-server/version-compat.ts`
- Modify: `src/app-server/protocol.ts`
- Modify: `src/app-server/local-endpoint.ts`
- Modify: `src/production-app.ts`
- Test: `tests/app-server/version-compat.test.ts`
- Test: `tests/app-server/protocol.test.ts`
- Test: `tests/app-server/local-endpoint.test.ts`

- [ ] **Step 1: Write failing compatibility tests**

Keep schema provenance and runtime compatibility distinct. Test the exact minimum, a newer stable release, a newer prerelease/build-tagged release, an older release, and malformed or missing versions.

```ts
test("accepts the minimum and newer Codex App Servers", () => {
  assert.equal(requireMinimumCodexVersion("codex_app_server/0.142.5", "0.142.5"), "0.142.5");
  assert.equal(requireMinimumCodexVersion("codex_app_server/0.143.0", "0.142.5"), "0.143.0");
  assert.equal(requireMinimumCodexVersion("codex_app_server/0.143.0-alpha.36 (linux)", "0.142.5"), "0.143.0");
});

test("rejects older and unparseable Codex App Servers", () => {
  assert.throws(() => requireMinimumCodexVersion("codex_app_server/0.142.4", "0.142.5"), /requires Codex app-server 0\.142\.5 or newer/u);
  assert.throws(() => requireMinimumCodexVersion("unknown", "0.142.5"), /could not determine Codex app-server version/u);
});

test("never includes the complete user agent in compatibility errors", () => {
  const sentinel = "DO_NOT_LEAK_USER_AGENT_SENTINEL";
  let thrown: unknown;
  try {
    requireMinimumCodexVersion(`codex_app_server/0.142.4 (${sentinel})`, "0.142.5");
  } catch (error) {
    thrown = error;
  }
  assert.match(String(thrown), /received 0\.142\.4/u);
  assert.doesNotMatch(String(thrown), new RegExp(sentinel, "u"));
});
```

Change the local endpoint test to pass `minimumVersion: "0.142.5"` and prove `0.143.0` and `0.143.0-alpha.36+build.1` start successfully while `0.142.4`, malformed, and missing versions fail and leave the endpoint unavailable. Capture thrown errors and test logger output with sentinel-bearing user agents so neither contains the complete user agent. Update the protocol test to assert both `GENERATED_CODEX_PROTOCOL_VERSION` and `MINIMUM_SUPPORTED_CODEX_VERSION` are currently `0.142.5`; the manifest remains an exact schema-generation record.

- [ ] **Step 2: Run compatibility tests and verify RED**

Run: `npm test -- tests/app-server/version-compat.test.ts tests/app-server/protocol.test.ts tests/app-server/local-endpoint.test.ts`

Expected: FAIL because the minimum-version parser/constants do not exist and `LocalEndpoint` still compares exact strings.

- [ ] **Step 3: Implement numeric minimum-version enforcement**

Export:

```ts
export function requireMinimumCodexVersion(userAgent: string | undefined, minimum: string): string;
```

Parse exactly three finite, safe, non-negative numeric components following the App Server product slash and allow only a version boundary, prerelease marker, build marker, whitespace, `(`, or end afterward. Compare major, minor, and patch numerically. Treat a prerelease/build suffix on a newer numeric release as newer; reject malformed, missing, or older versions. Error text reports only the minimum and parsed version, never the complete user agent.

In `protocol.ts`, replace the ambiguous exact-runtime constant with:

```ts
export const GENERATED_CODEX_PROTOCOL_VERSION = "0.142.5";
export const MINIMUM_SUPPORTED_CODEX_VERSION = GENERATED_CODEX_PROTOCOL_VERSION;
```

Rename the `LocalEndpoint` option from `expectedVersion` to `minimumVersion`, call the shared helper after `initialize`, and pass `MINIMUM_SUPPORTED_CODEX_VERSION` to both production local App Servers. The future `SshEndpoint` must call the same helper after its initialize response.

- [ ] **Step 4: Run compatibility tests and commit**

Run: `npm test -- tests/app-server/version-compat.test.ts tests/app-server/protocol.test.ts tests/app-server/local-endpoint.test.ts tests/production-app.test.ts`

Expected: PASS.

```bash
git add src/app-server/version-compat.ts src/app-server/protocol.ts src/app-server/local-endpoint.ts src/production-app.ts tests/app-server/version-compat.test.ts tests/app-server/protocol.test.ts tests/app-server/local-endpoint.test.ts
git commit -m "fix: allow newer Codex app servers"
```

## Task 3: Transport-neutral JSON-RPC and WebSocket-over-Unix framing

**Files:**
- Create: `src/app-server/rpc-client.ts`
- Create: `src/app-server/jsonl-wire.ts`
- Create: `src/app-server/websocket-wire.ts`
- Modify: `src/app-server/json-rpc-client.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `tests/app-server/rpc-client.test.ts`
- Test: `tests/app-server/websocket-wire.test.ts`
- Test: `tests/app-server/json-rpc-client.test.ts`

- [ ] **Step 1: Add direct WebSocket dependencies**

Run: `npm install --save-dev ws@8.21.0 @types/ws@8.18.1`

Expected: `ws` is a direct dependency for bundling rather than an accidental Slack transitive dependency.

- [ ] **Step 2: Write failing shared-client tests**

Use an in-memory wire to prove out-of-order responses, server requests, notifications, aborts, timeouts, and closure independent of framing.

```ts
interface RpcWire {
  send(message: string): void;
  close(): void;
  onMessage(listener: (message: string) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
}

test("matches responses and handles server requests through a generic wire", async () => {
  const wire = new MemoryWire();
  const client = new RpcClient(wire, { requestTimeoutMs: 100 });
  client.onServerRequest(async ({ method }) => ({ accepted: method === "approve" }));
  const request = client.request("thread/read", { threadId: "t" });
  wire.receive(JSON.stringify({ id: 1, result: { thread: { id: "t" } } }));
  assert.equal((await request as any).thread.id, "t");
});
```

- [ ] **Step 3: Run shared-client tests and verify RED**

Run: `npm test -- tests/app-server/rpc-client.test.ts`

Expected: FAIL because the shared client does not exist.

- [ ] **Step 4: Extract `RpcClient` and preserve JSONL behavior**

Move message correlation and dispatch from `JsonRpcClient` into `RpcClient`. `JsonlWire` owns newline parsing and string writes. Keep `JsonRpcClient` as a compatibility class with the current constructor and methods so all existing local endpoint tests remain unchanged.

- [ ] **Step 5: Write failing Unix WebSocket tests**

Start a temporary Unix-domain WebSocket server, exchange initialize/notification/server-request frames, then close it and assert pending requests reject.

```ts
const wire = await WebSocketWire.connect(`ws+unix://${socketPath}:/`, { timeoutMs: 500 });
const client = new RpcClient(wire, { requestTimeoutMs: 500 });
assert.deepEqual(await client.request("initialize", {}), { ready: true });
```

- [ ] **Step 6: Run WebSocket tests and verify RED**

Run: `npm test -- tests/app-server/websocket-wire.test.ts`

Expected: FAIL because `WebSocketWire` does not exist.

- [ ] **Step 7: Implement bounded `WebSocketWire`**

Use `ws+unix://` support from `ws`. Reject redirects, binary frames, fragmented data above 1 MiB, unexpected protocols, handshake timeout, and any non-private socket path supplied by its caller. Do not log frames.

- [ ] **Step 8: Run transport tests and commit**

Run: `npm test -- tests/app-server/rpc-client.test.ts tests/app-server/websocket-wire.test.ts tests/app-server/json-rpc-client.test.ts tests/app-server/local-endpoint.test.ts`

Expected: PASS.

```bash
git add package.json package-lock.json src/app-server tests/app-server
git commit -m "refactor: share app server RPC transports"
```

## Task 4: Endpoint lifecycle contract and lazy pool resolution

**Files:**
- Create: `src/endpoints/types.ts`
- Modify: `src/app-server/local-endpoint.ts`
- Modify: `src/app-server/pool.ts`
- Test: `tests/app-server/pool.test.ts`
- Test: `tests/app-server/local-endpoint.test.ts`

- [ ] **Step 1: Write failing lazy-resolution and generation tests**

```ts
test("resolves and starts an unknown endpoint exactly once", async () => {
  const remote = new FakeManagedEndpoint("devbox");
  let resolutions = 0;
  const pool = new AppServerPool([local], {
    maxConcurrentTurns: 2,
    resolveEndpoint: async (id) => { resolutions += 1; assert.equal(id, "devbox"); return remote; },
  });
  await Promise.all([pool.request("devbox", "model/list", {}), pool.request("devbox", "thread/list", {})]);
  assert.equal(resolutions, 1);
  assert.equal(remote.starts, 1);
});

test("a replacement generation ignores stale endpoint callbacks", async () => {
  const first = new FakeManagedEndpoint("devbox");
  const second = new FakeManagedEndpoint("devbox");
  const pool = fixturePool(first);
  pool.replaceEndpoint(second);
  first.emitUnavailable();
  assert.equal(pool.endpointGeneration("devbox").endpoint, second);
});

test("connection loss retains active and provisional capacity until authoritative reconciliation", async () => {
  const active = pool.restoreTurnCapacityClaim("devbox", "thread-a", "active", { phase: "active", turnId: "turn-a" });
  await pool.startTurn("devbox", { threadId: "thread-b", clientUserMessageId: "message-b" }).catch(() => undefined);
  pool.markEndpointUnavailable("devbox", "connection-lost");
  assert.equal(pool.activeTurnCount, 2);
  await pool.reconcileEndpointClaims("devbox");
  assert.equal(pool.activeTurnCount, 0);
  pool.markTurnTerminal(active.endpointId, active.threadId, "turn-a");
  assert.equal(pool.activeTurnCount, 0);
});

test("cold recovery restores observed active turns even above the configured limit", () => {
  const pool = fixturePool({ maxConcurrentTurns: 1 });
  pool.restoreObservedActiveTurn("devbox", "thread-a", "turn-a");
  pool.restoreObservedActiveTurn("devbox", "thread-b", "turn-b");
  pool.restoreObservedActiveTurn("devbox", "thread-a", "turn-a");
  assert.equal(pool.activeTurnCount, 2);
  assert.throws(() => pool.claimTurnCapacity("local", "thread-c", "new"), /at most 1 turn/u);
});
```

- [ ] **Step 2: Run pool tests and verify RED**

Run: `npm test -- tests/app-server/pool.test.ts tests/app-server/local-endpoint.test.ts`

Expected: FAIL because the endpoint lifecycle contract and resolver are absent.

- [ ] **Step 3: Define and implement the lifecycle contract**

```ts
export type RuntimeIdentity =
  | { kind: "local"; pid: number; startTime: string }
  | { kind: "ssh"; token: string; pid: number; linuxStartTime: string; processGroupId: number };

export type EndpointLossKind = "connection-lost" | "runtime-lost";

export interface EndpointWorkLease {
  readonly endpointId: string;
  readonly lifecycleGeneration: number;
  readonly endpointGeneration: number;
  readonly leaseId: string;
}

export interface ManagedAppServerEndpoint extends AppServerEndpoint {
  start(): Promise<void>;
  closeConnection(): Promise<void>;
  shutdownRuntime(): Promise<void>;
  runtimeIdentity(): Promise<RuntimeIdentity | undefined>;
  onNotification(listener: (method: string, params: unknown) => void): () => void;
  onReady(listener: () => void): () => void;
  onUnavailable(listener: (kind: EndpointLossKind) => void): () => void;
  onPermissionBlocked(listener: (event: PermissionBlockedEvent) => void): () => void;
}
```

For `LocalEndpoint`, `closeConnection()` and `shutdownRuntime()` both call the current stop logic; `runtimeIdentity()` returns `{kind:"local",pid,startTime}`. Preserve assistant CODEX_HOME and MCP process attestation. Add strict runtime validation for either discriminated identity when durable operation checkpoints are decoded; reject unknown fields, unsafe PIDs, invalid tokens, and non-decimal start times.

Make `AppServerPool.request()` await a deduplicated resolver/start promise. Existing constructor-only endpoints remain compatible. Add replacement generations and split unavailability semantics:

- `runtime-lost` preserves today's local behavior of releasing only self-owned claims whose execution process is proven gone;
- `connection-lost` retains every active and provisional claim plus terminal-before-start evidence;
- provisional claims retain their exact `clientUserMessageId` correlation; `startTurn` generates and sends an opaque capacity-correlation ID when a caller did not supply one, so no dispatched start is unreconcilable;
- `reconcileEndpointClaims(endpointId)` reads full authoritative histories after reconnect, binds matching provisional starts, retains active/incomplete claims, and releases a claim exactly once only for a terminal turn or a full-idle proof that its client message is absent.
- `restoreObservedActiveTurn(endpointId, threadId, turnId)` rebuilds a deterministic active claim from cold-start history, deduplicates by endpoint/thread/turn, and deliberately bypasses the admission ceiling for already-running work; `claims.size >= maxConcurrentTurns` still rejects every new claim until enough recovered turns finish.

Test active and provisional claims across tunnel loss, incomplete reconnect history, later terminal/absent proof, repeated reconciliation, and one capacity-available signal.

- [ ] **Step 4: Run pool/local tests and commit**

Run: `npm test -- tests/app-server/pool.test.ts tests/app-server/local-endpoint.test.ts tests/assistant/conversation-dispatcher.test.ts`

Expected: PASS.

```bash
git add src/endpoints/types.ts src/app-server/local-endpoint.ts src/app-server/pool.ts tests/app-server
git commit -m "feat: resolve worker endpoints lazily"
```

## Task 5: Safe SSH configuration, commands, and ControlMaster

**Files:**
- Create: `src/endpoints/ssh-process.ts`
- Create: `src/endpoints/ssh-config.ts`
- Test: `tests/endpoints/ssh-process.test.ts`
- Test: `tests/endpoints/ssh-config.test.ts`

- [ ] **Step 1: Write failing SSH configuration tests**

Cover `ssh -G` parsing, host/user/port normalization, explicit pinning of the resolved host/user/port in every real SSH invocation, existing usable ControlMaster, QiYan-owned fallback, short hashed paths, strict host-key and batch options, timeouts, and absence of config-file writes.

```ts
test("adds a private master only when effective SSH multiplexing is absent", () => {
  const plan = planSshConnection("devbox", parseSshG("hostname host\nuser xin\nport 22\ncontrolmaster no\ncontrolpath none\n"), "/run/qiyan");
  assert.equal(plan.destination.hostname, "host");
  assert.match(plan.controlPath!, /\/ssh\/[a-f0-9]{24}$/u);
  assert.deepEqual(plan.commonArgs.slice(0, 4), ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes"]);
});

test("re-resolves and pins the destination for every connection generation", async () => {
  const config = mutableSshConfig({ hostname: "host-one", user: "xin", port: 22 });
  const first = await planner.createGeneration("devbox", config.read);
  assert.deepEqual(first.destinationArgs, ["-o", "HostName=host-one", "-l", "xin", "-p", "22"]);
  config.replace({ hostname: "host-two", user: "xin", port: 22 });
  await assert.rejects(planner.createGeneration("devbox", config.read), /destination identity changed/u);
});
```

- [ ] **Step 2: Run SSH tests and verify RED**

Run: `npm test -- tests/endpoints/ssh-process.test.ts tests/endpoints/ssh-config.test.ts`

Expected: FAIL because the SSH process/config modules do not exist.

- [ ] **Step 3: Implement bounded process execution and SSH plans**

The process runner accepts only command plus argument arrays, optional stdin stream, output byte limits, timeout, and abort signal. It drains stderr but returns only a categorized, bounded diagnostic. It never returns command environments or output bodies from App Server/attachment operations.

The SSH plan must always use:

```ts
const required = [
  "-o", "BatchMode=yes",
  "-o", "StrictHostKeyChecking=yes",
  "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3",
];
```

Every master, tunnel, reconnect, host operation, and transfer generation reruns `ssh -G`. Compare its normalized host/user/port with any durable binding, then add explicit `HostName`, `-l`, and `-p` command-line arguments so a later alias reread cannot change the final destination. The alias remains the host-pattern selector for ProxyJump, identities, and other user configuration. Honor a user ControlMaster only when both effective `controlmaster` and `controlpath` are usable with those pinned destination arguments. Otherwise add a QiYan-owned `-S` control path, `ControlMaster=auto`, and bounded `ControlPersist`. Provide an explicit `ssh -O exit` operation only for QiYan-owned masters.

Do not persist a first or replacement binding during configuration inspection. This task calls only `checkExisting` before connection and carries a `PendingDestinationBinding` containing the normalized tuple through activation; Task 7 owns the post-success commit. Test that planning and failed process attempts never change the binding store.

- [ ] **Step 4: Run SSH tests and commit**

Run: `npm test -- tests/endpoints/ssh-process.test.ts tests/endpoints/ssh-config.test.ts`

Expected: PASS.

```bash
git add src/endpoints/ssh-process.ts src/endpoints/ssh-config.ts tests/endpoints/ssh-process.test.ts tests/endpoints/ssh-config.test.ts
git commit -m "feat: add strict SSH connection planning"
```

## Task 6: Detached tmux runtime, Unix-socket tunnel, and SSH endpoint

**Files:**
- Create: `assets/remote/qiyan-app-server-launcher.sh`
- Create: `assets/remote/qiyan-ssh-helper.mjs`
- Create: `src/endpoints/ssh-runtime.ts`
- Create: `src/endpoints/ssh-endpoint.ts`
- Test: `tests/endpoints/ssh-helper.test.ts`
- Test: `tests/endpoints/ssh-runtime.test.ts`
- Test: `tests/endpoints/ssh-endpoint.test.ts`

- [ ] **Step 1: Write failing tmux isolation tests**

```ts
test("every tmux command uses the alternate qiyan-bot server", async () => {
  const runner = new RecordingSshRunner();
  const runtime = fixtureRuntime(runner);
  await runtime.inspect();
  await runtime.start();
  await runtime.stop();
  for (const call of runner.remoteCommandsContaining("tmux")) {
    assert.match(call, /tmux -L qiyan-bot -f \/dev\/null/u);
    assert.doesNotMatch(call, /tmux (?:ls|kill-server)(?:\s|$)/u);
  }
});

test("a hostile user tmux config cannot destroy detached QiYan sessions", async () => {
  userTmuxConfig.write("set -g destroy-unattached on\nset-hook -g session-created 'run-shell false'\n");
  await runtime.start();
  assert.equal(await runtime.inspect(), "healthy");
  assert.equal(userTmuxConfig.readCount, 0);
});

test("the fixed login launcher preserves login-only worker environment", async () => {
  loginProfile.set({ PATH: "/login-only/bin", CODEX_HOME: "/login-only/codex-home" });
  await runtime.start();
  assert.deepEqual(helper.observedEnvironment(), {
    PATH: "/login-only/bin", CODEX_HOME: "/login-only/codex-home",
  });
});

test("reuses an existing healthy App Server instead of starting another", async () => {
  const runtime = fixtureRuntimeWithHealthySession();
  await runtime.ensureStarted();
  assert.equal(runtime.tmuxStarts, 0);
});

test("runtime identity survives reconnect but changes after replacement", async () => {
  const runtime = fixtureRuntimeWithIncarnation("aaa", 123, 456n);
  const first = await runtime.identity();
  await runtime.closeTunnel();
  assert.equal(await runtime.identity(), first);
  runtime.replaceWithIncarnation("bbb", 123, 789n);
  assert.notEqual(await runtime.identity(), first);
});
```

- [ ] **Step 2: Run runtime tests and verify RED**

Run: `npm test -- tests/endpoints/ssh-runtime.test.ts`

Expected: FAIL because the supervisor does not exist.

- [ ] **Step 3: Write failing helper and command-safety tests**

Test both packaged asset digests, owner-only staging, fixed operation allowlist, bounded base64url argument codec, and commands containing only fixed ASCII tokens. Exercise paths containing newline, single/double quotes, `$()`, backticks, a leading `-`, spaces, and Unicode. Assert each value round-trips only after helper decoding and that none appears literally in any SSH remote-command or tmux shell-command string.

For the download operation, inject a path replacement after initial containment validation and before helper open. Prove the helper uses `O_NOFOLLOW`, `fstat`s and streams the same descriptor, reports device/inode/size/SHA-256, and refuses symlinks, non-regular files, or a changed object.

- [ ] **Step 4: Run helper tests and verify RED**

Run: `npm test -- tests/endpoints/ssh-helper.test.ts tests/endpoints/ssh-runtime.test.ts`

Expected: FAIL because the fixed helper, argument codec, incarnation record, and supervisor do not exist.

- [ ] **Step 5: Implement the fixed helper, remote preflight, and tmux supervision**

Use endpoint-hash session names, a short mode-0700 remote directory, and these lifecycle commands through fixed scripts. Every backend invocation includes both the alternate label and disabled user configuration:

```text
tmux -L qiyan-bot -f /dev/null has-session -t <encoded-session>
tmux -L qiyan-bot -f /dev/null new-session -d -s <encoded-session> <fixed-login-shell-launcher>
tmux -L qiyan-bot -f /dev/null kill-session -t <encoded-session>
```

Preflight proves Linux, Node.js, required core utilities, `tmux`, remote login-shell `codex`, normalized home/uid, and an absolute executable login shell whose path matches a strict safe-token allowlist. Bootstrap `assets/remote/qiyan-ssh-helper.mjs` and `assets/remote/qiyan-app-server-launcher.sh` into the private runtime directory with mode 0700 and verify their packaged SHA-256 values before each new runtime generation. The only remote command form is a fixed helper/bootstrap operation plus strictly validated ASCII operation names, hex/decimal IDs, or bounded base64url arguments. The helper decodes paths as data and uses Node filesystem/child-process APIs with `shell: false`.

Make `<fixed-login-shell-launcher>` concrete: the validated login-shell path runs with `-lc`; its fixed command contains only `exec`, the allowlisted private launcher path, a locally generated 128-bit hex token, and encoded runtime paths. The login shell therefore loads login-only `PATH`, `CODEX_HOME`, provider settings, and Codex configuration. The fixed launcher resolves `command -v codex`, requires an absolute executable safe path, atomically writes `{kind:"ssh",token,pid:$$,linuxStartTime,processGroupId}` as mode 0600, and then `exec`s that exact Codex path with fixed App Server arguments. The PID/start time in the identity therefore belongs to the actual App Server, not a parent helper. No decoded value or profile-derived environment value is inserted into the tmux shell command.

`runtimeIdentity()` validates the launcher metadata against `/proc/<pid>/stat` and the recorded process group; deterministic tmux/socket names are never treated as incarnation identity. A missing tmux session or leader with any live member in the attested group is `connection-lost`/unhealthy, never `runtime-lost`. Explicit shutdown signals the exact owned process group, waits a bounded grace period, escalates to `SIGKILL`, and proves no matching descendant remains. Only that empty-group proof permits `runtime-lost`, stale socket/metadata removal, or capacity release. Never use the tmux pane for RPC.

- [ ] **Step 6: Write failing endpoint reconnect tests**

Use a fake WebSocket wire and tunnel process to prove:

- first start launches tmux then tunnel;
- tunnel loss marks only the connection unavailable;
- unexpected tunnel/WebSocket loss emits `connection-lost`, while an attested missing supervisor emits `runtime-lost`;
- reconnect uses the same attested `{kind:"ssh",token,pid,linuxStartTime,processGroupId}` identity;
- runtime restart or simulated reboot returns a different identity despite identical tmux/socket names;
- killing the tmux session performs bounded process-group termination and leaves no App Server descendant;
- killing only the recorded leader while an attested group member remains never emits `runtime-lost`, removes the socket, or releases capacity;
- `closeConnection()` leaves tmux alive;
- `shutdownRuntime()` kills only the endpoint session;
- an existing but unhealthy session is never killed automatically;
- account preflight rejects only `account === null && requiresOpenaiAuth === true`;
- minimum `0.142.5`, newer stable, and newer prerelease/build versions initialize successfully;
- older, malformed, and missing versions fail without exposing a sentinel-bearing complete user agent in errors or captured logs;
- stale generations cannot emit notifications.

- [ ] **Step 7: Run endpoint tests and verify RED**

Run: `npm test -- tests/endpoints/ssh-endpoint.test.ts`

Expected: FAIL because `SshEndpoint` does not exist.

- [ ] **Step 8: Implement the SSH endpoint**

`SshEndpoint` implements `ManagedAppServerEndpoint`, creates `ssh -N -L local_socket:remote_socket` with the current generation's pinned destination arguments, uses `StreamLocalBindUnlink=yes`, connects with `WebSocketWire`, performs the same initialize/initialized sequence and `MINIMUM_SUPPORTED_CODEX_VERSION` check as `LocalEndpoint`, rejects approvals, and exposes the attested helper incarnation identity. Compatibility failures retain only the parsed version or `unknown`.

`closeConnection()` closes WebSocket/tunnel and a QiYan-owned ControlMaster but leaves tmux running. `shutdownRuntime()` first closes the connection, then kills only the endpoint tmux session. Unexpected tunnel/WebSocket loss emits `connection-lost`; only an attested absent/dead supervisor emits `runtime-lost`. Intentional lifecycle closure suppresses unavailable events. Emit one transition per generation.

- [ ] **Step 9: Run endpoint tests and commit**

Run: `npm test -- tests/endpoints/ssh-helper.test.ts tests/endpoints/ssh-runtime.test.ts tests/endpoints/ssh-endpoint.test.ts tests/app-server/websocket-wire.test.ts`

Expected: PASS.

```bash
git add assets/remote/qiyan-app-server-launcher.sh assets/remote/qiyan-ssh-helper.mjs src/endpoints/ssh-runtime.ts src/endpoints/ssh-endpoint.ts tests/endpoints/ssh-helper.test.ts tests/endpoints/ssh-runtime.test.ts tests/endpoints/ssh-endpoint.test.ts
git commit -m "feat: run persistent SSH app servers"
```

## Task 7: Endpoint manager, startup activation, disconnect, and restart

**Files:**
- Create: `src/endpoints/admission-gate.ts`
- Create: `src/endpoints/manager.ts`
- Modify: `src/app-server/pool.ts`
- Test: `tests/endpoints/admission-gate.test.ts`
- Test: `tests/endpoints/manager.test.ts`

- [ ] **Step 1: Write failing endpoint-manager tests**

```ts
test("local is built in and the default while SSH endpoints are lazy", async () => {
  const manager = fixtureManager();
  assert.equal((await manager.ensureReady()).id, "local");
  assert.equal(manager.createdRemoteCount, 0);
  assert.equal((await manager.ensureReady("devbox")).id, "devbox");
  assert.equal(manager.createdRemoteCount, 1);
});

test("startup failure of one referenced remote does not fail other endpoints", async () => {
  const result = await manager.activateReferenced(["offline", "healthy"]);
  assert.deepEqual(result.unavailable, ["offline"]);
  assert.equal(manager.state("healthy"), "ready");
  assert.equal(manager.state("local"), "ready");
});

test("disconnect fences new work before the final idle proof", async () => {
  const paused = manager.pauseAfterIdleProof("devbox");
  const disconnect = manager.disconnect("devbox");
  await paused.reached;
  await assert.rejects(pool.request("devbox", "turn/start", turn), /endpoint is draining/u);
  await assert.rejects(manager.withWorkLease("devbox", "file-transfer", async () => undefined), /endpoint is draining/u);
  paused.release();
  await disconnect;
});

test("explicit disconnect cancels a scheduled reconnect", async () => {
  remote.failTunnel();
  assert.equal(scheduler.pending("devbox"), 1);
  await manager.disconnect("devbox");
  scheduler.runAll();
  assert.equal(remote.runtimeStarts, 0);
  assert.equal(manager.desiredState("devbox"), "disconnected");
});

test("a drain does not reject nested RPCs from an already-admitted lease", async () => {
  const outer = manager.withWorkLease("devbox", "session-mutation", async (_endpoint, lease) => {
    workspaceCheckpoint.arrive();
    await workspaceCheckpoint.continue;
    await pool.request("devbox", "thread/read", { threadId: "t" }, undefined, lease);
    await pool.request("devbox", "thread/resume", { threadId: "t" }, undefined, lease);
  });
  await workspaceCheckpoint.reached;
  const draining = manager.disconnect("devbox");
  await manager.waitUntilDraining("devbox");
  workspaceCheckpoint.release();
  await outer;
  await draining;
});
```

Also test deduplicated starts, catalog reload on inactive start, binding only after successful App Server/account activation, no binding after failed first activation, serialized concurrent first activation, config mutation between connection generations, close-on-QiYan-shutdown versus runtime shutdown, exponential reconnect, and callback generation fencing. Test that draining waits for an already-admitted generic multi-RPC operation, then rereads native history; an active turn or unprovable read reopens the gate and prevents shutdown. Task 8 wires the same lease through concrete session/workspace sequences and Task 9 wires file transfers.

- [ ] **Step 2: Run manager tests and verify RED**

Run: `npm test -- tests/endpoints/admission-gate.test.ts tests/endpoints/manager.test.ts tests/app-server/pool.test.ts`

Expected: FAIL because `EndpointManager` does not exist.

- [ ] **Step 3: Implement `EndpointManager`**

Implement an `EndpointAdmissionGate` per endpoint. `beginDrain()` atomically rejects new leases, waits for existing leases, and returns a generation-bound drain handle that either commits shutdown or reopens admission. Lifecycle-owned reads and stop/start calls use the handle's private path and do not reacquire an ordinary lease.

`withWorkLease` creates an opaque `EndpointWorkLease` once per logical operation. `AppServerPool.request`, `startTurn`, `readFullThread`, and `interrupt` accept an optional final lease parameter and pass it through every nested/reconciliation RPC. Without a lease, the pool obtains one around the whole public call. With a lease, the resolver validates endpoint ID, lifecycle generation, and lease liveness and does not reacquire admission. A stale, foreign, released, or fabricated token is rejected. This makes admitted work reentrant across a drain without allowing new work.

Use this public surface:

```ts
export class EndpointManager {
  normalize(id?: string): string; // omitted => local
  ensureReady(id?: string): Promise<ManagedAppServerEndpoint>;
  withWorkLease<T>(id: string | undefined, kind: "rpc" | "session-mutation" | "file-transfer", run: (endpoint: ManagedAppServerEndpoint, lease: EndpointWorkLease) => Promise<T>): Promise<T>;
  activateReferenced(ids: readonly string[]): Promise<{ unavailable: string[] }>;
  disconnect(id?: string, checkpoint?: (value: unknown) => void): Promise<void>;
  restart(id?: string, checkpoint?: (value: unknown) => void): Promise<void>;
  closeConnections(): Promise<void>;
  desiredState(id: string): "automatic" | "draining" | "disconnected";
  onEndpoint(listener: (endpoint: ManagedAppServerEndpoint, generation: number) => void): () => void;
}
```

Each endpoint tracks an explicit process-local desired state: `automatic`, `draining`, or `disconnected`, plus a lifecycle generation. Before disconnect/restart, transition to `draining`, cancel and generation-fence scheduled reconnects, drain existing leases, then read every managed thread directly and prove idle. If connection cannot be restored or any status is active/systemError/unprovable, reopen admission in `automatic` state and return a no-effect error. Keep the gate closed from the final idle proof through stop/restart. A later normal endpoint operation changes `disconnected` back to `automatic`; a stale reconnect timer cannot do so.

Serialize endpoint activation. Before contact, require the read-only `checkExisting` result from Task 1 and use Task 5's pinned destination. Only after initialize and account preflight succeed, call `commitAfterActivation` with a fresh registry-reference check, then publish the endpoint as ready. A failed activation or a commit conflict closes the new connection and publishes no ready generation.

Checkpoint the old validated discriminated `RuntimeIdentity` and stopped/started phases so operation recovery can distinguish tunnel reconnection from a replacement runtime and finish idempotently.

Normal application shutdown calls `closeConnections()`: local stops, SSH tunnels close, remote tmux persists. Explicit disconnect calls `shutdownRuntime()` for either implementation. Restart validates catalog/SSH prerequisites before stop, then shuts down and starts a new endpoint generation.

- [ ] **Step 4: Run manager tests and commit**

Run: `npm test -- tests/endpoints/admission-gate.test.ts tests/endpoints/manager.test.ts tests/app-server/pool.test.ts`

Expected: PASS.

```bash
git add src/endpoints/admission-gate.ts src/endpoints/manager.ts src/app-server/pool.ts tests/endpoints/admission-gate.test.ts tests/endpoints/manager.test.ts tests/app-server/pool.test.ts
git commit -m "feat: manage worker endpoint lifecycle"
```

## Task 8: Shared workspace policy over local and SSH hosts

**Files:**
- Create: `src/endpoints/ssh-host.ts`
- Create: `src/endpoints/workspace-router.ts`
- Modify: `src/sessions/project-workspace.ts`
- Modify: `src/sessions/lifecycle.ts`
- Modify: `src/sessions/service.ts`
- Modify: `src/production-app.ts`
- Test: `tests/endpoints/ssh-host.test.ts`
- Test: `tests/sessions/project-workspace.test.ts`
- Test: `tests/sessions/lifecycle.test.ts`
- Test: `tests/sessions/service.test.ts`

- [ ] **Step 1: Add a host contract suite and verify RED**

Define one reusable suite for local and fake-SSH hosts:

```ts
export interface WorkspaceHost {
  readonly endpointId: string;
  home(): Promise<string>;
  lstat(path: string): Promise<{ kind: "directory" | "file" | "symlink" | "missing"; device?: string; inode?: string }>;
  realpath(path: string): Promise<string>;
  mkdir(path: string, options: { recursive: boolean; mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}
```

Run existing traversal, symlink, protected-root, fallback collision, missing-parent, inode replacement, and dispatch race tests against both hosts. The fake SSH host records operations rather than touching local filesystem paths. Include newline, quote, `$()`, backtick, leading-hyphen, space, and Unicode paths and prove none appears literally in a recorded remote command.

Add concrete `SessionService` and `SessionLifecycle` races: pause an already-admitted mutation after its first workspace check, begin endpoint draining, then allow its first and second nested RPC plus a second workspace assertion. All calls using the same lease must finish and drain must wait. A second mutation arriving after drain starts must fail before workspace or RPC effects. Assert endpoint lease is acquired before `ThreadGate` to prevent lock inversion.

- [ ] **Step 2: Run workspace tests and verify RED**

Run: `npm test -- tests/sessions/project-workspace.test.ts tests/endpoints/ssh-host.test.ts tests/sessions/lifecycle.test.ts tests/sessions/service.test.ts`

Expected: FAIL because workspace effects are still hard-coded to Node filesystem APIs.

- [ ] **Step 3: Refactor one safety algorithm over `WorkspaceHost`**

Keep path projection, overlap rules, device/inode checks, fallback exclusivity, and checkpoint shape in `ProjectWorkspacePolicy`. Replace direct filesystem calls with the host interface. Use POSIX path operations for the Linux-only SSH implementation.

`SshHost` invokes only the digest-verified helper from Task 6. Encode every path and operation value as bounded UTF-8 base64url matching `^[A-Za-z0-9_-]+$`; operation names, endpoint hashes, and numeric fields have separate strict allowlists. Remote command strings contain only the fixed helper path and those validated ASCII tokens. The helper decodes arguments and calls filesystem APIs directly without a shell. Return bounded structured fields; never interpolate a raw or decoded path into a command string.

- [ ] **Step 4: Route workspace operations by endpoint**

```ts
export class WorkspaceRouter {
  prepareCreate(endpointId: string, nickname: string, requested?: string, lease?: EndpointWorkLease): Promise<PreparedProjectWorkspace>;
  prepareExisting(endpointId: string, path: string, lease?: EndpointWorkLease): Promise<PreparedProjectWorkspace>;
  assertDispatchable(endpointId: string, prepared: PreparedProjectWorkspace, lease?: EndpointWorkLease): Promise<void>;
}
```

Modify lifecycle and session service mutation paths to acquire one endpoint `session-mutation` lease outside `ThreadGate`, then carry the same token through every workspace prepare/assert and every pool RPC. Do not reacquire between validation, reservation, resume/start/steer, rollback, or promotion. Read-only single-RPC calls may let the pool acquire a short lease. Recovery must use the endpoint recorded in the operation checkpoint or registry mapping, never the current default, and must obtain one new lease for the whole recovered logical operation.

- [ ] **Step 5: Run workspace/session tests and commit**

Run: `npm test -- tests/endpoints/ssh-host.test.ts tests/sessions/project-workspace.test.ts tests/sessions/lifecycle.test.ts tests/sessions/service.test.ts tests/assistant/tools.test.ts`

Expected: PASS.

```bash
git add src/endpoints/ssh-host.ts src/endpoints/workspace-router.ts src/sessions src/production-app.ts tests/endpoints/ssh-host.test.ts tests/sessions tests/assistant/tools.test.ts
git commit -m "refactor: route workspace policy by endpoint"
```

## Task 9: Explicit QiYan-managed worker file bridge

**Files:**
- Create: `src/endpoints/worker-file-bridge.ts`
- Modify: `src/attachments/store.ts`
- Modify: `src/chat/output-actions.ts`
- Modify: `src/production-app.ts`
- Modify: `src/sessions/service.ts`
- Test: `tests/endpoints/worker-file-bridge.test.ts`
- Test: `tests/attachments/store.test.ts`
- Test: `tests/assistant/tools.test.ts`
- Test: `tests/sessions/service.test.ts`

- [ ] **Step 1: Write failing explicit-transfer tests**

```ts
test("send_to_session uploads only selected active-attempt attachments", async () => {
  const bridge = fixtureRemoteBridge();
  const input = await bridge.toWorkerInput({
    lease, mapping: { endpoint: "devbox", thread_id: "thread-1", mapping_id: "map-1" },
    projectRoot: "/home/xin/project", scopeId: "scope", attachmentId: "file_a",
  });
  assert.deepEqual(input, { type: "mention", name: "requirements.pdf", path: bridge.remotePath("file_a") });
  assert.deepEqual(bridge.uploadedIds, ["file_a"]);
});

test("prepare_chat_attachment downloads one selected remote project file", async () => {
  const result = await bridge.prepareProjectFile({
    endpointId: "devbox", projectRoot: "/home/xin/project", scopeId: "scope",
    mapping: { endpoint: "devbox", thread_id: "thread-1", mapping_id: "map-1" },
    relativePath: "out/report.txt", requestedId: "file_result",
  });
  assert.equal(result.id, "file_result");
  assert.deepEqual(bridge.downloadedPaths, ["/home/xin/project/out/report.txt"]);
});
```

Also prove no upload occurs for text-only sends, local behavior remains direct, remote hash mismatch cleans temporary state, traversal/symlinks/special files fail before streaming, interrupted streams do not promote, and `send_chat_attachment` stays endpoint-agnostic. Add races where the selected path is replaced after containment validation, the mapping ID/project changes, the endpoint connection generation changes, or disconnect begins while a transfer is active. For upload, pause after bytes are prepared but before `turn/start`/`turn/steer`, then replace the mapping or connection generation and prove no RPC sends the stale remote path. For download, mismatches fail without promotion. Disconnect waits for an admitted transfer/send sequence and rejects transfers arriving after draining begins.

- [ ] **Step 2: Run bridge tests and verify RED**

Run: `npm test -- tests/endpoints/worker-file-bridge.test.ts tests/attachments/store.test.ts tests/assistant/tools.test.ts tests/sessions/service.test.ts`

Expected: FAIL because the bridge does not exist.

- [ ] **Step 3: Implement the bridge**

```ts
export interface WorkerFileBridge {
  toWorkerInput(input: {
    lease: EndpointWorkLease;
    mapping: MappingIdentity;
    projectRoot: string;
    scopeId: string;
    attachmentId: FileHandleId;
  }): Promise<unknown>;
  prepareProjectFile(input: {
    endpointId: string;
    projectRoot: string;
    mapping: MappingIdentity;
    scopeId: string;
    relativePath: string;
    requestedId: FileHandleId;
  }): Promise<StoredAttachment>;
}
```

`prepareProjectFile` acquires `EndpointManager.withWorkLease(endpointId, "file-transfer", ...)` for its complete validation/stream/promotion lifetime. Capture the endpoint connection generation and the exact `MappingIdentity`, managed state, and project directory before opening bytes.

Uploads do not acquire a second lease. Extend `SessionService.send` with a `prepareInput({session, projectRoot, lease})` callback executed inside the exact mapping's outer `session-mutation` lease from Task 8. Production resolves each selected attachment through `toWorkerInput` using that same lease and mapping. After preparation, `SessionService` rechecks the mapping/project and passes the same lease into `startTurn` or `turn/steer`; the pool validates its still-current endpoint generation. This one fence spans attachment upload and dispatch.

Local delegates to `AttachmentStore.toUserInput` and `prepareOutbound`. SSH upload uses `openForUpload` and the fixed helper to create an owner-only temporary regular file, stream from the retained descriptor, verify size/SHA-256, and atomically rename to a content-addressed private staging path.

SSH download first applies project containment policy, then asks the fixed helper to open with `O_RDONLY | O_NOFOLLOW`, require a regular file with `fstat`, and stream from that same descriptor. Use a bounded frame containing initial device/inode/size metadata, exactly that many bytes, and a final SHA-256 plus second `fstat`; reject identity, size, timestamp, or digest changes. Ingest into a non-promoted local temporary object. Immediately before promotion, recheck the exact registry mapping/project and endpoint generation captured at start. Any mismatch, interruption, or path swap removes temporary state. Keep existing operation/turn attachment holds unchanged.

Change `createChatOutputActions` to accept `prepareAttachment(owner, relativePath, scopeId, requestedId)` instead of assuming every managed project is local. In operation reconciliation, call the same idempotent bridge method.

- [ ] **Step 4: Run bridge tests and commit**

Run: `npm test -- tests/endpoints/worker-file-bridge.test.ts tests/attachments/store.test.ts tests/assistant/tools.test.ts tests/sessions/service.test.ts tests/integration/mcp-assistant.test.ts`

Expected: PASS.

```bash
git add src/endpoints/worker-file-bridge.ts src/attachments/store.ts src/chat/output-actions.ts src/production-app.ts src/sessions/service.ts tests/endpoints/worker-file-bridge.test.ts tests/attachments/store.test.ts tests/assistant/tools.test.ts tests/sessions/service.test.ts
git commit -m "feat: bridge files to SSH workers"
```

## Task 10: Endpoint lifecycle tools and durable recovery

**Files:**
- Modify: `src/assistant/tools.ts`
- Modify: `src/production-app.ts`
- Modify: `assets/assistant/AGENTS.md`
- Test: `tests/assistant/tools.test.ts`
- Test: `tests/assistant/policy.test.ts`
- Test: `tests/production-app.test.ts`

- [ ] **Step 1: Write failing tool-schema and action tests**

```ts
assert.deepEqual(ASSISTANT_TOOL_SCHEMAS.disconnect_endpoint.parse({}), { endpoint: "local" });
assert.deepEqual(ASSISTANT_TOOL_SCHEMAS.restart_endpoint.parse({ endpoint: "devbox" }), { endpoint: "devbox" });

test("restart_endpoint checkpoints phases and refuses an active worker", async () => {
  await assert.rejects(
    tools.restart_endpoint(context, { endpoint: "devbox" }),
    (error: unknown) => error instanceof AppError && error.code === "SESSION_BUSY",
  );
});
```

Add crash-recovery cases at `draining`, `idle_proven`, `runtime_stopped`, and `runtime_started`. Use identical deterministic tmux/socket names with different attested incarnation tokens to prove recovery never confuses a replacement runtime with the checkpointed one. Add an explicit-disconnect case with a pending reconnect timer and prove recovery leaves no stale timer capable of recreating the stopped runtime.

- [ ] **Step 2: Run tool tests and verify RED**

Run: `npm test -- tests/assistant/tools.test.ts tests/assistant/policy.test.ts tests/production-app.test.ts`

Expected: FAIL because the lifecycle tools do not exist.

- [ ] **Step 3: Add `disconnect_endpoint` and `restart_endpoint`**

Schemas:

```ts
disconnect_endpoint: z.object({ endpoint: z.string().min(1).default("local") }).strict(),
restart_endpoint: z.object({ endpoint: z.string().min(1).default("local") }).strict(),
```

Register both as side-effecting operations. Actions delegate to `EndpointManager` with operation checkpoints. Reconciliation is idempotent:

- disconnect recovery reacquires the endpoint drain, cancels reconnect, proves idle again when stop was not checkpointed, and ensures the runtime is stopped;
- restart recovery parses the checkpoint with the strict discriminated `RuntimeIdentity` validator, compares the old identity, finishes a stopped start, accepts an already-started different attested incarnation only at the `runtime_started` phase, or performs the restart if the exact old incarnation still runs;
- neither operation is blindly marked successful from an unproven transport state.

Update the concise policy tool list and add only the endpoint/default semantics, not examples for every tool.

- [ ] **Step 4: Run tool tests and commit**

Run: `npm test -- tests/assistant/tools.test.ts tests/assistant/policy.test.ts tests/production-app.test.ts`

Expected: PASS.

```bash
git add src/assistant/tools.ts src/production-app.ts assets/assistant/AGENTS.md tests/assistant/tools.test.ts tests/assistant/policy.test.ts tests/production-app.test.ts
git commit -m "feat: expose endpoint lifecycle tools"
```

## Task 11: Production composition, dynamic subscriptions, and recovery

**Files:**
- Modify: `src/production-app.ts`
- Modify: `src/events/relay.ts`
- Modify: `src/assistant/session-observations.ts`
- Modify: `src/config.ts`
- Test: `tests/production-startup.test.ts`
- Test: `tests/production-app.test.ts`
- Test: `tests/events/relay.test.ts`
- Test: `tests/assistant/session-dashboard-notifications.test.ts`

- [ ] **Step 1: Write failing production recovery tests**

Test these exact behaviors with fake local and SSH endpoints:

- local and assistant start remain mandatory;
- catalog-only remote entries are not started;
- referenced remote endpoints start before managed-session reconciliation;
- a cold process start with an empty pool rebuilds claims for every authoritative nonterminal managed turn before chat adapters accept work;
- recovered active turns deduplicate and may exceed a newly lowered configured limit, blocking new claims until enough turns become terminal;
- one remote failure leaves QiYan/local/other remotes healthy and marks only its sessions unavailable;
- dynamic remote notifications use the correct endpoint ID and generation;
- SSH `connection-lost` retains active and provisional capacity claims while local/proven `runtime-lost` preserves current cleanup behavior;
- reconnect reconciles retained claims from full history before advertising capacity, releasing terminal/absent claims once and retaining active/incomplete claims;
- tunnel recovery calls `EventRelay.reconcileEndpoint`, whose existing delivery cursor prevents duplicate worker finals;
- one unavailable and one recovered warning are emitted per incident;
- normal QiYan shutdown closes remote tunnels but leaves tmux runtime alive.

```ts
test("startup isolates an unavailable referenced SSH endpoint", async () => {
  const app = fixtureProduction({ managedEndpoints: ["offline", "healthy"] });
  await app.start();
  assert.equal(app.local.state, "ready");
  assert.equal(app.remote("healthy").state, "ready");
  assert.equal(app.runtimeSession("offline-worker").managementState, "unavailable");
});

test("cold startup restores surviving remote capacity before accepting input", async () => {
  const app = fixtureProduction({ maxConcurrentTurns: 1, remoteHistory: activeTurns(2) });
  await app.start();
  assert.equal(app.pool.activeTurnCount, 2);
  assert.equal(app.chatAdapters.startedAfterCapacityRecovery, true);
  assert.throws(() => app.pool.claimTurnCapacity("local", "thread-new", "new"), /at most 1 turn/u);
});
```

- [ ] **Step 2: Run production tests and verify RED**

Run: `npm test -- tests/production-startup.test.ts tests/production-app.test.ts tests/events/relay.test.ts tests/assistant/session-dashboard-notifications.test.ts`

Expected: FAIL because production still assumes one project endpoint.

- [ ] **Step 3: Wire `EndpointManager` into production**

Replace the single project `endpoint` variable with `localEndpoint` plus `EndpointManager`. Pass `manager.ensureReady` to the pool resolver. Register notification, permission, ready, and unavailable callbacks exactly once per endpoint generation through `manager.onEndpoint`.

Generalize unavailable/reconnect handlers to `ManagedAppServerEndpoint` and pass their typed `EndpointLossKind` into the pool; keep assistant recovery separate. Remove the `session.endpoint === local` filter from managed-session recovery. Group registry sessions by endpoint, activate each endpoint, reconcile successes, and warn failures without throwing application startup.

On cold startup, keep chat adapters stopped until referenced endpoint activation and managed-session reconciliation have returned authoritative histories. For every nonterminal turn in those histories, call `restoreObservedActiveTurn`; this rebuild is idempotent and may place the pool above its configured maximum. Then start input adapters. After an in-process connection returns, call `AppServerPool.reconcileEndpointClaims` before normal capacity wakeup. In both paths, use existing `EventRelay.reconcileEndpoint` plus its runtime delivery cursor instead of adding a second final-delivery ledger. An incomplete claim reconciliation keeps capacity reserved but does not block message/session-state reconciliation.

- [ ] **Step 4: Run production tests and commit**

Run: `npm test -- tests/production-startup.test.ts tests/production-app.test.ts tests/events/relay.test.ts tests/assistant/session-dashboard-notifications.test.ts tests/integration/mcp-assistant.test.ts`

Expected: PASS.

```bash
git add src/production-app.ts src/events/relay.ts src/assistant/session-observations.ts src/config.ts tests/production-startup.test.ts tests/production-app.test.ts tests/events tests/assistant/session-dashboard-notifications.test.ts
git commit -m "feat: recover managed SSH endpoints"
```

## Task 12: Docker SSH fixture and live persistent-runtime acceptance

**Files:**
- Modify: `docker/ssh-worker/Dockerfile`
- Modify: `scripts/ssh-worker.ts`
- Modify: `scripts/ssh-worker-support.ts`
- Modify: `package.json`
- Modify: `tests/scripts/ssh-worker-contract.test.ts`
- Modify: `tests/scripts/ssh-worker-lifecycle.test.ts`
- Create: `tests/integration/ssh-endpoint.test.ts`
- Modify: `docs/development/ssh-worker-fixture.md`

- [ ] **Step 1: Write failing fixture contract tests**

Require `tmux` in the image, preserve the no-auth-in-image contract, and assert every backend command uses `tmux -L qiyan-bot -f /dev/null` without touching default tmux.

- [ ] **Step 2: Run fixture tests and verify RED**

Run: `npm test -- tests/scripts/ssh-worker-contract.test.ts tests/scripts/ssh-worker-lifecycle.test.ts`

Expected: FAIL because the image and check do not include persistent runtime behavior.

- [ ] **Step 3: Add tmux and deterministic SSH endpoint integration**

Install `tmux` and Node.js in the fixture image without adding credentials. Unit tests use fake SSH/tmux/WebSocket processes and remain fully offline. `tests/integration/ssh-endpoint.test.ts` calls `test.skip` unless `QIYAN_SSH_ENDPOINT_INTEGRATION=1`; when enabled it requires the already-started repository fixture and uses a fake Unix-socket App Server command inside the SSH container to deterministically prove tunnel loss and reconnection. It records the attested remote incarnation, closes only the local tunnel, reconnects, and asserts the same identity remains. Keep the fixture image's exact Codex build selection for reproducibility; document that it is independent of the production runtime gate accepting `MINIMUM_SUPPORTED_CODEX_VERSION` or newer.

Add `npm run ssh-worker:endpoint-check` to set the opt-in flag and run only the integration file after `npm run ssh-worker:up`. A missing/down fixture produces an actionable opt-in failure, while ordinary `npm run check` reports the test as intentionally skipped and never requires Docker or SSH.

- [ ] **Step 4: Run deterministic integration tests**

Run: `npm test -- tests/scripts/ssh-worker-contract.test.ts tests/scripts/ssh-worker-lifecycle.test.ts tests/integration/ssh-endpoint.test.ts`

Expected: contract/lifecycle tests PASS and the Docker integration test is intentionally skipped without OpenAI network access, Docker setup, or credentials.

- [ ] **Step 5: Run opt-in live acceptance**

Run:

```bash
npm run ssh-worker:up
npm run ssh-worker:check
npm run ssh-worker:endpoint-check
```

Then run the documented endpoint acceptance command that:

1. starts the real remote App Server under `tmux -L qiyan-bot -f /dev/null`;
2. initializes through the SSH Unix-socket tunnel;
3. creates a disposable remote thread and starts a bounded task;
4. terminates only the tunnel;
5. proves the same App Server process remains;
6. reconnects and reads the terminal thread; and
7. stops the disposable endpoint session without exposing auth or task bodies.

Expected: PASS on the already-authenticated development fixture. If OpenAI service availability blocks the model turn, report that separately only after all process/tunnel persistence assertions pass.

- [ ] **Step 6: Commit fixture support**

```bash
git add docker/ssh-worker scripts tests/scripts tests/integration/ssh-endpoint.test.ts docs/development/ssh-worker-fixture.md
git commit -m "test: exercise persistent SSH endpoints"
```

## Task 13: User documentation, package contents, and final verification

**Files:**
- Create: `docs/ssh-workers.md`
- Modify: `README.md`
- Modify: `docs/setup.md`
- Modify: `assets/assistant/AGENTS.md`
- Modify: `assets/endpoints.example.jsonc`
- Modify: `package.json`
- Modify: `tests/docs.test.ts`
- Modify: `tests/package-smoke.test.ts`

- [ ] **Step 1: Write failing documentation/package tests**

Assert documentation contains Linux/OpenSSH/Node.js/Codex-auth/tmux prerequisites, strict trust ownership, catalog example, built-in local default, `tmux -L qiyan-bot` inspection, `disconnect_endpoint`, `restart_endpoint`, explicit attachment flows, remote project roots, and recovery behavior. Assert `npm pack --dry-run --json` includes `assets/endpoints.example.jsonc`, fixed `assets/remote/qiyan-ssh-helper.mjs`, fixed `assets/remote/qiyan-app-server-launcher.sh`, and `docs/ssh-workers.md` but no SSH keys, auth, runtime sockets, `.tmp`, or endpoint catalog.

- [ ] **Step 2: Run docs/package tests and verify RED**

Run: `npm test -- tests/docs.test.ts tests/package-smoke.test.ts`

Expected: FAIL because the remote-worker documentation and package entries are absent.

- [ ] **Step 3: Write concise user documentation**

Document this setup flow exactly:

```json
{
  "version": 1,
  "endpoints": {
    "devbox": { "type": "ssh", "projects_root": "~/qiyan-projects" }
  }
}
```

Explain that the key is an OpenSSH alias, the backend never trusts a new key or installs/authenticates Codex, ordinary `tmux ls` does not show QiYan's server, and `tmux -L qiyan-bot -f /dev/null list-sessions` deliberately does without loading user tmux configuration.

State that QiYan requires Codex `0.142.5` or newer on local and SSH worker hosts. Newer Codex releases are accepted; the exact `0.142.5` Docker fixture and generated-protocol manifest are reproducibility records, not installation ceilings.

Include the current explicit file-tool shapes:

```text
send_to_session({nickname, content, attachment_ids, mode})
prepare_chat_attachment({owner, relative_path})
send_chat_attachment({file_handle, caption?})
```

- [ ] **Step 4: Run all verification**

Run:

```bash
npm test -- tests/docs.test.ts tests/package-smoke.test.ts
npm run check
npm run build
npm pack --dry-run --json
git diff --check
```

Expected: typecheck passes; all tests pass with only intentional skips; the distributable build and pack smoke pass; no whitespace errors.

- [ ] **Step 5: Persistent reviewer final pass**

Ask the same reviewer used for the plan review to inspect the complete branch against the approved spec, focusing on process persistence, generation fencing, endpoint isolation, native cwd safety, uncertain-operation recovery, command injection, attachment bounds, secret leakage, and packaging.

Fix findings yourself using failing tests first, rerun focused tests, and return to the same reviewer until it reports no important findings.

- [ ] **Step 6: Commit documentation and verification fixes**

```bash
git add README.md docs assets package.json package-lock.json tests/docs.test.ts tests/package-smoke.test.ts
git commit -m "docs: add SSH worker setup"
```

## Final acceptance checklist

- [ ] `local` is always available and is the default endpoint for omitted arguments.
- [ ] Unused SSH catalog entries start no processes.
- [ ] Referenced SSH endpoints reconnect at startup without blocking local or other endpoints.
- [ ] A dropped SSH tunnel does not stop the remote App Server or active turn.
- [ ] Reconnection uses the same remote process and reconciles each worker final once through the existing durable delivery cursor.
- [ ] Attested runtime incarnation is stable across tunnel reconnect and changes across restart/reboot even when deterministic tmux/socket names are reused.
- [ ] Runtime loss and stale cleanup require the attested App Server PID/process group to be empty; explicit shutdown terminates and verifies the whole group without orphaning Codex.
- [ ] Cold startup rebuilds capacity from authoritative active managed turns before accepting input, including recovered counts above the configured limit.
- [ ] Remote reboot/process loss starts a new App Server and resumes native threads.
- [ ] Every backend tmux command uses `tmux -L qiyan-bot -f /dev/null`; normal tmux and user tmux configuration remain untouched.
- [ ] Host trust, package installation, and authentication remain user-owned.
- [ ] Local and SSH workers accept Codex `0.142.5` or newer, reject older/unparseable versions, and do not treat the generated schema version as an exact runtime pin.
- [ ] Destination rebinding is rejected while sessions reference the endpoint.
- [ ] Every fresh SSH generation revalidates and pins host/user/port; failed first activation persists no binding.
- [ ] Remote and local workspace policy share the same safety algorithm.
- [ ] Only explicit `send_to_session` attachments upload and only explicit `prepare_chat_attachment` files download.
- [ ] Disconnect/restart refuse active or unprovable endpoints and recover durably.
- [ ] Disconnect/restart atomically drain endpoint work, reject racing starts/transfers, and cancel stale automatic reconnects.
- [ ] Remote commands carry hostile paths only as bounded encoded data, and project downloads read/fstat/hash one no-follow descriptor before generation-fenced promotion.
- [ ] No chat body, attachment content, bot token, SSH private key, or Codex credential is logged, committed, or packaged.
- [ ] `npm run check`, build, package smoke, deterministic SSH integration, and authenticated live acceptance pass.

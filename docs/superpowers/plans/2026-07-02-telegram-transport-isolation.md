# Telegram Transport Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Telegram long polling from delaying outgoing messages by giving `getUpdates` an independently managed HTTP dispatcher.

**Architecture:** A focused transport factory creates a polling `TelegramApi` backed by a dedicated Undici dispatcher and a delivery `TelegramApi` backed by the existing global fetch transport. The factory mirrors Node's opt-in environment-proxy policy and owns an idempotent polling-dispatcher close operation; `TelegramChatAdapter` awaits the entire poller loop before closing it.

**Tech Stack:** TypeScript, Node.js 24+, Undici 8.5, `node:test`, esbuild, Telegram Bot API

---

### Task 1: Add the isolated Telegram transport factory

**Files:**
- Create: `src/telegram/transport.ts`
- Create: `tests/telegram/transport.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write the failing transport tests**

Create `tests/telegram/transport.test.ts`:

```typescript
import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramTransports, envProxyEnabled } from "../../src/telegram/transport.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("delivery completes while long polling remains pending on its dedicated dispatcher", async () => {
  const pollStarted = deferred<void>();
  const releasePoll = deferred<void>();
  const dispatcher = { close: async () => undefined };
  const pollingDispatchers: unknown[] = [];
  let deliveryCalls = 0;
  const transports = createTelegramTransports("token", {
    createDispatcher: () => dispatcher,
    pollingFetch: async (_input, init) => {
      pollingDispatchers.push(init?.dispatcher);
      pollStarted.resolve();
      await releasePoll.promise;
      return new Response(JSON.stringify({ ok: true, result: [] }));
    },
    deliveryFetch: async () => {
      deliveryCalls += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
    },
  });

  const polling = transports.polling.getUpdates(0);
  await pollStarted.promise;
  assert.equal((await transports.delivery.sendMessage(1, "ready")).message_id, 7);
  assert.equal(deliveryCalls, 1);
  assert.deepEqual(pollingDispatchers, [dispatcher]);
  releasePoll.resolve();
  await polling;
});

test("polling dispatcher selection mirrors Node environment proxy policy", async () => {
  assert.equal(envProxyEnabled({}, []), false);
  assert.equal(envProxyEnabled({ NODE_USE_ENV_PROXY: "1" }, []), true);
  assert.equal(envProxyEnabled({ NODE_OPTIONS: "--use-env-proxy" }, []), true);
  assert.equal(envProxyEnabled({ NODE_USE_ENV_PROXY: "1", NODE_OPTIONS: "--no-use-env-proxy" }, []), false);
  assert.equal(envProxyEnabled({ NODE_OPTIONS: "--no-use-env-proxy" }, ["--use-env-proxy"]), true);

  const kinds: string[] = [];
  for (const env of [{}, { NODE_USE_ENV_PROXY: "1" }]) {
    const transports = createTelegramTransports("token", {
      env,
      execArgv: [],
      createDispatcher: (kind) => { kinds.push(kind); return { close: async () => undefined }; },
      pollingFetch: async () => new Response(JSON.stringify({ ok: true, result: [] })),
      deliveryFetch: async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
    });
    await transports.closePolling();
  }
  assert.deepEqual(kinds, ["direct", "env-proxy"]);
});

test("concurrent polling transport closes share one dispatcher close", async () => {
  const closeStarted = deferred<void>();
  const releaseClose = deferred<void>();
  let closes = 0;
  const transports = createTelegramTransports("token", {
    createDispatcher: () => ({ close: async () => { closes += 1; closeStarted.resolve(); await releaseClose.promise; } }),
    pollingFetch: async () => new Response(JSON.stringify({ ok: true, result: [] })),
    deliveryFetch: async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
  });

  const first = transports.closePolling();
  const second = transports.closePolling();
  await closeStarted.promise;
  assert.equal(closes, 1);
  releaseClose.resolve();
  await Promise.all([first, second, transports.closePolling()]);
  assert.equal(closes, 1);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- tests/telegram/transport.test.ts
```

Expected: FAIL because `src/telegram/transport.ts` does not exist.

- [ ] **Step 3: Add the bundled Undici build dependency**

Run:

```bash
npm install --save-dev --save-exact undici@8.5.0
```

Expected: `package.json` and `package-lock.json` list `undici` under `devDependencies`; the package still has no `dependencies` section.

- [ ] **Step 4: Implement the minimal transport factory**

Create `src/telegram/transport.ts`:

```typescript
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { ChatDeliveryAdapter } from "../chat/contracts.ts";
import { TelegramApi } from "./api.ts";

export type PollingDispatcherKind = "direct" | "env-proxy";

export interface PollingDispatcher {
  close(): Promise<void>;
}

type DispatcherFetch = (
  input: string | URL | Request,
  init?: RequestInit & { dispatcher?: unknown },
) => Promise<Response>;

export interface TelegramTransports {
  polling: Pick<TelegramApi, "getUpdates" | "downloadFile">;
  delivery: ChatDeliveryAdapter;
  closePolling(): Promise<void>;
}

interface TelegramTransportDependencies {
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  createDispatcher?: (kind: PollingDispatcherKind) => PollingDispatcher;
  pollingFetch?: DispatcherFetch;
  deliveryFetch?: typeof globalThis.fetch;
}

export function envProxyEnabled(env: NodeJS.ProcessEnv = process.env, execArgv: readonly string[] = process.execArgv): boolean {
  let enabled = env.NODE_USE_ENV_PROXY === "1";
  const nodeOptions = env.NODE_OPTIONS ?? "";
  for (const match of nodeOptions.matchAll(/(?:^|[\s'"])--(no-)?use-env-proxy(?=$|[\s'"])/gu)) enabled = match[1] === undefined;
  for (const argument of execArgv) {
    if (argument === "--use-env-proxy") enabled = true;
    else if (argument === "--no-use-env-proxy") enabled = false;
  }
  return enabled;
}

export function createTelegramTransports(token: string, dependencies: TelegramTransportDependencies = {}): TelegramTransports {
  const env = dependencies.env ?? process.env;
  const kind: PollingDispatcherKind = envProxyEnabled(env, dependencies.execArgv ?? process.execArgv) ? "env-proxy" : "direct";
  const dispatcher = dependencies.createDispatcher?.(kind) ?? createDispatcher(kind, env);
  const pollingFetch = dependencies.pollingFetch ?? (undiciFetch as unknown as DispatcherFetch);
  const deliveryFetch = dependencies.deliveryFetch ?? globalThis.fetch;
  const fetchWithDispatcher: typeof globalThis.fetch = (input, init) => pollingFetch(input, { ...init, dispatcher });
  let closePromise: Promise<void> | undefined;

  return {
    polling: new TelegramApi(token, { fetch: fetchWithDispatcher }),
    delivery: new TelegramApi(token, { fetch: deliveryFetch }),
    closePolling: () => closePromise ??= dispatcher.close(),
  };
}

function createDispatcher(kind: PollingDispatcherKind, env: NodeJS.ProcessEnv): PollingDispatcher {
  if (kind === "direct") return new Agent();
  const read = (lower: string, upper: string) => env[lower] ?? env[upper];
  const httpProxy = read("http_proxy", "HTTP_PROXY");
  const httpsProxy = read("https_proxy", "HTTPS_PROXY");
  const noProxy = read("no_proxy", "NO_PROXY");
  return new EnvHttpProxyAgent({
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(noProxy === undefined ? {} : { noProxy }),
  });
}
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```bash
npm test -- tests/telegram/transport.test.ts
npm run typecheck
```

Expected: all transport tests pass and TypeScript reports no errors. If Undici's concrete fetch input type requires a narrow adapter cast, keep that cast inside `createTelegramTransports`; do not weaken `TelegramApi` or public chat contracts.

- [ ] **Step 6: Commit the transport factory**

Run:

```bash
git add package.json package-lock.json src/telegram/transport.ts tests/telegram/transport.test.ts
git commit -m "fix: isolate Telegram polling transport"
```

### Task 2: Integrate transport lifecycle into the Telegram adapter

**Files:**
- Modify: `src/telegram/chat-adapter.ts`
- Create: `tests/telegram/chat-adapter.test.ts`

- [ ] **Step 1: Write the failing adapter shutdown test**

Create `tests/telegram/chat-adapter.test.ts`:

```typescript
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { AttachmentStore } from "../../src/attachments/store.ts";
import { OperationStore } from "../../src/storage/operation-store.ts";
import { createTestDatabase } from "../../src/storage/database.ts";
import { TelegramChatAdapter } from "../../src/telegram/chat-adapter.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("adapter waits for polling-owned work and closes its dispatcher exactly once", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "telegram-adapter-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const db = createTestDatabase();
  context.after(() => db.close());
  const attachments = new AttachmentStore(db, root, { maxFileBytes: 100, maxStoreBytes: 1_000 });
  await attachments.initialize();
  const downloadStarted = deferred<void>();
  const releaseDownload = deferred<void>();
  let closes = 0;
  const transports = {
    polling: {
      getUpdates: async () => [{
        update_id: 1,
        message: {
          message_id: 2,
          date: 1,
          chat: { id: 10, type: "private" as const },
          from: { id: 42 },
          document: { file_id: "file", file_name: "note.txt", mime_type: "text/plain" },
        },
      }],
      downloadFile: async () => {
        downloadStarted.resolve();
        await releaseDownload.promise;
        return { stream: Readable.from(["content"]), size: 7 };
      },
    },
    delivery: { sendMessage: async () => ({ message_id: 1 }) },
    closePolling: async () => { closes += 1; },
  };
  const adapter = new TelegramChatAdapter(db, new OperationStore(db), attachments, {
    token: "token",
    ownerId: 42,
    maxMessageBytes: 100,
    onAccepted: async () => undefined,
  }, { createTransports: () => transports });

  adapter.start();
  await downloadStarted.promise;
  const first = adapter.stop();
  const second = adapter.stop();
  await Promise.resolve();
  assert.equal(closes, 0);
  releaseDownload.resolve();
  await Promise.all([first, second, adapter.stop()]);
  assert.equal(closes, 1);
});
```

- [ ] **Step 2: Run the focused adapter test and verify RED**

Run:

```bash
npm test -- tests/telegram/chat-adapter.test.ts
```

Expected: FAIL because `TelegramChatAdapter` does not accept a transport factory and does not close a polling dispatcher.

- [ ] **Step 3: Integrate the transport factory and idempotent stop**

Update `src/telegram/chat-adapter.ts` so its composition and lifecycle are:

```typescript
import type { AttachmentStore } from "../attachments/store.ts";
import type { ChatAdapter, ChatDeliveryAdapter } from "../chat/contracts.ts";
import type { Database } from "../storage/database.ts";
import type { OperationStore } from "../storage/operation-store.ts";
import { TelegramPoller } from "./poller.ts";
import { createTelegramTransports, type TelegramTransports } from "./transport.ts";

interface TelegramChatAdapterDependencies {
  createTransports?: (token: string) => TelegramTransports;
}

export class TelegramChatAdapter implements ChatAdapter {
  readonly delivery: ChatDeliveryAdapter;
  private readonly poller: TelegramPoller;
  private readonly transports: TelegramTransports;
  private stopping: Promise<void> | undefined;

  constructor(
    db: Database,
    operations: OperationStore,
    attachments: AttachmentStore,
    options: { token: string; ownerId: number; maxMessageBytes: number; onAccepted(contextId: string): Promise<void> },
    dependencies: TelegramChatAdapterDependencies = {},
  ) {
    this.transports = (dependencies.createTransports ?? createTelegramTransports)(options.token);
    this.delivery = this.transports.delivery;
    this.poller = new TelegramPoller(db, this.transports.polling, operations, attachments, {
      ownerId: options.ownerId,
      maxMessageBytes: options.maxMessageBytes,
      onAccepted: options.onAccepted,
    });
  }

  start(): void { this.poller.start(); }

  stop(): Promise<void> {
    return this.stopping ??= (async () => {
      await this.poller.stop();
      await this.transports.closePolling();
    })();
  }
}
```

- [ ] **Step 4: Run adapter, transport, and existing Telegram tests**

Run:

```bash
npm test -- tests/telegram/chat-adapter.test.ts tests/telegram/transport.test.ts tests/telegram/api.test.ts tests/telegram/poller.test.ts tests/telegram/delivery-worker.test.ts
npm run typecheck
```

Expected: all focused tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit adapter integration**

Run:

```bash
git add src/telegram/chat-adapter.ts tests/telegram/chat-adapter.test.ts
git commit -m "fix: decouple Telegram polling from delivery"
```

### Task 3: Verify the distributable and the original live failure mode

**Files:**
- Verify: `tests/bin.test.ts`
- Verify: `scripts/build.mjs`
- Verify: `dist/codex-bot`

- [ ] **Step 1: Run the complete automated verification suite**

Run:

```bash
npm run check
```

Expected: typecheck passes; every test passes except explicitly opt-in integration tests. In particular, `tests/bin.test.ts` proves the packed installation still contains no installed runtime dependency tree.

- [ ] **Step 2: Build and inspect the distributable**

Run:

```bash
npm run build
test -x dist/codex-bot
node dist/codex-bot --definitely-invalid
```

Expected: build exits 0, `dist/codex-bot` is executable, and the invalid invocation exits 1 with exactly `codex-bot: CONFIGURATION_ERROR: unknown argument` on stderr.

- [ ] **Step 3: Run real app-server integration coverage**

Run:

```bash
RUN_CODEX_INTEGRATION=1 npm test -- tests/integration/app-server.test.ts tests/integration/mcp-coordinator.test.ts
```

Expected: all enabled app-server and coordinator MCP integration tests pass.

- [ ] **Step 4: Obtain two independent code reviews**

Give each reviewer the design, this plan, base SHA, head SHA, and measured live failure. Require them to inspect proxy selection, dispatcher isolation, abort/download shutdown, repeated stop behavior, secret handling, and packaged-binary independence. Fix every Critical or Important issue, rerun the relevant focused tests, and request re-review until both report no remaining Critical or Important findings.

- [ ] **Step 5: Merge, install, and run the live transport timing probe**

After review and fresh full verification, merge the feature branch to `main`, build the package, install it globally, and restart the bot from the existing `.env` and coordinator workdir. Use a temporary no-secret diagnostics preload to record only method names and elapsed milliseconds for `getUpdates` and one diagnostic `sendMessage`.

Expected while `getUpdates` remains pending:

- `sendMessage create` is followed promptly by `sendMessage bodySent`;
- `sendMessage` returns without waiting for `getUpdates` to finish;
- the diagnostic message arrives in the owner's Telegram chat;
- the final bot restart does not use the diagnostics preload.

- [ ] **Step 6: Confirm final repository and process state**

Run:

```bash
git status --short --branch
ps -eo pid,ppid,args | rg "codex-bot|codex app-server"
```

Expected: `main` is clean; exactly one bot process and its two expected app-server trees are running; no process includes the temporary diagnostic preload.

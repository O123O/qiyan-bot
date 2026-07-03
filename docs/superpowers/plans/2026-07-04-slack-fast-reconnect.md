# Slack Fast Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shorten Slack Socket Mode dead-connection recovery by restoring the Slack SDK's supported heartbeat defaults while retaining QiYan's bounded, shutdown-safe reconnect controller.

**Architecture:** `SlackChatAdapter` remains the sole owner of reconnect scheduling with SDK automatic reconnection disabled. The adapter stops overriding `clientPingTimeout` and `serverPingTimeout`, so `@slack/socket-mode` 2.0.7 detects dead connections with its 5-second/30-second defaults and emits `disconnected` into the existing generation-fenced retry path.

**Tech Stack:** TypeScript 6, Node.js 24 test runner, `@slack/socket-mode` 2.0.7, SQLite-backed durable ingress

---

### Task 1: Restore SDK heartbeat defaults

**Files:**
- Modify: `tests/slack/chat-adapter.test.ts:124-200`
- Modify: `src/slack/chat-adapter.ts:26-48`
- Modify: `src/slack/chat-adapter.ts:95-122`

- [ ] **Step 1: Write the failing factory-options assertion**

Change the `factoryOptions` type and exact expected value in `tests/slack/chat-adapter.test.ts` so heartbeat overrides are forbidden while automatic reconnect remains disabled:

```ts
let factoryOptions: {
  appToken: string;
  autoReconnectEnabled: boolean;
  clientOptions: {
    rejectRateLimitedCalls: boolean;
    retryConfig: { retries: number };
    timeout: number;
  };
} | undefined;

assert.deepEqual(factoryOptions, {
  appToken: "xapp-secret",
  autoReconnectEnabled: false,
  clientOptions: {
    rejectRateLimitedCalls: true,
    retryConfig: { retries: 0 },
    timeout: 10_000,
  },
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --import tsx --test --test-name-pattern="Slack initializes identities" tests/slack/chat-adapter.test.ts
```

Expected: FAIL because the actual factory options still contain `clientPingTimeout: 30_000` and `serverPingTimeout: 60_000`.

- [ ] **Step 3: Remove only the custom heartbeat options**

In `src/slack/chat-adapter.ts`, narrow the injected factory type and constructor options to:

```ts
createSocketModeClient?: (options: {
  appToken: string;
  autoReconnectEnabled: boolean;
  clientOptions: {
    rejectRateLimitedCalls: boolean;
    retryConfig: { retries: number };
    timeout: number;
  };
}) => SlackSocketModeClient;
```

Delete `SLACK_CLIENT_PING_TIMEOUT_MS` and `SLACK_SERVER_PING_TIMEOUT_MS`. Construct the client with:

```ts
this.socket = (dependencies.createSocketModeClient ?? ((value) => new SocketModeClient(value)))({
  appToken: options.config.appToken,
  autoReconnectEnabled: false,
  clientOptions: {
    rejectRateLimitedCalls: true,
    retryConfig: { retries: 0 },
    timeout: SLACK_CONNECTION_OPEN_TIMEOUT_MS,
  },
});
```

Do not change the disconnected listener, retry delays, reconnect generation, or shutdown behavior.

- [ ] **Step 4: Run focused Slack adapter tests and verify GREEN**

Run:

```bash
node --import tsx --test tests/slack/chat-adapter.test.ts
```

Expected: all Slack adapter tests pass, including reconnect failure and unresolved-reconnect shutdown coverage.

- [ ] **Step 5: Run the complete repository check**

Run:

```bash
npm run check
```

Expected: TypeScript succeeds and the complete test suite has zero failures.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/slack/chat-adapter.ts tests/slack/chat-adapter.test.ts
git commit -m "fix: shorten Slack socket recovery"
```

### Task 2: Review and deploy the clean package

**Files:**
- Verify: `src/slack/chat-adapter.ts`
- Verify: `tests/slack/chat-adapter.test.ts`
- Runtime state: `~/.qiyan-bot/data/bot.sqlite3`

- [ ] **Step 1: Request runtime and security reviews**

Ask the runtime reviewer to verify SDK option semantics and reconnect/shutdown races. Ask the security reviewer to verify bounded failure handling and absence of content or credential logging. Address any concrete findings through a new failing test before production changes.

- [ ] **Step 2: Re-run verification after review**

```bash
git diff --check
npm run check
```

Expected: no whitespace errors and zero test failures.

- [ ] **Step 3: Install and restart the local service**

```bash
systemctl --user stop qiyan-bot.service
pack_dir=$(mktemp -d)
archive=$(npm pack --silent --pack-destination "$pack_dir")
npm install --global --prefix "$HOME/.local" "$pack_dir/$archive"
rm -rf "$pack_dir"
systemctl --user start qiyan-bot.service
systemctl --user is-active qiyan-bot.service
```

Expected: the final command prints `active`.

- [ ] **Step 4: Verify a live Slack owner DM using metadata only**

After the user sends a short Slack DM, query only event IDs, states, and timestamps from `slack_inbox`, `source_contexts`, `assistant_attempts`, `assistant_attempt_sources`, and `deliveries`. Do not select message text, delivery bodies, attachment contents, tokens, or credentials. Report the measured event-to-admission, assistant, delivery, and end-to-end intervals, plus any heartbeat warnings in the service journal.

- [ ] **Step 5: Commit review-driven changes if any**

If review required a code correction, commit only its tested files with a focused `fix:` message. If review was clean, do not create an empty commit.

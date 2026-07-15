# Manual web-UI start/stop (live toggle)

## Goal

Let an operator start and stop the opt-in web UI on the **running** bot without restarting
the whole process (workers, endpoints, and in-flight turns keep running), and persist the
desired state so it survives a bot restart.

```
qiyan-bot web-ui start     # start listening now (and on future restarts)
qiyan-bot web-ui stop      # stop listening now (and stay stopped on future restarts)
qiyan-bot web-ui status    # configured? enabled? currently listening? URL
```

Non-goal: enabling the web UI when it is not configured at all. `WEB_UI=1` (+ host/port) in
`<qiyanHome>/.env` still gates whether the web-UI machinery (bus, token, adapter, phase) is
built. The toggle controls whether that machinery is **listening**. If the running bot was
started without `WEB_UI`, the toggle is a safe no-op on it (see safety invariant); the CLI
prints guidance to set `WEB_UI=1` and restart.

## Control mechanism & the one safety invariant

- **Trigger = SIGUSR2, not fs.watch or a socket.** `qiyanHome` is commonly on a shared NFS
  home where `inotify`/`fs.watch` is unreliable; a signal is delivered reliably. The state
  file carries the "what", so the signal only says "re-read and reconcile". SIGUSR1 is
  reserved by Node (inspector); SIGUSR2 has no default Node disposition other than terminate,
  which our installed handler overrides. (If the bot were launched with `--report-on-signal`/
  `--report-signal=SIGUSR2`, SIGUSR2 would also write a Node diagnostic report and still
  reconcile — harmless: the handler keeps the process alive and reconcile is idempotent. The
  production systemd `ExecStart` sets neither flag.)

- **THE SAFETY INVARIANT: the long-lived bot process installs a SIGUSR2 handler
  unconditionally and as early as possible in the run path — before any startup `await` and
  independent of `config.webUi`.** SIGUSR2's default disposition is *terminate*; this single
  invariant guarantees the signal can never fall through to that default on the bot, closing
  every divergence between "the CLI decided to signal" and "a handler is installed":
  - a signal during the (possibly slow, NFS-bound) startup, when systemd has already set
    `MainPID` (at fork/exec) but the app hasn't built its phases yet;
  - a signal right after a `Restart=on-failure` crash-restart;
  - `.env` edited to add `WEB_UI=1` **without** restarting — the running bot has no web-UI
    phase, but SIGUSR2 is still safe (no-op).

  The handler dispatches to a **reconcile callback** that the web-UI phase registers at
  `start()` and clears at `stop()`. When no callback is registered (web UI unconfigured, not
  yet started, or already stopped), the signal is a safe no-op. The CLI's `config.webUi`
  check is retained **only as UX** (guidance), never as a safety gate.

- **CLI targets only the main PID.** `systemctl --user kill` defaults to the whole cgroup,
  which would deliver SIGUSR2 to ssh ControlMasters and vendored codex/claude helpers (same
  cgroup, no handler → they die). So the CLI resolves the unit's `MainPID` and
  `process.kill(mainPid, "SIGUSR2")`. (A `systemctl kill --kill-whom=main` alternative is
  atomic re PID-reuse but the option was renamed in systemd 252, so it is version-fragile;
  `process.kill` is version-independent and the PID-reuse window is microseconds and, per the
  invariant above, non-fatal even if it landed on the bot.)

## Persistence

`<qiyanHome>/webui.json` = `{ "enabled": boolean }`.

- Written **atomically** (temp file in the same dir, mode `0600`, then `rename`) so the bot
  never reads a torn file.
- Read (`readWebUiEnabled(statePath)`):
  - **ENOENT → `true`** (preserves today's behavior: `WEB_UI=1` ⇒ listens on startup).
  - **parse / shape error (not a boolean `enabled`) → throw.** The reconciler treats a throw
    as "state unreadable → keep the current running state, log a warning" — it never
    fail-*opens* the security-sensitive surface on a corrupt file. (With atomic writes this is
    only reachable via external corruption.)
- `qiyanHome` is stable and known identically to the CLI (`loadConfigSource().qiyanHome`) and
  the bot (`config.qiyanHome`) — unlike `dataDir`.

## Bot side

### 1. Make the web server handle re-startable (`web-server.ts`)

`wss = new WebSocketServer({ noServer: true })` is created once at `createWebServer` scope
(`:149`) and `wss.close()`d in `stop()` (`:380`). Confirmed against `ws@8.21.0`: a closed
`WebSocketServer` rejects later `handleUpgrade` (`completeUpgrade` aborts when
`_state > RUNNING`), so the handle is not re-startable today. Change `wss` to
`let wss: WebSocketServer | undefined` **assigned at the top of `start()`** (before the
`upgrade` handler is registered) and `wss?.close(); wss = undefined` in `stop()`. `server`,
`poll`, `uploadSweep` are already (re)created in `start()`/cleared in `stop()`. Also reset
`lastSessions = ""` at the top of `start()` so a restart re-broadcasts the first poll. Net:
`start() → stop() → start()` on one handle re-listens cleanly. (A fresh `noServer` `wss` per
start leaks nothing — no attached http server; `clients` drains on close.)

### 2. Process-level signal handler (`src/webui/webui-signal.ts`, new)

A tiny module owning the process-global SIGUSR2 handler:

```
let handler: (() => void) | undefined;
let installed = false;
export function installWebUiSignalHandler(): void {   // idempotent; call once in the run path
  if (installed) return;
  installed = true;
  process.on("SIGUSR2", () => { handler?.(); });
}
export function setWebUiSignalHandler(fn: (() => void) | undefined): void { handler = fn; }
```

`installWebUiSignalHandler()` is called in `main()` for the **run** command as the first
statement after arg parse — before `loadConfigSource`/`bootstrapWeixin`/`createApp` — so the
handler exists from the earliest instant (the safety invariant). It is not installed for the
short-lived CLI commands. The web-UI phase owns `setWebUiSignalHandler`.

### 3. Reconcile controller (`createWebUiToggle`, exported from `webui/index.ts` for tests)

Single-flight chain + `running`/`disposed`, injectable `server`/`readEnabled` for tests:

```
createWebUiToggle({ server, readEnabled, onStarted, report }) {
  let running = false, disposed = false, chain = Promise.resolve();
  const run = (op) => { const next = chain.then(op, op); chain = next.catch(() => {}); return next; };
  const reconcile = () => run(async () => {
    if (disposed) return;                              // dispose() performs the final stop
    let want; try { want = readEnabled(); }
    catch (e) { report(warn, "web-ui state unreadable; keeping current"); return; }  // fail-safe
    if (want && !running) { const { url } = await server.start(); running = true; onStarted(url); }
    else if (!want && running) { await server.stop(); running = false; }
  });
  const dispose = () => { disposed = true; return run(async () => { if (running) { await server.stop(); running = false; } }); };
  return { reconcile, dispose, isRunning: () => running };
}
```

- `running` is set only **after** `server.start()` resolves, so a failed start leaves
  `running === false` and a later reconcile retries.
- The dispose race (SIGUSR2 start in-flight, then SIGTERM shutdown): `dispose()` sets
  `disposed` and **enqueues** its stop on the same chain, so it runs *after* any in-flight
  start completes — no orphaned listener, no shutdown hang.

### 4. Phase wiring (`createWebUiPhase`)

Add `statePath: string` to `WebUiPhaseDeps` (production-app passes
`join(config.qiyanHome, "webui.json")`). Build the toggle from the re-startable `server` +
`() => readWebUiEnabled(statePath)`. Phase:

- `start`: `await toggle.reconcile(); setWebUiSignalHandler(() => { void toggle.reconcile(); });`
  — reconcile **first** (applies persisted state), *then* register. If the initial
  `server.start()` fails, the error propagates to `composeApp` with **no callback registered**,
  so a stray SIGUSR2 during startup-failure teardown can't start an orphan listener. A SIGUSR2
  during the initial reconcile is a safe no-op (the reconcile already applies the state).
- `stop`: `setWebUiSignalHandler(undefined); await toggle.dispose();`

Handler registration is symmetric with the phase lifecycle (no construction-time global side
effect → no leak, clean tests). `config.webUi` unset ⇒ phase never built ⇒ callback never
registered ⇒ SIGUSR2 no-ops (matching the invariant). `setWebUiSignalHandler` is
last-writer-wins, i.e. at most one active web-UI phase per process (true in production); tests
must clear it between cases.

A corrupt `webui.json` at startup therefore leaves the web UI **off** (the initial reconcile
catches the throw and keeps the current not-running state) — the intentional fail-safe
direction for a danger-full-access surface; recover by deleting the file (ENOENT ⇒ on).

## CLI side

### `cli.ts`
- `CliCommand` += `{ command: "web-ui"; action: "start"|"stop"|"status"; qiyanHome?: string }`;
  `WebUiAction`; `CliHelpTopic += "web-ui"`.
- `parseCliArgs`: `argv[0] === "web-ui"` → `parseWebUiArgs(argv.slice(1))`. Mirror
  `parseServiceArgs` **except** accept `--home` for **all** actions (start/stop/status), not
  just one. `--help` → help topic. Add `formatCliHelp("web-ui")` and list it under root usage.

### `main.ts`
```
if (command.command === "web-ui") {
  const loaded = await loadConfigSource(env, home?);
  const weixin  = await bootstrapWeixin(loaded.qiyanHome);
  const config  = loadConfig(loaded.values, { qiyanHome: loaded.qiyanHome, weixinConfigured: weixin.configured });
  const statePath = join(loaded.qiyanHome, "webui.json");
  const pid = await readServiceMainPid(env);                     // undefined if not running / no systemd
  if (command.action === "status") { print configured?/enabled?(state file)/running?(pid)/URL; return; }
  if (!config.webUi) { print "Web UI is not configured; set WEB_UI=1 and restart."; return; }
  writeWebUiEnabled(statePath, command.action === "start");      // atomic
  const signalled = pid !== undefined && trySignal(pid);         // process.kill; false on ESRCH (PID died)
  print signalled ? "Web UI <started|stopped>." : "Saved; the bot is not running — it applies on next start.";
  return;
}
```

- `readServiceMainPid(env)` (new, `systemd-user.ts`): runs
  `systemctl --user show qiyan-bot.service -p MainPID --value` via the existing bounded
  runner; returns the parsed pid or **`undefined` on spawn failure / non-zero / empty / `0`**
  (must `catch` — the runner throws CONFIGURATION_ERROR on spawn failure).
- `status` reads the token best-effort from `join(config.dataDir, "web-token")` to render
  `http://host:port/?token=…`. (Reading `config.dataDir` is correct: the bot's runtime
  `dataDir` change is only realpath canonicalization, which `readFileSync` follows to the same
  inode.) If the token file is absent (bot never ran with `WEB_UI`), print host:port and point
  at `service logs`.

## Edge cases

- **Signal during startup / after crash-restart / `.env` edited without restart:** safe —
  the unconditional early handler no-ops until a phase registers a reconcile.
- **Bot not running:** state persisted atomically; no signal; applied on next start.
- **Web UI not configured:** no state write, no signal; guidance printed.
- **reconcile vs shutdown:** `dispose()` drains the chain (finding 2) — no orphan listener.
- **Corrupt state file:** reconcile keeps the current state (fail-safe, not fail-open).
- **Multi-instance shared NFS home:** the CLI signals the local host's `MainPID` only; each
  instance converges on its next reconcile/restart. Single-instance per host is the intended
  deployment (ConditionHost).
- **Foreground (non-systemd) bot:** `MainPID` is unavailable ⇒ the CLI persists state but
  cannot signal ⇒ no live effect until the next start. Documented limitation; the live toggle
  targets the systemd deployment.

## Files touched

- `src/webui/web-server.ts` — re-startable `wss` (+ `lastSessions` reset).
- `src/webui/webui-signal.ts` — **new**: install/set the process SIGUSR2 handler.
- `src/webui/webui-state.ts` — **new**: `readWebUiEnabled` (ENOENT→true, corrupt→throw) +
  `writeWebUiEnabled` (atomic).
- `src/webui/index.ts` — `createWebUiToggle` (exported), `statePath` dep, phase start/stop.
- `src/production-app.ts` — pass `statePath: join(config.qiyanHome, "webui.json")`.
- `src/service/systemd-user.ts` — `readServiceMainPid(env)` helper.
- `src/cli.ts` — `web-ui` command parse + help.
- `src/main.ts` — install the signal handler in the run path; `web-ui` handler.

## Tests

- `webui/webui-toggle.test.ts`: reconcile honors `readEnabled` (absent⇒start, `{enabled:false}`⇒no
  start, corrupt⇒throw⇒no change/keep state); single-flight under overlapping start-then-stop
  ends in the correct terminal state; **dispose race** (start in-flight during dispose ⇒ no
  listening server after) ; failed `server.start()` leaves `running===false` and a later
  reconcile retries.
- `webui/webui-state.test.ts`: atomic write round-trips; ENOENT⇒true; garbage⇒throw;
  non-boolean `enabled`⇒throw.
- `webui/webui-signal.test.ts`: handler installed idempotently; `process.emit("SIGUSR2")`
  invokes the registered callback; `undefined` after clear ⇒ no-op.
- `web-server.test.ts`: start→stop→start on one handle re-listens; a cycle-1 WS client is gone
  in cycle-2; the port is not leaked.
- `systemd-user.test.ts`: `readServiceMainPid` parses `--value`; `0`/empty/non-zero/spawn
  failure ⇒ `undefined` (never throws).
- `cli.test.ts`: parse `web-ui start|stop|status`, `--home` for **all** actions, `--help`, bad
  action/extra args.
- `main.test.ts` (if present): run command installs the SIGUSR2 handler before `app.start()`;
  `web-ui` handler does **not** signal when `config.webUi` unset or `pid` undefined.

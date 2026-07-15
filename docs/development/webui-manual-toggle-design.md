# Web UI control — command-driven (v2)

Supersedes the config-gated toggle. The web UI is controlled by the `web-ui` command + a saved
state file, not by an `.env` enable flag.

## Model

- **Config (`.env`):** keep `WEB_HOST` (default `127.0.0.1`) and `WEB_PORT` (default `9520`) as the
  **default** host/port. Remove `WEB_UI` and `WEB_ALLOW_LAN` entirely (the host expresses the bind;
  a separate allow-LAN gate is redundant, and an enable flag is redundant with the start command).
- **State (`<qiyanHome>/webui.json`):** `{ enabled: boolean, host?: string, port?: number }`. The
  single source of truth for whether the web UI listens and (optionally) an overridden host/port.
  - Absent ⇒ `{ enabled: false }` — the web UI is **off by default**; you turn it on with
    `web-ui start`.
  - `host`/`port` are present only when set via a command flag; absent ⇒ fall back to env.
  - Corrupt/wrong-shape ⇒ read throws ⇒ the reconciler keeps the current state (fail-safe).
- **Effective host/port precedence:** command flag → saved state → env (`WEB_HOST`/`WEB_PORT`) →
  built-in default (`127.0.0.1` / `9520`). "The command overrides the env," and the override
  persists (survives restart) because it is written to the state file.
- **Machinery is always built** (WebBus, token, web chat adapter, `web-ui` phase) with no config
  gate — that's what lets `web-ui start` take effect live with zero config. The phase reconciles
  against the state file; off by default means it simply doesn't listen until started.

## Commands

- `web-ui start [--host H] [--port P]` — enable; set host/port when a flag is given (else keep the
  saved value, else env). Persist atomically, then signal the running bot to reconcile live: if the
  host or port changed while running, the listener is stopped and re-created on the new host/port.
- `web-ui stop` — disable; persist; signal → listener stops. Host/port in state are preserved.
- `web-ui status` — configured host/port source, enabled?, running?, URL.
- `--home` is accepted for all three; `--host`/`--port` only for `start`.

## Bot side

Unchanged safety core from v1: the run process installs one idempotent SIGUSR2 handler **before any
startup await** (`installWebUiSignalHandler` in `main.ts`), independent of config, so a toggle
signal is never fatal; the CLI signals only the **main PID**, never the systemd cgroup. The web
server handle is restartable (fresh `wss` per `start()`).

`createWebUiToggle` (v2) — single-flight `run` chain + `disposed` flag as before, but now drives a
**server factory** instead of a fixed handle, and resolves the target each reconcile:

```
createWebUiToggle({ createServer, resolveTarget, onStarted, report })
  // resolveTarget(): { enabled, host, port }  — reads state, applies env/default fallback; may throw
  // createServer(host, port): WebServerHandle  — builds a fresh server bound to host:port
  let current;  // { handle, host, port } | undefined
  reconcile = run(async () => {
    if (disposed) return;
    let t; try { t = resolveTarget(); } catch (e) { report(warn); return; }  // corrupt ⇒ keep current
    if (!t.enabled) { if (current) { await current.handle.stop(); current = undefined; } return; }
    if (current && (current.host !== t.host || current.port !== t.port)) {
      await current.handle.stop(); current = undefined;               // host/port changed ⇒ rebind
    }
    if (!current) {
      const handle = createServer(t.host, t.port);
      const { url } = await handle.start(); current = { handle, host: t.host, port: t.port }; onStarted(url);
    }
  });
  dispose = () => { disposed = true; return run(async () => { if (current) { await current.handle.stop(); current = undefined; } }); };
```

`current` is set only after `start()` resolves (a failed start leaves it undefined → retry). The
dispose-drains-the-chain guarantee is unchanged, so no listener outlives shutdown even across a
rebind. Phase `start`: `await toggle.reconcile()` (apply persisted state) then register the SIGUSR2
callback; `stop`: clear the callback then `await toggle.dispose()`.

The security warning (non-loopback host over plain HTTP) stays — it fires in the server's `start()`
whenever the effective host isn't `127.0.0.1`.

## CLI resolution

`runWebUiCommand` reads the existing state and merges: `start` writes `{ ...existing, enabled: true,
host?: flag||existing, port?: flag||existing }` (a flag sets the override; omitted keeps the saved
value, and an unset saved value means the bot falls back to env at reconcile). `stop` writes
`{ ...existing, enabled: false }`. `status` resolves the effective host/port (state → env → default)
for display. The bot, not the CLI, is the authority for the env/default fallback at reconcile time;
the CLI only needs env for the `status` display and passes nothing host/port-specific through the
signal (the signal just says "re-read state and reconcile").

## Config wiring (always-built)

`config.webUi` becomes non-optional `{ host, port }` (from `WEB_HOST`/`WEB_PORT`; no `allowLan`).
In `production-app`, the `webBus`, token, web adapter, and `web-ui` phase drop their `config.webUi`
gates and are always constructed. `createWebUiPhase` takes `defaultHost`/`defaultPort` (from
`config.webUi`) + `statePath`, and builds `createServer(host, port)` over the stable deps.

## Migration (omniml-a5)

- `.env`: remove the `WEB_UI` and `WEB_ALLOW_LAN` lines (once `WEB_UI` is dropped from
  `SUPPORTED_DOTENV_KEYS`, a stray `WEB_UI=1` line would reject startup). Keep `WEB_HOST` (commented
  ⇒ `127.0.0.1`) and `WEB_PORT=8420`.
- `webui.json` already contains `{ "enabled": true }` (set during v1 live testing), so the web UI
  stays on after the deploy, on `127.0.0.1:8420` (state has no host/port ⇒ env fallback).
- Rebuild → pack → install → restart to apply.

## Files touched (delta from v1)

- `src/config.ts` — drop `WEB_UI`/`WEB_ALLOW_LAN`; `WEB_PORT` default `9520`; `webUi: { host, port }`
  non-optional.
- `src/config-source.ts` — `SUPPORTED_DOTENV_KEYS` drop `WEB_UI`, `WEB_ALLOW_LAN`.
- `src/webui/webui-state.ts` — `WebUiState { enabled, host?, port? }`; `readWebUiState` (ENOENT ⇒
  `{enabled:false}`), `writeWebUiState` (atomic).
- `src/webui/web-server.ts` — drop `allowLan`; `host` is `options.host` directly.
- `src/webui/index.ts` — `WebUiConfig` drop `allowLan`; `createWebUiToggle` v2 (factory + rebind);
  phase builds `createServer`, `resolveTarget`.
- `src/production-app.ts` — always build web machinery; pass `defaultHost/defaultPort` + `statePath`.
- `src/cli.ts` — `web-ui start` accepts `--host`/`--port`.
- `src/main.ts` — `runWebUiCommand` merges state; `WebUiCommandDeps` gains host/port + defaults.

## Tests (delta)

- `webui-state`: `{enabled,host,port}` round-trip; ENOENT ⇒ `{enabled:false}`; corrupt ⇒ throw.
- `webui-toggle`: rebind on host/port change stops the old and starts a new server (no orphan);
  dispose during a rebind drains; disabled ⇒ stop; corrupt ⇒ keep current; failed start ⇒ retry.
- `cli`: `web-ui start --host H --port P`, `--port` alone, bad/extra args.
- `config`: `webUi` always present, default `9520`; `WEB_UI`/`WEB_ALLOW_LAN` are now unknown keys.
- `main`: `runWebUiCommand` merges flags over saved state; status resolves env fallback.

// Process-global SIGUSR2 handler for the manual web-UI toggle (`qiyan-bot web-ui start|stop`).
//
// SAFETY INVARIANT: the long-lived bot installs this handler in the run path BEFORE any startup
// `await` (see main.ts) and independent of whether the web UI is configured, so a toggle signal
// can never fall through to SIGUSR2's default disposition (terminate the process) — not during
// the slow NFS startup, not after a crash-restart, not when `.env` was edited without a restart.
// The web-UI phase registers a reconcile callback while it is running; with none registered the
// signal is a safe no-op. `setWebUiSignalHandler` is last-writer-wins: at most one active web-UI
// phase per process (true in production).

let handler: (() => void) | undefined;
let listener: (() => void) | undefined;

export function installWebUiSignalHandler(): void {
  if (listener) return; // idempotent — never accumulate process listeners
  listener = () => { handler?.(); };
  process.on("SIGUSR2", listener);
}

export function setWebUiSignalHandler(fn: (() => void) | undefined): void {
  handler = fn;
}

// Test-only: detach the process listener and clear state so cases don't leak into each other.
export function resetWebUiSignalHandlerForTest(): void {
  if (listener) { process.off("SIGUSR2", listener); listener = undefined; }
  handler = undefined;
}

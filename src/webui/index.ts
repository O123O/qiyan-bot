import { randomUUID } from "node:crypto";
import type { AppPhase } from "../app.ts";
import type { CanonicalChatSource } from "../core/types.ts";
import type { ChatAcceptanceEffects } from "../storage/conversation-store.ts";
import type { OperationalEvent } from "../core/operational-log.ts";
import type { WebBus } from "./web-bus.ts";
import type { WebReadsDeps } from "./web-reads.ts";
import type { WebFilesDeps } from "./web-files.ts";
import type { WebUploadsConfig } from "./web-uploads.ts";
import type { RemoteDeps } from "./web-remote.ts";
import type { WebGoalControlInput, WebGoalControlResult } from "./web-goal-control.ts";
import { WEB_BINDING } from "./web-adapter.ts";
import { createWebServer } from "./web-server.ts";
import { readWebUiState } from "./webui-state.ts";
import { setWebUiSignalHandler } from "./webui-signal.ts";

export { WebBus } from "./web-bus.ts";
export { createWebAdapter, WEB_ADAPTER_ID } from "./web-adapter.ts";

const NICKNAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface WebUiPhaseDeps {
  defaultHost: string; // WEB_HOST — used when the saved state has no host override
  defaultPort: number; // WEB_PORT — used when the saved state has no port override
  token(): string;
  staticDir: string;
  bus: WebBus;
  reads: WebReadsDeps;
  files: WebFilesDeps;
  uploads?: WebUploadsConfig;
  remote?: () => RemoteDeps | undefined; // provider — the ssh runtime root is only known after startup
  acceptChat(source: CanonicalChatSource, effects: ChatAcceptanceEffects, presentation?: { ownerDisplayText?: string }): Promise<void>;
  controlGoal(input: WebGoalControlInput): Promise<WebGoalControlResult>;
  openGoalAdmission(): void;
  closeGoalAdmission(): void;
  waitForGoalControls(): Promise<void>;
  report(event: OperationalEvent): void;
  onStarted(url: string): void;
  statePath: string; // <qiyanHome>/webui.json — persisted control state for the `web-ui` command
}

// A restartable web server handle (the shape createWebServer returns); injectable for tests.
export interface WebServerHandle {
  start(): Promise<{ url: string }>;
  stop(): Promise<void>;
}

export interface WebUiTarget {
  enabled: boolean;
  host: string;
  port: number;
  token?: string;
}

export interface WebUiToggle {
  reconcile(): Promise<void>;
  dispose(): Promise<void>;
  isRunning(): boolean;
}

// Single-flight controller reconciling the web server against the persisted control state. Drives a
// server FACTORY (not a fixed handle) so a host/port change stops the old listener and starts a
// fresh one bound to the new address. dispose() enqueues its stop on the SAME chain, so it runs
// after any in-flight start()/rebind — no orphaned listener can outlive shutdown. A corrupt state
// file (resolveTarget throws) is treated as "keep the current state" (fail-safe), never fail-open.
export function createWebUiToggle(deps: {
  createServer(host: string, port: number, token: string): WebServerHandle;
  resolveTarget(): WebUiTarget;
  onStarted(url: string): void;
  report(event: OperationalEvent): void;
}): WebUiToggle {
  let current: { handle: WebServerHandle; host: string; port: number; token: string } | undefined;
  let disposed = false;
  // `chain = next.catch(() => {})` is BOTH the single-flight tail AND the rejection sink for a
  // signal-triggered `void reconcile()` whose promise is discarded — do NOT collapse to `chain = next`.
  let chain: Promise<void> = Promise.resolve();
  const run = (op: () => Promise<void>): Promise<void> => {
    const next = chain.then(op, op);
    chain = next.catch(() => {});
    return next;
  };
  const reconcile = (): Promise<void> => run(async () => {
    if (disposed) return; // dispose() performs the final stop
    let target: WebUiTarget;
    try { target = deps.resolveTarget(); }
    catch (error) {
      deps.report({ level: "warn", code: "background_task_failed", component: "web_ui", reason: `web-ui state unreadable; keeping current state (${error instanceof Error ? error.message : String(error)})` });
      return;
    }
    if (!target.enabled) { if (current) { await current.handle.stop(); current = undefined; } return; }
    if (!target.token) throw new Error("web UI token is unavailable");
    if (current && (current.host !== target.host || current.port !== target.port || current.token !== target.token)) {
      await current.handle.stop(); current = undefined; // rebind to the new host/port or token
    }
    if (!current) {
      const handle = deps.createServer(target.host, target.port, target.token);
      const { url } = await handle.start();
      current = { handle, host: target.host, port: target.port, token: target.token };
      deps.onStarted(url);
    }
  });
  const dispose = (): Promise<void> => {
    disposed = true;
    return run(async () => { if (current) { await current.handle.stop(); current = undefined; } });
  };
  return { reconcile, dispose, isRunning: () => current !== undefined };
}

// The web UI HTTP/WS server as an AppPhase. Input to a specific worker is expressed as the `/to`
// ingress directive (deterministic direct delivery + assistant awareness); input with no target
// is an ordinary message to the assistant. The machinery is always built; it listens only when the
// saved state says enabled (off by default), toggled live by `qiyan-bot web-ui start|stop`.
export function createWebUiPhase(deps: WebUiPhaseDeps): AppPhase {
  const submitInput = async (text: string, target: string | undefined, clientInputId?: string, echoInAssistant = false): Promise<{ ok: boolean; error?: string; clientUserMessageId?: string }> => {
    if (target !== undefined && !NICKNAME.test(target)) return { ok: false, error: "invalid worker nickname" };
    if (target !== undefined && (!clientInputId || !UUID.test(clientInputId))) return { ok: false, error: "valid clientInputId is required for worker input" };
    const rawText = target ? `/to ${target} ${text}` : text;
    const id = `web:${target ? clientInputId! : randomUUID()}`;
    try {
      await deps.acceptChat(
        { id, nativeSourceId: id, binding: WEB_BINDING, rawText, attachmentIds: [], receivedAt: Date.now() },
        {},
        echoInAssistant && target ? { ownerDisplayText: `→ @${target}  ${text}` } : undefined,
      );
      return { ok: true, ...(target ? { clientUserMessageId: `to:${id}` } : {}) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const createServer = (host: string, port: number, token: string): WebServerHandle => createWebServer({
    host, port, token, staticDir: deps.staticDir,
    bus: deps.bus, reads: deps.reads, files: deps.files, ...(deps.uploads ? { uploads: deps.uploads } : {}), ...(deps.remote ? { remote: deps.remote } : {}),
    submitInput, controlGoal: deps.controlGoal, openGoalAdmission: deps.openGoalAdmission,
    closeGoalAdmission: deps.closeGoalAdmission, waitForGoalControls: deps.waitForGoalControls, report: deps.report,
  });
  const resolveTarget = (): WebUiTarget => {
    const state = readWebUiState(deps.statePath);
    const target = { enabled: state.enabled, host: state.host ?? deps.defaultHost, port: state.port ?? deps.defaultPort };
    return state.enabled ? { ...target, token: deps.token() } : target;
  };

  const toggle = createWebUiToggle({ createServer, resolveTarget, onStarted: deps.onStarted, report: deps.report });

  return {
    name: "web-ui",
    // Reconcile FIRST (apply persisted state), THEN own SIGUSR2 — so if the initial start() fails
    // the error propagates with no callback registered and a stray signal can't orphan a listener.
    start: async () => {
      await toggle.reconcile();
      setWebUiSignalHandler(() => { void toggle.reconcile(); });
    },
    stop: async () => {
      setWebUiSignalHandler(undefined);
      await toggle.dispose();
    },
  };
}

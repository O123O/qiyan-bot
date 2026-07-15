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
import { WEB_BINDING } from "./web-adapter.ts";
import { createWebServer } from "./web-server.ts";
import { readWebUiEnabled } from "./webui-state.ts";
import { setWebUiSignalHandler } from "./webui-signal.ts";

export { WebBus } from "./web-bus.ts";
export { createWebAdapter, WEB_ADAPTER_ID } from "./web-adapter.ts";

const NICKNAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export interface WebUiConfig {
  host: string;
  port: number;
  allowLan: boolean;
  token: string;
  staticDir: string;
}

export interface WebUiPhaseDeps extends WebUiConfig {
  bus: WebBus;
  reads: WebReadsDeps;
  files: WebFilesDeps;
  uploads?: WebUploadsConfig;
  remote?: () => RemoteDeps | undefined; // provider — the ssh runtime root is only known after startup
  acceptChat(source: CanonicalChatSource, effects: ChatAcceptanceEffects): Promise<void>;
  report(event: OperationalEvent): void;
  onStarted(url: string): void;
  statePath: string; // <qiyanHome>/webui.json — persisted listening state for the manual toggle
}

// A restartable web server handle (the shape createWebServer returns); injectable for tests.
export interface WebServerHandle {
  start(): Promise<{ url: string }>;
  stop(): Promise<void>;
}

export interface WebUiToggle {
  reconcile(): Promise<void>;
  dispose(): Promise<void>;
  isRunning(): boolean;
}

// Single-flight controller reconciling the (restartable) web server against the persisted
// desired-enabled state. dispose() enqueues its stop on the SAME chain, so it runs after any
// in-flight start() — no orphaned listener can outlive shutdown. A corrupt state file is treated
// as "keep the current state" (fail-safe), never fail-open.
export function createWebUiToggle(deps: {
  server: WebServerHandle;
  readEnabled(): boolean;
  onStarted(url: string): void;
  report(event: OperationalEvent): void;
}): WebUiToggle {
  let running = false;
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
    let want: boolean;
    try { want = deps.readEnabled(); }
    catch (error) {
      deps.report({ level: "warn", code: "background_task_failed", component: "web_ui", reason: `web-ui state unreadable; keeping current state (${error instanceof Error ? error.message : String(error)})` });
      return;
    }
    if (want && !running) { const { url } = await deps.server.start(); running = true; deps.onStarted(url); }
    else if (!want && running) { await deps.server.stop(); running = false; }
  });
  const dispose = (): Promise<void> => {
    disposed = true;
    return run(async () => { if (running) { await deps.server.stop(); running = false; } });
  };
  return { reconcile, dispose, isRunning: () => running };
}

// The web UI HTTP/WS server as an AppPhase. Input to a specific worker is expressed as the `/to`
// ingress directive (deterministic direct delivery + assistant awareness); input with no target
// is an ordinary message to the assistant.
export function createWebUiPhase(deps: WebUiPhaseDeps): AppPhase {
  const submitInput = async (text: string, target: string | undefined): Promise<{ ok: boolean; error?: string }> => {
    if (target !== undefined && !NICKNAME.test(target)) return { ok: false, error: "invalid worker nickname" };
    const rawText = target ? `/to ${target} ${text}` : text;
    const id = `web:${randomUUID()}`;
    try {
      await deps.acceptChat({ id, nativeSourceId: id, binding: WEB_BINDING, rawText, attachmentIds: [], receivedAt: Date.now() }, {});
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const server = createWebServer({
    host: deps.host, port: deps.port, allowLan: deps.allowLan, token: deps.token, staticDir: deps.staticDir,
    bus: deps.bus, reads: deps.reads, files: deps.files, ...(deps.uploads ? { uploads: deps.uploads } : {}), ...(deps.remote ? { remote: deps.remote } : {}), submitInput, report: deps.report,
  });

  const toggle = createWebUiToggle({
    server,
    readEnabled: () => readWebUiEnabled(deps.statePath),
    onStarted: deps.onStarted,
    report: deps.report,
  });

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

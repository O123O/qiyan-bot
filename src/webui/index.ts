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
  remote?: RemoteDeps;
  acceptChat(source: CanonicalChatSource, effects: ChatAcceptanceEffects): Promise<void>;
  report(event: OperationalEvent): void;
  onStarted(url: string): void;
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

  return {
    name: "web-ui",
    start: async () => { const { url } = await server.start(); deps.onStarted(url); },
    stop: async () => { await server.stop(); },
  };
}

import type { BotConfig } from "./config.ts";
import { StartupPhaseError } from "./core/errors.ts";
import type { WeixinCredentialHandle } from "./weixin/credential-store.ts";
import type { OperationalEventSink } from "./core/operational-log.ts";

export { StartupPhaseError } from "./core/errors.ts";

export interface BotApp { start(): Promise<void>; stop(): Promise<void> }
export interface AppPhase { name: string; start(): Promise<void>; stop(): Promise<void> }
export interface AppRuntimeOptions {
  phases?: readonly AppPhase[];
  weixinCredential?: WeixinCredentialHandle;
  onOperationalEvent?: OperationalEventSink;
  requestRestart?: () => void;
}

export class TerminalInbox<T> {
  private readonly values = new Map<string, T>();
  constructor(private readonly maxEntries = 100) {}
  publish(turnId: string, value: T): void {
    this.values.set(turnId, value);
    if (this.values.size > this.maxEntries) this.values.delete(this.values.keys().next().value!);
  }
  take(turnId: string): T | undefined {
    const value = this.values.get(turnId);
    this.values.delete(turnId);
    return value;
  }
}

export function composeApp(phases: readonly AppPhase[]): BotApp {
  const started: AppPhase[] = [];
  let state: "stopped" | "starting" | "running" | "stopping" = "stopped";
  let transition: Promise<void> | undefined;

  const app: BotApp = {
    async start() {
      if (state === "running") return;
      if (state === "starting") return transition;
      if (state === "stopping") await transition;
      state = "starting";
      transition = (async () => {
        let startingPhase: string | undefined;
        try {
          for (const phase of phases) {
            startingPhase = phase.name;
            await phase.start();
            started.push(phase);
          }
          startingPhase = undefined;
          state = "running";
        } catch (error) {
          for (const phase of started.splice(0).reverse()) await phase.stop().catch(() => undefined);
          state = "stopped";
          throw error instanceof StartupPhaseError ? error : new StartupPhaseError(startingPhase ?? "unknown", error);
        }
      })();
      return transition;
    },
    async stop() {
      if ((state as string) === "stopped") return;
      if (state === "stopping") return transition;
      if (state === "starting") await transition?.catch(() => undefined);
      if (state === "stopped") return;
      state = "stopping";
      transition = (async () => {
        let firstError: unknown;
        for (const phase of started.splice(0).reverse()) {
          try { await phase.stop(); } catch (error) { firstError ??= error; }
        }
        state = "stopped";
        if (firstError) throw firstError;
      })();
      return transition;
    },
  };
  return app;
}

/**
 * Production composition is supplied by `buildProductionPhases` in this module's
 * second half. Keeping the lifecycle primitive injectable makes startup ordering
 * and failure cleanup deterministic in tests.
 */
export async function createApp(config: BotConfig, options: AppRuntimeOptions = {}): Promise<BotApp> {
  if (options.phases) return composeApp(options.phases);
  const { buildProductionApp } = await import("./production-app.ts");
  return buildProductionApp(config, {
    ...(options.weixinCredential ? { weixinCredential: options.weixinCredential } : {}),
    ...(options.onOperationalEvent ? { onOperationalEvent: options.onOperationalEvent } : {}),
    ...(options.requestRestart ? { requestRestart: options.requestRestart } : {}),
  });
}

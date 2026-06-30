import type { BotConfig } from "./config.ts";

export interface BotApp { start(): Promise<void>; stop(): Promise<void> }
export interface AppPhase { name: string; start(): Promise<void>; stop(): Promise<void> }

interface TimerApi {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: any): void;
}

export function composeApp(
  phases: readonly AppPhase[],
  options: { maintenance?: { intervalMs: number; run(): Promise<void> }; timers?: TimerApi } = {},
): BotApp {
  const started: AppPhase[] = [];
  const timers: TimerApi = options.timers ?? {
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: (handle) => clearInterval(handle),
  };
  let maintenanceTimer: unknown;
  let hasMaintenanceTimer = false;
  let state: "stopped" | "starting" | "running" | "stopping" = "stopped";
  let transition: Promise<void> | undefined;

  const app: BotApp = {
    async start() {
      if (state === "running") return;
      if (state === "starting") return transition;
      if (state === "stopping") await transition;
      state = "starting";
      transition = (async () => {
        try {
          for (const phase of phases) {
            await phase.start();
            started.push(phase);
          }
          if (options.maintenance) {
            maintenanceTimer = timers.setInterval(() => void options.maintenance!.run().catch(() => undefined), options.maintenance.intervalMs);
            hasMaintenanceTimer = true;
          }
          state = "running";
        } catch (error) {
          for (const phase of started.splice(0).reverse()) await phase.stop().catch(() => undefined);
          state = "stopped";
          throw error;
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
        if (hasMaintenanceTimer) { timers.clearInterval(maintenanceTimer); maintenanceTimer = undefined; hasMaintenanceTimer = false; }
        for (const phase of started.splice(0).reverse()) await phase.stop().catch(() => undefined);
        state = "stopped";
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
export async function createApp(config: BotConfig, phases?: readonly AppPhase[]): Promise<BotApp> {
  if (phases) return composeApp(phases);
  const { buildProductionApp } = await import("./production-app.ts");
  return buildProductionApp(config);
}

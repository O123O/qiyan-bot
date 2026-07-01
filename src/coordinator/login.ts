import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { CoordinatorLoginConfig } from "../config.ts";
import { AppError } from "../core/errors.ts";
import { buildCoordinatorChildEnvironment, prepareCoordinatorProfile } from "./profile.ts";

type LoginSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export async function runCoordinatorLogin(
  config: CoordinatorLoginConfig,
  host: NodeJS.ProcessEnv = process.env,
  spawn: LoginSpawn = nodeSpawn,
): Promise<void> {
  const profile = await prepareCoordinatorProfile(config.dataDir);
  const child = spawn(config.codexBinary, ["login", "--device-auth"], {
    env: buildCoordinatorChildEnvironment(host, profile),
    stdio: "inherit",
  });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (outcome.code !== 0) {
    throw new AppError("CONFIGURATION_ERROR", outcome.signal
      ? `coordinator login exited from signal ${outcome.signal}`
      : `coordinator login exited with status ${String(outcome.code)}`);
  }
}

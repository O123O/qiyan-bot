import { createApp } from "./app.ts";
import { parseCliArgs } from "./cli.ts";
import { loadConfig } from "./config.ts";

export async function main(env = process.env, argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const app = await createApp(loadConfig(env, parseCliArgs(argv)));
  await app.start();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void app.stop().catch(() => { process.exitCode = 1; });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

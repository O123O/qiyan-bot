import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

export async function main(env = process.env): Promise<void> {
  const app = await createApp(loadConfig(env));
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

if (import.meta.url === `file://${process.argv[1]}`) void main();

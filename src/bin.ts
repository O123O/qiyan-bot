import { formatStartupError } from "./cli.ts";
import { main } from "./main.ts";

void main().catch((error) => {
  process.stderr.write(`codex-bot: ${formatStartupError(error)}\n`);
  process.exitCode = 1;
});

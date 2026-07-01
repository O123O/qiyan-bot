import { chmod, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const outfile = resolve(dist, "codex-bot");

await rm(dist, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ["src/bin.ts"],
  outfile,
  bundle: true,
  packages: "bundle",
  platform: "node",
  format: "esm",
  target: "node24",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __codexBotCreateRequire } from \"node:module\";\nconst require = __codexBotCreateRequire(import.meta.url);" },
  legalComments: "eof",
  logLevel: "info",
});
await chmod(outfile, 0o755);

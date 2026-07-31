import { chmod, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const outfile = resolve(dist, "qiyan-bot");

await rm(dist, { recursive: true, force: true });
await build({
  absWorkingDir: root,
  entryPoints: ["src/bin.ts"],
  outfile,
  bundle: true,
  packages: "bundle",
  // The Claude Agent SDK is a deployment prerequisite, not a bundled dependency: it
  // resolves a ~264 MB platform-specific native Claude binary from its own package
  // directory, which no bundler can inline. Marking it external keeps dist/qiyan-bot
  // small and lets the host import the SDK installed on the worker's own machine.
  // src/claude-host/requirements.ts fails closed with an actionable message when it
  // is missing, so this never degrades into an opaque module-resolution error.
  external: ["@anthropic-ai/claude-agent-sdk"],
  platform: "node",
  format: "esm",
  target: "node24",
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __qiyanBotCreateRequire } from \"node:module\";\nconst require = __qiyanBotCreateRequire(import.meta.url);" },
  legalComments: "eof",
  logLevel: "info",
});
await chmod(outfile, 0o755);

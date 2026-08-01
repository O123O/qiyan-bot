import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const outfile = resolve(dist, "qiyan-bot");
// The remote Claude host is a SECOND program, not part of dist/qiyan-bot: it runs on the
// worker's machine, installed there by the ssh helper. It therefore builds into
// assets/remote/ and is committed, because src/endpoints/ssh-runtime.ts pins every remote
// asset by sha256 — a rebuilt-but-uncommitted host would fail that check at activation.
const claudeHostOutfile = resolve(root, "assets/remote/qiyan-claude-host.mjs");

// `--claude-host <path>` builds only that asset, so the drift test can reproduce it without
// racing the main bundle (this script deletes dist/ wholesale).
const claudeHostOnly = process.argv[2] === "--claude-host";

async function buildClaudeHost(target) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["src/claude-host/bin.ts"],
    outfile: target,
    bundle: true,
    packages: "bundle",
    // Same prerequisite rule as the main bundle: the SDK is imported at runtime from the
    // absolute path the helper resolved on the worker's machine, never inlined.
    external: ["@anthropic-ai/claude-agent-sdk"],
    platform: "node",
    format: "esm",
    target: "node24",
    banner: { js: "#!/usr/bin/env node" },
    legalComments: "eof",
    logLevel: "info",
    write: false,
  });
  const built = Buffer.from(result.outputFiles[0].contents);
  // The committed asset is a tracked source file other processes read while a build runs
  // (the packaging test packs the repo, which re-runs this script). Leave it untouched when
  // the bytes are unchanged, and replace it atomically otherwise, so a concurrent reader
  // never sees a half-written asset and fails its digest check.
  if (built.equals(await readFile(target).catch(() => Buffer.alloc(0)))) return;
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, built);
  // Left non-executable like the other remote assets: the launcher runs it as `node <path>`,
  // and bootstrap installs it mode 0700 on the worker's machine regardless.
  await chmod(temporary, 0o644);
  await rename(temporary, target);
}

if (claudeHostOnly) {
  await buildClaudeHost(resolve(root, process.argv[3] ?? claudeHostOutfile));
} else {
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
  await buildClaudeHost(claudeHostOutfile);
}

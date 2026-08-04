import { createHash } from "node:crypto";
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

// The pins src/endpoints/ssh-runtime.ts holds for the remote assets, rewritten from the assets
// themselves. They used to be maintained by hand, which meant every change to an asset — and
// every VERSION BUMP, because the Claude host embeds APP_VERSION — needed a sha pasted in by a
// person who had to remember to. Forgetting was not a small failure: requireDigest verifies the
// whole bundle at once, so one stale pin fails prepareRemoteHost for EVERY SSH endpoint, Codex
// included, with "packaged SSH runtime assets are unavailable". v1.0.0 shipped exactly that.
async function syncRemoteAssetDigests() {
  const pinned = [
    ["REMOTE_HELPER_SHA256", "assets/remote/qiyan-ssh-helper.mjs"],
    ["REMOTE_LAUNCHER_SHA256", "assets/remote/qiyan-app-server-launcher.sh"],
    ["REMOTE_CLAUDE_HOST_SHA256", "assets/remote/qiyan-claude-host.mjs"],
    ["REMOTE_CLAUDE_HOST_LAUNCHER_SHA256", "assets/remote/qiyan-claude-host-launcher.sh"],
  ];
  const source = resolve(root, "src/endpoints/ssh-runtime.ts");
  const before = await readFile(source, "utf8");
  let after = before;
  for (const [name, assetPath] of pinned) {
    const digest = createHash("sha256").update(await readFile(resolve(root, assetPath))).digest("hex");
    const pattern = new RegExp(`(export const ${name} = ")[a-f0-9]*(";)`, "u");
    if (!pattern.test(after)) throw new Error(`no pin declaration found for ${name}`);
    after = after.replace(pattern, `$1${digest}$2`);
  }
  if (after === before) return;
  await writeFile(source, after);
  console.log("build: refreshed remote asset digests in src/endpoints/ssh-runtime.ts");
}

if (claudeHostOnly) {
  await buildClaudeHost(resolve(root, process.argv[3] ?? claudeHostOutfile));
} else {
  // Assets first, then their pins, then the bundle — so dist/qiyan-bot is compiled against
  // digests that already describe the assets shipped beside it.
  await buildClaudeHost(claudeHostOutfile);
  await syncRemoteAssetDigests();
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
}

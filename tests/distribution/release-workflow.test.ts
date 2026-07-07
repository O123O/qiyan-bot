import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("release workflow validates, checks, packs, and uploads only a versioned runtime package", async () => {
  const workflow = await readFile(resolve(".github/workflows/release.yml"), "utf8");
  const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as { files: string[] };

  for (const required of [
    "tags:", "- \"v*\"", "contents: write", "actions/checkout@v6", "actions/setup-node@v6", "node-version: 24",
    "npm ci", "GITHUB_REF_NAME", "package.json", "package-lock.json", "npm run check", "npm pack --silent", "qiyan-bot.tgz",
    "expected-package-files.txt", "diff -u", "tar -xzf", "retired_role", "retired_product", "retired_compact", "retired_spaced",
    "package/assets/brand/qiyan-logo.png", "package/assets/brand/qiyan-overview.svg", "package/assets/slack/manifest.yaml",
    "package/docs/chat-apps/wechat.md", "env -i", "./dist/qiyan-bot --version", "config-check --home",
    "gh release create", "gh release upload", "--clobber", "GH_TOKEN: ${{ github.token }}",
    "asset_digest", "sha256:", "gh api",
  ]) {
    assert.equal(workflow.includes(required), true, `missing release contract: ${required}`);
  }
  assert.doesNotMatch(workflow, /npm publish/u);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/u);
  const allowlist = workflow.match(/cat > expected-package-files\.txt <<'EOF'\n([\s\S]*?)\n\s*EOF/u)?.[1]
    ?.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(allowlist, [
    "package/README.md",
    ...manifest.files.map((path) => `package/${path}`),
    "package/package.json",
  ].sort());
  const retiredBuildName = ["codex", "Bot"].join("");
  assert.doesNotMatch(await readFile(resolve("scripts/build.mjs"), "utf8"), new RegExp(retiredBuildName, "u"));
});

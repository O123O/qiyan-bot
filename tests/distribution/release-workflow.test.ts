import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("release workflow validates, checks, packs, and uploads only a versioned runtime package", async () => {
  const workflow = await readFile(resolve(".github/workflows/release.yml"), "utf8");

  for (const required of [
    "tags:", "- \"v*\"", "contents: write", "actions/checkout@v6", "actions/setup-node@v6", "node-version: 24",
    "npm ci", "GITHUB_REF_NAME", "package.json", "package-lock.json", "npm run check", "npm pack --silent", "codex-bot.tgz",
    "gh release create", "gh release upload", "--clobber", "GH_TOKEN: ${{ github.token }}",
  ]) {
    assert.equal(workflow.includes(required), true, `missing release contract: ${required}`);
  }
  assert.doesNotMatch(workflow, /npm publish/u);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN/u);
});

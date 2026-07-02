import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("README links to all focused guides and every local guide target exists", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  const links = [...readme.matchAll(/\]\((docs\/[^)#]+)(?:#[^)]+)?\)/gu)].map((match) => match[1]!);
  for (const expected of [
    "docs/installation.md",
    "docs/setup.md",
    "docs/chat-apps/telegram.md",
    "docs/chat-apps/slack.md",
    "docs/chat-apps/wechat.md",
  ]) {
    assert.equal(links.includes(expected), true, `README does not link ${expected}`);
  }
  await Promise.all(links.map((link) => access(resolve(link))));
});

test("installation guide covers Release install, no-Git source build, version, and update", async () => {
  const guide = await readFile(resolve("docs/installation.md"), "utf8");
  for (const required of [
    "releases/latest/download/codex-bot.tgz", "$HOME/.local", "main.tar.gz", "npm ci", "npm pack",
    "codex-bot --version", "codex-bot --update", "Release must exist", "does not restart",
  ]) {
    assert.equal(guide.includes(required), true, `installation guide is missing: ${required}`);
  }
  assert.match(guide, /without Git/iu);
});

test("Telegram guide is actionable for the implemented private single-user adapter", async () => {
  const guide = await readFile(resolve("docs/chat-apps/telegram.md"), "utf8");
  for (const required of [
    "Status: Implemented", "@BotFather", "numeric Telegram user ID", "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_OWNER_ID", "TELEGRAM_DESTINATION_CHAT_ID", "coordinator-login", "codex-bot --workdir",
    "private chat", "Smoke test", "attachment",
  ]) {
    assert.equal(guide.includes(required), true, `Telegram guide is missing: ${required}`);
  }
  assert.match(guide, /TELEGRAM_DESTINATION_CHAT_ID[^\n]+TELEGRAM_OWNER_ID/iu);
});

test("Slack and WeChat pages are explicit roadmap stubs rather than fake setup guides", async () => {
  for (const path of ["docs/chat-apps/slack.md", "docs/chat-apps/wechat.md"]) {
    const guide = await readFile(resolve(path), "utf8");
    assert.match(guide, /Status: Planned/u);
    assert.match(guide, /not implemented/iu);
    assert.doesNotMatch(guide, /export\s+\w*(?:TOKEN|SECRET|KEY)=/u);
    assert.doesNotMatch(guide, /npm install/iu);
  }
});

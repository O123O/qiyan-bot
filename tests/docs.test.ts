import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("README links to all focused guides and every local guide target exists", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  assert.ok(readme.indexOf("general-purpose personal assistant") < readme.indexOf("Telegram"));
  assert.match(readme, /handle small filesystem tasks directly/iu);
  assert.match(readme, /ordinary, resumable Codex sessions/iu);
  assert.match(readme, /Telegram is the first chat adapter/iu);
  assert.match(readme, /fresh QiYan state format|fresh.*state format.*rejected without migration/isu);
  const firstInstall = readme.indexOf("npm install --global");
  assert.ok(firstInstall > 0);
  const beforeInstall = readme.slice(0, firstInstall);
  assert.match(beforeInstall, /digest/iu);
  assert.match(beforeInstall, /test -n "\$digest"/u);
  const links = [...readme.matchAll(/\]\((docs\/[^)#]+)(?:#[^)]+)?\)/gu)].map((match) => match[1]!);
  for (const expected of [
    "docs/installation.md",
    "docs/upgrading-to-v0.3.md",
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
    "releases/latest/download/qiyan-bot.tgz", "$HOME/.local", "main.tar.gz", "npm ci", "npm pack",
    "qiyan-bot --version", "qiyan-bot --update", "Release must exist", "does not restart",
  ]) {
    assert.equal(guide.includes(required), true, `installation guide is missing: ${required}`);
  }
  assert.match(guide, /without Git/iu);
  assert.match(guide, /GitHub Release assets.*no supported npm-registry package/isu);
  assert.match(guide, /nonempty GitHub `sha256:` asset digest/iu);
  assert.match(guide, /test -n "\$digest"/u);
  assert.match(guide, /older than v0\.3\.0.*do \*\*not\*\* use the generic updater/isu);
});

test("v0.3 upgrade guide requires a fresh stopped cutover and a non-inheriting service", async () => {
  const guide = await readFile(resolve("docs/upgrading-to-v0.3.md"), "utf8");
  for (const required of [
    "destructive", "disable --now", "auth.json", "rm -rf", "config-check", "WorkingDirectory=",
    "ExecStart=", "--home", "UnsetEnvironment=", "EnvironmentFile=", "assistant-login", "round trip",
  ]) {
    assert.equal(guide.includes(required), true, `v0.3 cutover guide is missing: ${required}`);
  }
  assert.match(guide, /only values carried forward.*configuration.*auth\.json/isu);
  assert.match(guide, /Do not add `EnvironmentFile=`/u);
  assert.match(guide, /old managed sessions.*not adopted automatically/isu);
});

test("full-access and non-interactive worker warnings precede installation and launch", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  const install = await readFile(resolve("docs/installation.md"), "utf8");
  const setup = await readFile(resolve("docs/setup.md"), "utf8");
  const telegram = await readFile(resolve("docs/chat-apps/telegram.md"), "utf8");
  for (const [name, document, marker] of [
    ["README install", readme, "npm install --global"],
    ["installation", install, "npm install --global"],
    ["README launch", readme, "\nqiyan-bot\n"],
    ["setup launch", setup, "\nqiyan-bot\n"],
    ["Telegram launch", telegram, "\nqiyan-bot\n"],
  ] as const) {
    const boundary = document.indexOf(marker);
    assert.ok(boundary >= 0, `${name} marker missing`);
    const before = document.slice(0, boundary);
    assert.match(before, /danger-full-access|full filesystem access/iu, `${name} lacks the assistant warning before the command`);
    assert.match(before, /chat approvals? (?:are|is) (?:unsupported|unavailable)|no approval UI/iu, `${name} lacks the worker warning before the command`);
  }
});

test("Telegram guide is actionable for the implemented private single-user adapter", async () => {
  const guide = await readFile(resolve("docs/chat-apps/telegram.md"), "utf8");
  for (const required of [
    "Status: Implemented", "@BotFather", "numeric Telegram user ID", "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_OWNER_ID", "TELEGRAM_DESTINATION_CHAT_ID", "assistant-login", "qiyan-bot",
    "private chat", "Smoke test", "attachment",
  ]) {
    assert.equal(guide.includes(required), true, `Telegram guide is missing: ${required}`);
  }
  assert.match(guide, /TELEGRAM_DESTINATION_CHAT_ID[^\n]+TELEGRAM_OWNER_ID/iu);
  assert.match(guide, /~\/\.qiyan-bot\/\.env/u);
  assert.match(guide, /chmod 600[^\n]*\.env/iu);
  assert.doesNotMatch(guide, /EnvironmentFile=/u);
});

test("primary guides document QiYan home precedence, private dotenv setup, and message prefixes", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  const setup = await readFile(resolve("docs/setup.md"), "utf8");
  const telegram = await readFile(resolve("docs/chat-apps/telegram.md"), "utf8");
  const combined = `${readme}\n${setup}`;
  for (const required of ["--home", "QIYAN_HOME", "qiyan-workdir", "qiyan-projects", "config-check"]) {
    assert.equal(combined.includes(required), true, `primary guides are missing: ${required}`);
  }
  assert.match(combined, /CLI.*process environment.*\.env.*default/isu);
  assert.match(combined, /QiYan.*repl(?:y|ies).*no prefix/isu);
  assert.match(combined, /worker.*\[nickname\]/isu);
  assert.match(combined, /full.*access.*same OS user.*\.env/isu);
  assert.match(setup, /do not use.*EnvironmentFile/iu);
  assert.match(telegram, /cat > "?\$HOME\/\.qiyan-bot\/\.env"?/u);
  assert.doesNotMatch(telegram.split("## 4. Authenticate and start")[1] ?? "", /export\s+TELEGRAM_/u);
  assert.match(readme, /Before opening a managed thread.*unadopt_session.*adopt it again/isu);
  assert.match(setup, /config-check.*required Telegram values.*assistant-login.*does not need chat credentials/isu);
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

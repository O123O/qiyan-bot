import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { SERVICE_UNSET_ENV_NAMES } from "../src/config-source.ts";

test("README links to all focused guides and every local guide target exists", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  assert.ok(readme.indexOf("general-purpose personal assistant") < readme.indexOf("Telegram"));
  assert.match(readme, /handle small filesystem tasks directly/iu);
  assert.match(readme, /ordinary, resumable Codex sessions/iu);
  assert.match(readme, /Telegram and Slack can run together/iu);
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
  assert.match(guide, /set -euo pipefail/u);
  assert.ok(guide.indexOf('config-check --home "$stage"') < guide.indexOf('rm -rf -- "$old_home"'));
  assert.match(guide, /deliberately drops `QIYAN_HOME`, `ASSISTANT_WORKDIR`, `DATA_DIR`, and `SESSION_REGISTRY_PATH`/u);
  assert.equal([...guide.matchAll(/env -i HOME="\$HOME" PATH="\$PATH" qiyan-bot config-check/gu)].length, 2);
  assert.ok([...guide.matchAll(/O_NOFOLLOW/gu)].length >= 2);
  assert.ok([...guide.matchAll(/fstatSync/gu)].length >= 2);
  const stagedAuthParse = guide.indexOf('JSON.parse(bytes.toString("utf8"))');
  assert.ok(stagedAuthParse >= 0 && stagedAuthParse < guide.indexOf("STAGED_AUTH, bytes"));
  const pathGate = guide.indexOf('OLD_HOME="$old_home" NEW_HOME="$new_home"');
  assert.ok(pathGate >= 0 && pathGate < guide.indexOf('rm -rf -- "$old_home"'));
  for (const invariant of ["exact absolute normalized path", "exact canonical path", "old_home cannot be a filesystem root", "new_home must be the exact $HOME/.qiyan-bot", "staging must be outside", "must not overlap"]) {
    assert.equal(guide.includes(invariant), true, `v0.3 cutover path gate is missing: ${invariant}`);
  }
  const unset = guide.match(/^UnsetEnvironment=(.+)$/mu)?.[1]?.trim().split(/\s+/u);
  assert.deepEqual(new Set(unset), SERVICE_UNSET_ENV_NAMES);
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
    ["Slack launch", await readFile(resolve("docs/chat-apps/slack.md"), "utf8"), "\nqiyan-bot\n"],
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
  assert.match(setup, /config-check.*at least one complete adapter group.*assistant-login.*does not need chat credentials/isu);
});

test("Slack guide covers the implemented single-user Socket Mode setup and limits", async () => {
  const guide = await readFile(resolve("docs/chat-apps/slack.md"), "utf8");
  for (const required of [
    "Status: Implemented", "Socket Mode", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN", "SLACK_TEAM_ID", "SLACK_OWNER_USER_ID",
    "PRIMARY_CHAT_APP", "chmod 600", "connections:write", "xapp-", "xoxb-", "xoxp-", "private-search consent", "Copy member ID",
    "/invite @QiYan", "activated thread", "transient", "3,000", "Activity feed", "ATTACHMENT_MAX_BYTES", "Revoked",
  ]) assert.equal(guide.includes(required), true, `Slack guide is missing: ${required}`);
  assert.match(guide, /internal Slack app|workspace-internal app/iu);
  assert.match(guide, /user token.*code boundary.*read-only.*powerful/isu);
  assert.match(guide, /search.*cannot exceed.*owner.*permissions.*workspace policy/isu);
  const secureCreate = guide.indexOf('install -m 600 /dev/null "$HOME/.qiyan-bot/.env"');
  const privateEdit = guide.indexOf('${EDITOR:-vi} "$HOME/.qiyan-bot/.env"');
  assert.ok(secureCreate >= 0 && privateEdit > secureCreate, "Slack dotenv must be mode 0600 before credentials are edited");
  assert.doesNotMatch(guide, /cat > "?\$HOME\/\.qiyan-bot\/\.env"?/u);
  assert.match(guide, /shell history/iu);
  assert.doesNotMatch(guide, /EnvironmentFile=/u);
});

test("packaged Slack manifest has the exact reviewed events and scopes", async () => {
  const manifest = await readFile(resolve("assets/slack/manifest.yaml"), "utf8");
  assert.match(manifest, /socket_mode_enabled: true/u);
  assert.match(manifest, /messages_tab_enabled: true/u);
  const list = (section: string) => [...section.matchAll(/^\s+- ([a-z_.:]+)$/gmu)].map((match) => match[1]!);
  const bot = manifest.split(/^\s{4}bot:$/mu)[1]!.split(/^\s{4}user:$/mu)[0]!;
  const user = manifest.split(/^\s{4}user:$/mu)[1]!.split(/^settings:$/mu)[0]!;
  const events = manifest.split(/^\s{4}bot_events:$/mu)[1]!.split(/^\s{2}org_deploy_enabled:/mu)[0]!;
  assert.deepEqual(list(bot), ["app_mentions:read", "channels:history", "channels:read", "chat:write", "files:read", "files:write", "groups:history", "groups:read", "im:history", "im:write", "users:read"]);
  assert.deepEqual(list(user), ["search:read.files", "search:read.im", "search:read.mpim", "search:read.private", "search:read.public", "search:read.users"]);
  assert.deepEqual(list(events), ["app_mention", "message.channels", "message.groups", "message.im"]);
  assert.doesNotMatch(manifest, /incoming_webhooks|redirect_urls/u);

  const wechat = await readFile(resolve("docs/chat-apps/wechat.md"), "utf8");
  assert.match(wechat, /Status: Planned/u);
  assert.match(wechat, /not implemented/iu);
});

test("shared docs explain conversation-bound native steering and ordinary safeguards", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  const setup = await readFile(resolve("docs/setup.md"), "utf8");
  const telegram = await readFile(resolve("docs/chat-apps/telegram.md"), "utf8");
  const combined = `${readme}\n${setup}\n${telegram}`;
  assert.match(readme, /\[system\] queued/u);
  assert.match(combined, /same conversation.*turn\/steer/isu);
  assert.match(combined, /\/pass.*\/collect.*ordinary messages/isu);
  assert.match(combined, /one active QiYan conversation/iu);
  assert.match(combined, /QiYan.*never chooses.*platform.*destination/isu);
  assert.match(telegram, /attachments?.*turn\/steer/isu);
});

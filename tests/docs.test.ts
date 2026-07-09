import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("README links to all focused guides and every local guide target exists", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  assert.ok(readme.indexOf("general-purpose personal assistant") < readme.indexOf("Telegram"));
  assert.match(readme, /handle small filesystem tasks directly/iu);
  assert.match(readme, /ordinary, resumable Codex sessions/iu);
  assert.match(readme, /assets\/brand\/qiyan-overview\.svg/iu);
  await access(resolve("assets/brand/qiyan-overview.svg"));
  const overview = await readFile(resolve("assets/brand/qiyan-overview.svg"), "utf8");
  assert.match(overview, /auto-release on external takeover/iu);
  assert.doesNotMatch(overview, /unadopt when you take over/iu);
  assert.match(readme, /Telegram.*Slack.*WeChat.*run together/iu);
  assert.doesNotMatch(readme, /upgrading-to-v0\.3|fresh v0\.3|versions? before v0\.3/iu);
  const firstInstall = readme.indexOf("npm install --global");
  assert.ok(firstInstall > 0);
  assert.match(readme, /npm install --global --prefix "\$HOME\/\.local"[\s\\]+https:\/\/github\.com\/O123O\/qiyan-bot\/releases\/latest\/download\/qiyan-bot\.tgz/iu);
  assert.doesNotMatch(readme, /workdir=\$\(mktemp|sha256sum --check/iu);
  assert.match(readme, /manual digest verification.*installation guide/iu);
  const links = [...readme.matchAll(/\]\((docs\/[^)#]+)(?:#[^)]+)?\)/gu)].map((match) => match[1]!);
  for (const expected of [
    "docs/installation.md",
    "docs/sqlite.md",
    "docs/setup.md",
    "docs/chat-apps/telegram.md",
    "docs/chat-apps/slack.md",
    "docs/chat-apps/wechat.md",
    "docs/ssh-workers.md",
  ]) {
    assert.equal(links.includes(expected), true, `README does not link ${expected}`);
  }
  await Promise.all(links.map((link) => access(resolve(link))));
});

test("the focused SQLite guide documents durability and automatic recovery", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  assert.match(readme, /\[SQLite durability and recovery\]\(docs\/sqlite\.md\)/u);
  assert.doesNotMatch(readme, /### SQLite durability|### Automatic dashboard-metadata recovery/u);

  const guide = await readFile(resolve("docs/sqlite.md"), "utf8");
  assert.match(guide, /rollback journal.*`journal_mode=DELETE`/isu);
  assert.match(guide, /`synchronous=EXTRA`/u);
  assert.match(guide, /one QiYan process.*data directory/isu);
  assert.match(guide, /recognized QiYan database.*full `PRAGMA integrity_check`.*before.*chat adapters/isu);
  assert.match(guide, /stop QiYan.*bot\.sqlite3.*-wal.*-shm.*-journal.*together/isu);
  assert.match(guide, /SQLite online backup API/iu);
  assert.doesNotMatch(guide, /recover-dashboard-metadata/u);
  assert.match(guide, /automatically.*private backup.*rebuilds only.*dashboard metadata.*before.*chat adapters/isu);
  assert.match(guide, /authoritative.*unreadable.*stops safely/isu);
  assert.match(guide, /does not need periodic shutdowns/iu);
  assert.match(guide, /NFS.*lock.*sync.*depend/isu);
  assert.doesNotMatch(guide, /NFS (?:is|filesystem is) (?:fully |completely )?safe/iu);
});

test("SSH worker guides document supported endpoints and the source-checkout fixture", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  assert.equal(readme.includes("docs/development/ssh-worker-fixture.md"), true, "README does not link the SSH worker development guide");
  const supported = await readFile(resolve("docs/ssh-workers.md"), "utf8");
  for (const required of ["SSH worker endpoints", "endpoints.json", "0.142.5 or newer", "tmux -L qiyan-bot", "list-sessions", "disconnect_endpoint", "restart_endpoint", "unavailable SSH endpoint", "capacity stays reserved"]) {
    assert.equal(supported.includes(required), true, `SSH worker guide is missing: ${required}`);
  }
  assert.match(supported, /ControlPath.*\$\{XDG_RUNTIME_DIR\}.*private local filesystem/isu);
  assert.match(supported, /NFS.*ControlMaster.*not supported/isu);
  assert.doesNotMatch(supported, /ControlPath\s+~\/\.ssh/iu);
  const guide = await readFile(resolve("docs/development/ssh-worker-fixture.md"), "utf8");
  for (const required of [
    "Development fixture", "Docker Compose", "127.0.0.1", "ssh-worker:up",
    "ssh-worker:login", "ssh-worker:check", "ssh-worker:down", "ssh-worker:reset",
    "device authentication", ".tmp/ssh-worker", "StrictHostKeyChecking",
    "source checkout only", "production endpoint uses a detached tmux App Server",
  ]) assert.equal(guide.includes(required), true, `SSH worker guide is missing: ${required}`);
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
  assert.doesNotMatch(guide, /upgrading-to-v0\.3|fresh v0\.3|older than v0\.3/iu);
  await assert.rejects(access(resolve("docs/upgrading-to-v0.3.md")));
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
  assert.match(readme, /another Codex client.*automatically unadopts.*external turn.*idle/isu);
  assert.match(readme, /planned handoff.*unadopt_session/isu);
  assert.doesNotMatch(readme, /Before opening a managed thread.*run `unadopt_session`/isu);
  assert.match(setup, /config-check.*at least one configured adapter.*assistant-login.*does not need chat credentials/isu);
});

test("service guides document the captured terminal PATH and required reinstall", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  const setup = await readFile(resolve("docs/setup.md"), "utf8");
  for (const [name, document] of [["README", readme], ["setup", setup]] as const) {
    assert.match(document, /service install.*captures?.*(?:terminal|invoking shell).*`?PATH`?/isu, `${name} does not explain PATH capture`);
    assert.match(document, /PATH changes?.*service uninstall.*service install/isu, `${name} does not require service reinstall after PATH changes`);
    assert.match(document, /does not (?:source|read).*(?:config\.fish|\.bashrc|shell startup)/isu, `${name} does not explain the shell-startup boundary`);
  }
});

test("Slack guide covers the implemented single-user Socket Mode setup and limits", async () => {
  const guide = await readFile(resolve("docs/chat-apps/slack.md"), "utf8");
  for (const required of [
    "Status: Implemented", "Socket Mode", "SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_USER_TOKEN", "SLACK_OWNER_USER_ID",
    "PRIMARY_CHAT_APP", "chmod 600", "connections:write", "xapp-", "xoxb-", "xoxp-", "private-search consent", "Copy member ID",
    "/invite @QiYan", "activated thread", "transient", "3,000", "Activity feed", "ATTACHMENT_MAX_BYTES", "Revoked",
  ]) assert.equal(guide.includes(required), true, `Slack guide is missing: ${required}`);
  assert.match(guide, /internal Slack app|workspace-internal app/iu);
  assert.match(guide, /user token.*code boundary.*read-only.*powerful/isu);
  assert.match(guide, /search.*cannot exceed.*owner.*permissions.*workspace policy/isu);
  assert.match(guide, /workspace.*deriv.*auth\.test.*bot.*user token.*same workspace/isu);
  assert.match(guide, /keyword search.*Slack AI Search.*semantic/isu);
  assert.doesNotMatch(guide, /^SLACK_TEAM_ID=/mu);
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

});

test("WeChat guide documents the implemented personal-owner adapter without environment credentials", async () => {
  const guide = await readFile(resolve("docs/chat-apps/wechat.md"), "utf8");
  for (const required of [
    "Status: Experimental", "qiyan-bot weixin-login", "--home", "credentials/weixin.json", "PRIMARY_CHAT_APP=weixin",
    "text", "image", "file", "voice transcription", "group", "raw voice", "raw video", "history", "search",
    "cef0bfc390393f716903e16d50408118047f87e0", "2.4.6", "MIT", "no endorsement",
    "QR", "attachment", "poll", "restart", "relogin", "backup", "revoke",
  ]) assert.equal(guide.toLowerCase().includes(required.toLowerCase()), true, `WeChat guide is missing: ${required}`);
  assert.match(guide, /implemented.*automated-test(?:ed| coverage).*not successfully live-tested/isu);
  assert.match(guide, /non-mainland-China.*phone number.*could not complete.*authorization/isu);
  assert.match(guide, /direct personal.*owner|owner.*direct personal/isu);
  assert.match(guide, /credentials\/weixin\.json.*(?:0600|owner-only)/isu);
  assert.match(guide, /not.*(?:\.env|environment)|(?:\.env|environment).*not/isu);
  assert.match(guide, /groups?.*(?:unsupported|not supported)|(?:unsupported|not supported).*groups?/isu);
  assert.match(guide, /voice transcription.*supported/isu);
  assert.match(guide, /raw voice.*(?:unsupported|not supported)/isu);
  assert.match(guide, /raw video.*(?:unsupported|not supported)/isu);
  assert.match(guide, /raw video.*explicit unsupported-media descriptor/isu);
  assert.match(guide, /history.*search.*(?:unsupported|not supported)|(?:unsupported|not supported).*history.*search/isu);
  assert.doesNotMatch(guide, /Status: Planned|not implemented in this release/iu);
  assert.doesNotMatch(guide, /^WEIXIN_(?:BOT_TOKEN|BOT_ID|OWNER_USER_ID)=/mu);
  assert.doesNotMatch(guide, /\]\(\.\.\/(?:installation|setup)\.md\)/u);
});

test("shared setup docs treat WeChat as a managed-credential adapter", async () => {
  const readme = await readFile(resolve("README.md"), "utf8");
  const setup = await readFile(resolve("docs/setup.md"), "utf8");
  const install = await readFile(resolve("docs/installation.md"), "utf8");
  const envExample = await readFile(resolve(".env.example"), "utf8");
  assert.match(readme, /Telegram.*Slack.*WeChat.*implemented/isu);
  assert.match(readme, /personal WeChat.*experimental.*automated-test(?:ed| coverage).*(?:not|has not been) successfully live-tested/isu);
  assert.match(readme, /Personal WeChat — experimental/iu);
  assert.doesNotMatch(readme, /WeChat[^\n]*(?:planned|deferred)|(?:planned|deferred)[^\n]*WeChat/iu);
  assert.match(setup, /PRIMARY_CHAT_APP=(?:telegram\|slack\|weixin|telegram, slack, or weixin)|PRIMARY_CHAT_APP.*weixin/iu);
  assert.match(setup, /qiyan-bot weixin-login/iu);
  assert.match(install, /WeChat adapter|chat-apps\/wechat\.md/iu);
  assert.match(envExample, /WeChat credentials.*not.*\.env/iu);
  assert.match(envExample, /PRIMARY_CHAT_APP=.*weixin/iu);
  assert.doesNotMatch(envExample, /^WEIXIN_(?:BOT_TOKEN|BOT_ID|OWNER_USER_ID)=/mu);
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

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config.ts";
import { bootstrapWeixin } from "../../src/chat-apps/weixin/bootstrap.ts";
import { WeixinCredentialStore } from "../../src/chat-apps/weixin/credential-store.ts";

test("bootstraps only a public configured flag while retaining an opaque credential handle", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-weixin-bootstrap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const qiyanHome = join(root, "home");
  await mkdir(qiyanHome, { mode: 0o700 });
  await new WeixinCredentialStore(qiyanHome).commitConfirmed({
    botId: "private-bot-id",
    ownerUserId: "private-owner-id",
    botToken: "private-bearer-token",
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
    authenticatedAt: 1,
  });

  const bootstrap = await bootstrapWeixin(qiyanHome);
  assert.equal(bootstrap.configured, true);
  assert.ok(bootstrap.credential);
  const config = loadConfig({ HOME: root }, { qiyanHome, weixinConfigured: bootstrap.configured });
  assert.deepEqual(config.chat, { primary: "weixin", weixin: { configured: true } });
  assert.doesNotMatch(JSON.stringify(config), /private-bearer-token|private-bot-id|private-owner-id/u);
  assert.doesNotMatch(JSON.stringify(bootstrap), /private-bearer-token/u);
});

test("reports an absent credential and fails closed on an invalid credential", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "qiyan-weixin-bootstrap-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const empty = join(root, "empty");
  await mkdir(empty, { mode: 0o700 });
  assert.deepEqual(await bootstrapWeixin(empty), { configured: false });

  const invalid = join(root, "invalid");
  await mkdir(join(invalid, "credentials"), { recursive: true, mode: 0o700 });
  await writeFile(join(invalid, "credentials", "weixin.json"), "{invalid", { mode: 0o600 });
  await assert.rejects(bootstrapWeixin(invalid), /credential/u);
});

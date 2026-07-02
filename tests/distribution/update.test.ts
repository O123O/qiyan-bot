import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  LATEST_RELEASE_URL,
  buildUpdateEnvironment,
  globalPrefixForPackage,
  updateFromLatestRelease,
  type UpdateRunner,
  type UpdateSpawnOptions,
} from "../../src/distribution/update.ts";

test("derives only an exact Linux global npm prefix", () => {
  assert.equal(globalPrefixForPackage("/home/user/.local/lib/node_modules/qiyan-bot"), "/home/user/.local");
  assert.throws(() => globalPrefixForPackage("/source/qiyan-bot"), /globally installed/);
  assert.throws(() => globalPrefixForPackage("/project/node_modules/qiyan-bot"), /globally installed/);
  assert.throws(() => globalPrefixForPackage("/prefix/lib/node_modules/another-package"), /globally installed/);
  assert.throws(() => globalPrefixForPackage("/prefix/lib/node_modules/qiyan-bot/dist"), /globally installed/);
});

test("builds a minimal npm environment without bot, Codex, or arbitrary secrets", () => {
  const result = buildUpdateEnvironment({
    PATH: "/bin", HOME: "/home/user", USER: "user", LOGNAME: "user", SHELL: "/bin/sh",
    TMPDIR: "/tmp/custom", TMP: "/tmp", TEMP: "/tmp", LANG: "en_US.UTF-8", TERM: "xterm",
    LC_ALL: "C", HTTPS_PROXY: "https://proxy", no_proxy: "localhost",
    SSL_CERT_FILE: "/cert.pem", SSL_CERT_DIR: "/certs", NODE_EXTRA_CA_CERTS: "/node.pem",
    TELEGRAM_BOT_TOKEN: "telegram-secret", TELEGRAM_OWNER_ID: "123", TELEGRAM_DESTINATION_CHAT_ID: "123",
    OPENAI_API_KEY: "openai-secret", CODEX_API_KEY: "codex-secret", CODEX_HOME: "/secret/codex",
    QIYAN_BOT_MCP_TOKEN: "mcp-secret", NPM_TOKEN: "npm-secret", npm_config_token: "npm-config-secret",
    GH_TOKEN: "github-secret", OTHER_SECRET: "other-secret", NODE_OPTIONS: "--require secret.js",
  });

  assert.deepEqual(result, {
    PATH: "/bin", HOME: "/home/user", USER: "user", LOGNAME: "user", SHELL: "/bin/sh",
    TMPDIR: "/tmp/custom", TMP: "/tmp", TEMP: "/tmp", LANG: "en_US.UTF-8", TERM: "xterm",
    LC_ALL: "C", HTTPS_PROXY: "https://proxy", no_proxy: "localhost",
    SSL_CERT_FILE: "/cert.pem", SSL_CERT_DIR: "/certs", NODE_EXTRA_CA_CERTS: "/node.pem",
  });
});

test("updates the detected prefix with exact safe npm arguments and re-reads the version", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "qiyan-bot-update-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const prefix = join(temp, "prefix");
  const packageRoot = join(prefix, "lib", "node_modules", "qiyan-bot");
  const modulePath = join(packageRoot, "dist", "qiyan-bot");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeManifest(packageRoot, "0.1.0");
  let observed: { command: string; args: readonly string[]; options: UpdateSpawnOptions } | undefined;
  const runner: UpdateRunner = async (command, args, options) => {
    observed = { command, args, options };
    await writeManifest(packageRoot, "0.3.0");
    return { code: 0, signal: null };
  };

  const result = await updateFromLatestRelease({
    moduleUrl: pathToFileURL(modulePath).href,
    env: { PATH: "/bin", HOME: "/home/user", TELEGRAM_BOT_TOKEN: "must-not-leak" },
    runner,
  });

  assert.deepEqual(result, { prefix: resolve(prefix), version: "0.3.0" });
  assert.equal(observed?.command, "npm");
  assert.deepEqual(observed?.args, [
    "install", "--global", "--prefix", resolve(prefix), "--ignore-scripts", "--no-audit", "--no-fund", LATEST_RELEASE_URL,
  ]);
  assert.equal(observed?.options.stdio, "inherit");
  assert.equal(observed?.options.shell, false);
  assert.deepEqual(observed?.options.env, { PATH: "/bin", HOME: "/home/user" });
});

test("reports child status, signal, and startup failures without leaking source errors", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "qiyan-bot-update-failure-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const packageRoot = join(temp, "prefix", "lib", "node_modules", "qiyan-bot");
  const modulePath = join(packageRoot, "dist", "qiyan-bot");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeManifest(packageRoot, "0.1.0");
  const moduleUrl = pathToFileURL(modulePath).href;

  await assert.rejects(updateFromLatestRelease({ moduleUrl, runner: async () => ({ code: 7, signal: null }) }), /npm exited with status 7/);
  await assert.rejects(updateFromLatestRelease({ moduleUrl, runner: async () => ({ code: null, signal: "SIGTERM" }) }), /npm exited from signal SIGTERM/);
  let failure: unknown;
  try {
    await updateFromLatestRelease({ moduleUrl, runner: async () => { throw new Error("spawn secret-value"); } });
  } catch (error) {
    failure = error;
  }
  assert.match(String(failure), /could not start npm/);
  assert.doesNotMatch(String(failure), /secret-value/);
});

async function writeManifest(packageRoot: string, version: string): Promise<void> {
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: "qiyan-bot", version })}\n`);
}

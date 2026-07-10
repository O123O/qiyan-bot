import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { readPackageInfo } from "../../src/distribution/package-info.ts";
import { APP_VERSION } from "../../src/version.ts";

test("protocol and package identities share the release version", async () => {
  const manifest = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile("package.json", "utf8")));
  assert.equal(APP_VERSION, manifest.version);
  const versionSource = await import("node:fs/promises").then(({ readFile }) => readFile("src/version.ts", "utf8"));
  assert.match(versionSource, /package\.json/u);
  assert.doesNotMatch(versionSource, new RegExp(manifest.version.replaceAll(".", "\\."), "u"));
});

test("finds the nearest qiyan-bot package manifest from a module URL", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "qiyan-bot-package-info-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const packageRoot = join(temp, "package");
  const modulePath = join(packageRoot, "dist", "qiyan-bot");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "qiyan-bot", version: "1.2.3-beta.1" }));

  assert.deepEqual(await readPackageInfo(pathToFileURL(modulePath).href), {
    root: packageRoot,
    name: "qiyan-bot",
    version: "1.2.3-beta.1",
  });
});

test("rejects a nearest manifest for another package and a missing manifest", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "qiyan-bot-package-info-invalid-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const wrongRoot = join(temp, "wrong");
  await mkdir(join(wrongRoot, "dist"), { recursive: true });
  await writeFile(join(wrongRoot, "package.json"), JSON.stringify({ name: "another-package", version: "1.0.0" }));

  await assert.rejects(readPackageInfo(pathToFileURL(join(wrongRoot, "dist", "entry")).href), /not a qiyan-bot package/);
  await assert.rejects(readPackageInfo(pathToFileURL(join(temp, "missing", "entry")).href), /could not locate qiyan-bot package metadata/);
});

test("rejects invalid qiyan-bot package metadata", async (context) => {
  const temp = await mkdtemp(join(tmpdir(), "qiyan-bot-package-info-version-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  await mkdir(join(temp, "dist"));
  await writeFile(join(temp, "package.json"), JSON.stringify({ name: "qiyan-bot", version: "latest" }));

  await assert.rejects(readPackageInfo(pathToFileURL(join(temp, "dist", "entry")).href), /invalid qiyan-bot package metadata/);
});

test("release package contract includes chat assets and bundles SDK dependencies", async () => {
  const manifest = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile("package.json", "utf8"))) as {
    files: string[];
    dependencies?: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.ok(manifest.files.includes("assets/brand/qiyan-logo.png"));
  assert.ok(manifest.files.includes("assets/brand/qiyan-overview.svg"));
  assert.ok(manifest.files.includes("assets/slack/manifest.yaml"));
  assert.ok(manifest.files.includes("assets/endpoints.example.jsonc"));
  assert.ok(manifest.files.includes("docs/chat-apps/wechat.md"));
  assert.ok(manifest.files.includes("docs/sqlite.md"));
  assert.ok(manifest.files.includes("dist/qiyan-bot"));
  assert.deepEqual(manifest.dependencies ?? {}, {});
  const build = await import("node:fs/promises").then(({ readFile }) => readFile("scripts/build.mjs", "utf8"));
  assert.match(build, /bundle: true/u);
  assert.match(build, /packages: "bundle"/u);
  const clients = await import("node:fs/promises").then(({ readFile }) => readFile("src/chat-apps/slack/clients.ts", "utf8"));
  const socket = await import("node:fs/promises").then(({ readFile }) => readFile("src/chat-apps/slack/chat-adapter.ts", "utf8"));
  assert.match(clients, /@slack\/web-api/u);
  assert.match(socket, /@slack\/socket-mode/u);
  assert.equal(manifest.devDependencies["lossless-json"], "4.3.0");
  assert.equal(manifest.devDependencies["qrcode-terminal"], "0.12.0");
  assert.equal(Object.keys(manifest.devDependencies).some((name) => name.toLowerCase().includes("openclaw")), false);
});

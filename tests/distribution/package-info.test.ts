import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readPackageInfo } from "../../src/distribution/package-info.ts";
import { APP_VERSION } from "../../src/version.ts";

test("protocol and package identities share the release version", async () => {
  const manifest = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile("package.json", "utf8")));
  assert.equal(APP_VERSION, manifest.version);
  assert.equal(APP_VERSION, "0.3.0");
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

test("release package includes the Slack manifest and bundled SDK without a runtime install tree", async () => {
  const run = promisify(execFile);
  const { stdout } = await run("npm", ["pack", "--dry-run", "--json", "--silent"], { maxBuffer: 20 * 1024 * 1024 });
  const report = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
  const files = report[0]!.files.map(({ path }) => path);
  assert.ok(files.includes("assets/slack/manifest.yaml"));
  assert.ok(files.includes("dist/qiyan-bot"));
  assert.equal(files.some((path) => path.includes("node_modules/")), false);
  const bundled = await import("node:fs/promises").then(({ readFile }) => readFile("dist/qiyan-bot", "utf8"));
  assert.match(bundled, /SocketModeClient/u);
  assert.match(bundled, /assistant\.search\.context/u);
});

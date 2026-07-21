import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { formatStartupError } from "../../src/cli.ts";
import { prepareAssistantWorkspace, type AssistantWorkspaceOptions } from "../../src/assistant/workspace.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixtureWithTemplates(policy: string, options: { nestedInGit?: boolean } = {}): Promise<{
  workdir: string;
  policyTemplate: string;
  options: AssistantWorkspaceOptions;
}> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-workspace-"));
  const assets = join(root, "assets");
  const gitRoot = join(root, "project");
  const workdir = options.nestedInGit ? join(gitRoot, "manager") : join(root, "manager");
  await mkdir(assets, { recursive: true });
  if (options.nestedInGit) await mkdir(join(gitRoot, ".git"), { recursive: true });
  const policyTemplate = join(assets, "AGENTS.md");
  const dataDir = join(root, "backend-data");
  const registryPath = join(root, "backend-registry", "sessions.json");
  const userHome = join(root, "home");
  const qiyanHome = join(userHome, ".qiyan-bot");
  await mkdir(qiyanHome, { recursive: true, mode: 0o700 });
  await writeFile(policyTemplate, policy);
  return {
    workdir,
    policyTemplate,
    options: { workdir, dataDir, registryPath, policyTemplatePath: policyTemplate, userHome, qiyanHome },
  };
}

test("installs the managed policy and returns the generated dashboard path", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  const prepared = await prepareAssistantWorkspace(fixture.options);
  assert.equal(await readFile(join(prepared.root, "AGENTS.md"), "utf8"), "policy-v1\n");
  assert.equal((await readFile(join(prepared.root, ".qiyan-bot-agents.sha256"), "utf8")).trim(), sha256("policy-v1\n"));
  assert.equal(prepared.dashboardPath, join(prepared.root, "session-status.json"));
  assert.equal(prepared.contextPath, join(prepared.root, "assistant-context.json"));
  assert.deepEqual(JSON.parse(await readFile(prepared.contextPath, "utf8")), {
    version: 2,
    user_home: await realpath(fixture.options.userHome),
    qiyan_home: await realpath(fixture.options.qiyanHome),
    default_projects_root: join(await realpath(fixture.options.userHome), "qiyan-projects"),
  });
  assert.equal((await stat(prepared.contextPath)).mode & 0o777, 0o400);
  await assert.rejects(readFile(prepared.dashboardPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("composes AGENTS.append.md once and refreshes the managed policy when it changes", async () => {
  const fixture = await fixtureWithTemplates("policy-v1");
  await mkdir(fixture.workdir, { recursive: true });
  const appendPath = join(fixture.workdir, "AGENTS.append.md");
  await writeFile(appendPath, "custom-v1\n");

  await prepareAssistantWorkspace(fixture.options);
  const policyPath = join(fixture.workdir, "AGENTS.md");
  assert.equal(await readFile(policyPath, "utf8"), "policy-v1\n\ncustom-v1\n");
  assert.equal(
    (await readFile(join(fixture.workdir, ".qiyan-bot-agents.sha256"), "utf8")).trim(),
    sha256("policy-v1\n\ncustom-v1\n"),
  );

  await prepareAssistantWorkspace(fixture.options);
  assert.equal(await readFile(policyPath, "utf8"), "policy-v1\n\ncustom-v1\n");

  await writeFile(appendPath, "custom-v2\n");
  await prepareAssistantWorkspace(fixture.options);
  assert.equal(await readFile(policyPath, "utf8"), "policy-v1\n\ncustom-v2\n");

  await rm(appendPath);
  await prepareAssistantWorkspace(fixture.options);
  assert.equal(await readFile(policyPath, "utf8"), "policy-v1");
});

test("rejects a non-regular AGENTS.append.md without following it", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await mkdir(fixture.workdir, { recursive: true });
  await symlink(fixture.policyTemplate, join(fixture.workdir, "AGENTS.append.md"));
  await assert.rejects(prepareAssistantWorkspace(fixture.options), /AGENTS\.append\.md must be a regular file/);
});

test("updates an unchanged generated context and rejects manual replacement", async () => {
  const update = await fixtureWithTemplates("policy-v1\n");
  const initial = await prepareAssistantWorkspace(update.options);
  const alternateHome = join(dirname(update.options.userHome), "alternate-home");
  await mkdir(alternateHome);
  await prepareAssistantWorkspace({ ...update.options, userHome: alternateHome });
  assert.equal(JSON.parse(await readFile(initial.contextPath, "utf8")).user_home, await realpath(alternateHome));

  const fixture = await fixtureWithTemplates("policy-v1\n");
  const first = await prepareAssistantWorkspace(fixture.options);
  await chmod(first.contextPath, 0o600);
  await writeFile(first.contextPath, "manual\n");
  await assert.rejects(prepareAssistantWorkspace(fixture.options), /assistant-context\.json.*modified/);
});

test("upgrades an unmodified managed policy", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await prepareAssistantWorkspace(fixture.options);
  await writeFile(fixture.policyTemplate, "policy-v2\n");
  await prepareAssistantWorkspace(fixture.options);
  assert.equal(await readFile(join(fixture.workdir, "AGENTS.md"), "utf8"), "policy-v2\n");
});

test("rejects a modified managed policy without overwriting it", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await prepareAssistantWorkspace(fixture.options);
  await writeFile(join(fixture.workdir, "AGENTS.md"), "my edits\n");
  await assert.rejects(prepareAssistantWorkspace(fixture.options), /AGENTS\.md is managed.*AGENTS\.override\.md/);
  assert.equal(await readFile(join(fixture.workdir, "AGENTS.md"), "utf8"), "my edits\n");
});

test("adopts an unhashed policy only when it exactly matches the packaged policy", async () => {
  const matching = await fixtureWithTemplates("policy-v1\n");
  await mkdir(matching.workdir, { recursive: true });
  await writeFile(join(matching.workdir, "AGENTS.md"), "policy-v1\n");
  await prepareAssistantWorkspace(matching.options);
  assert.equal((await readFile(join(matching.workdir, ".qiyan-bot-agents.sha256"), "utf8")).trim(), sha256("policy-v1\n"));

  const differing = await fixtureWithTemplates("policy-v1\n");
  await mkdir(differing.workdir, { recursive: true });
  await writeFile(join(differing.workdir, "AGENTS.md"), "unknown\n");
  await assert.rejects(prepareAssistantWorkspace(differing.options), /has no bot digest/);
});

test("rejects a missing policy when its digest remains", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await prepareAssistantWorkspace(fixture.options);
  await rm(join(fixture.workdir, "AGENTS.md"));
  await assert.rejects(prepareAssistantWorkspace(fixture.options), /digest exists but AGENTS\.md is missing/);
});

test("does not inspect or alter AGENTS.override.md", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await mkdir(fixture.workdir, { recursive: true });
  await symlink("missing-user-owned-target", join(fixture.workdir, "AGENTS.override.md"));
  await prepareAssistantWorkspace(fixture.options);
  assert.equal(await readlink(join(fixture.workdir, "AGENTS.override.md")), "missing-user-owned-target");
});

test("workspace preparation preserves an existing dashboard for later migration", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await mkdir(fixture.workdir, { recursive: true });
  const dashboard = '{"version":1,"sessions":{"project":{"thread_id":"t1","project_status":"working","updated_at":"now"}}}\n';
  await writeFile(join(fixture.workdir, "session-status.json"), dashboard);
  await prepareAssistantWorkspace(fixture.options);
  assert.equal(await readFile(join(fixture.workdir, "session-status.json"), "utf8"), dashboard);
});

test("warns when the workspace has a Git ancestor", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n", { nestedInGit: true });
  const prepared = await prepareAssistantWorkspace(fixture.options);
  assert.match(prepared.warnings.join("\n"), /Git worktree.*parent instructions, project configuration, and repository skills/);
});

test("rejects direct, nested, and symlink-equivalent overlap with backend state", async () => {
  const direct = await fixtureWithTemplates("policy-v1\n");
  await assert.rejects(prepareAssistantWorkspace({ ...direct.options, dataDir: direct.workdir }), /must be separate from backend state/);

  const nested = await fixtureWithTemplates("policy-v1\n");
  await assert.rejects(prepareAssistantWorkspace({ ...nested.options, dataDir: join(nested.workdir, "data") }), /must be separate from backend state/);

  const aliased = await fixtureWithTemplates("policy-v1\n");
  const actualData = join(dirname(aliased.workdir), "actual-data");
  const dataAlias = join(dirname(aliased.workdir), "data-alias");
  await mkdir(actualData, { recursive: true });
  await symlink(actualData, dataAlias, "dir");
  await assert.rejects(prepareAssistantWorkspace({ ...aliased.options, workdir: join(actualData, "manager"), dataDir: dataAlias }), /must be separate from backend state/);
});

test("rejects a backend alias located inside the canonical assistant tree", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await mkdir(fixture.workdir, { recursive: true });
  const safeBackend = join(dirname(fixture.workdir), "safe-backend");
  await mkdir(safeBackend, { recursive: true });
  const mutableAlias = join(fixture.workdir, "data-link");
  await symlink(safeBackend, mutableAlias, "dir");
  await assert.rejects(prepareAssistantWorkspace({ ...fixture.options, dataDir: mutableAlias }), /configured data directory.*must be separate/);
});

test("rejects a lexical workdir alias located inside the canonical data directory", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  const realData = join(dirname(fixture.workdir), "real-data");
  const safeWorkdir = join(dirname(fixture.workdir), "safe-workdir");
  const dataAlias = join(dirname(fixture.workdir), "external-data-alias");
  const workdirAlias = join(realData, "manager-link");
  await mkdir(realData, { recursive: true });
  await mkdir(safeWorkdir, { recursive: true });
  await symlink(realData, dataAlias, "dir");
  await symlink(safeWorkdir, workdirAlias, "dir");
  await assert.rejects(
    prepareAssistantWorkspace({ ...fixture.options, workdir: workdirAlias, dataDir: dataAlias }),
    /assistant workdir.*data directory.*must be separate/,
  );
});

test("returns canonical backend paths for exclusive production use", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  const safeBackend = join(dirname(fixture.workdir), "safe-backend");
  const externalAlias = join(dirname(fixture.workdir), "external-data-link");
  await mkdir(safeBackend, { recursive: true });
  await symlink(safeBackend, externalAlias, "dir");
  const prepared = await prepareAssistantWorkspace({ ...fixture.options, dataDir: externalAlias });
  assert.equal(prepared.dataRoot, await realpath(safeBackend));
  assert.notEqual(prepared.dataRoot, externalAlias);
});

test("rejects a registry path inside the assistant workspace", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  await assert.rejects(prepareAssistantWorkspace({ ...fixture.options, registryPath: join(fixture.workdir, "sessions.json") }), /assistant workdir.*registry/);
});

test("reports an unusable workdir without exposing the raw filesystem failure", async () => {
  const fixture = await fixtureWithTemplates("policy-v1\n");
  const blockingFile = join(dirname(fixture.workdir), "not-a-directory");
  await writeFile(blockingFile, "private contents");
  let failure: unknown;
  try { await prepareAssistantWorkspace({ ...fixture.options, workdir: join(blockingFile, "manager") }); }
  catch (error) { failure = error; }
  assert.equal(formatStartupError(failure), `CONFIGURATION_ERROR: cannot prepare assistant workdir ${join(blockingFile, "manager")}`);
  assert.doesNotMatch(formatStartupError(failure), /ENOTDIR|private contents/);
});

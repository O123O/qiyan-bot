import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { readLinuxProcessIdentity, type LinuxProcessIdentity } from "../../src/core/process-identity.ts";
import {
  DEFAULT_CODEX_VERSION,
  DEFAULT_SSH_PORT,
  SSH_ALIAS,
  buildSshArgs,
  ensureFixtureState,
  formatSshConfig,
  resolveFixturePaths,
  writeSshConfig,
  type CommandRunner,
  type FixturePaths,
} from "../../scripts/ssh-worker-support.ts";

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestFixtureKey";

async function temporaryRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-ssh-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

function successfulResult(stdout = "") {
  return { code: 0, signal: null, stdout, stderr: "" } as const;
}

function stagingRunner(calls: Array<{ command: string; args: readonly string[] }>, options: {
  createPublicKey?: boolean;
  derivedPublicKey?: string;
  generatedPublicMode?: number;
} = {}): CommandRunner {
  return async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command !== "ssh-keygen") return successfulResult();

    const outputPathIndex = args.indexOf("-f");
    assert.notEqual(outputPathIndex, -1);
    const keyPath = args[outputPathIndex + 1];
    assert.ok(keyPath);
    if (args.includes("-y")) {
      return successfulResult(`${options.derivedPublicKey ?? `${PUBLIC_KEY} qiyan-ssh-worker`}\n`);
    }

    await writeFile(keyPath, "opaque-test-private-key", { mode: 0o600 });
    if (options.createPublicKey !== false) {
      const publicKeyPath = `${keyPath}.pub`;
      const publicKeyMode = options.generatedPublicMode ?? 0o644;
      await writeFile(publicKeyPath, `${PUBLIC_KEY} qiyan-ssh-worker\n`, {
        mode: publicKeyMode,
      });
      await chmod(publicKeyPath, publicKeyMode);
    }
    return successfulResult();
  };
}

async function installExistingPair(paths: FixturePaths, publicKey = PUBLIC_KEY): Promise<void> {
  await mkdir(dirname(paths.privateKey), { recursive: true, mode: 0o700 });
  await chmod(paths.stateDir, 0o700);
  await chmod(dirname(paths.privateKey), 0o700);
  await writeFile(paths.privateKey, "opaque-test-private-key", { mode: 0o600 });
  await writeFile(paths.publicKey, `${publicKey} a comment that is ignored\n`, { mode: 0o600 });
}

async function assertNoStagingDirectories(stateDir: string): Promise<void> {
  assert.equal((await readdir(stateDir)).some((name) => /^\.keygen-[A-Za-z0-9]{6}$/u.test(name)), false);
}

async function prepareEmptyState(paths: FixturePaths): Promise<void> {
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await chmod(paths.stateDir, 0o700);
}

function operationLeasePath(paths: FixturePaths): string {
  return join(paths.stateDir, ".operation-lease");
}

async function installOperationLease(paths: FixturePaths, owner: LinuxProcessIdentity | string): Promise<string> {
  await prepareEmptyState(paths);
  const lease = operationLeasePath(paths);
  await mkdir(lease, { mode: 0o700 });
  await writeFile(join(lease, "owner.json"), typeof owner === "string" ? owner : `${JSON.stringify(owner)}\n`, { mode: 0o600 });
  return lease;
}

function gate(): { wait: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}

function gatedStagingRunner(): { runner: CommandRunner; entered: Promise<void>; release: () => void } {
  const blocker = gate();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const base = stagingRunner([]);
  let blocked = false;
  const runner: CommandRunner = async (command, args, options) => {
    const result = await base(command, args, options);
    if (!blocked && command === "ssh-keygen" && !args.includes("-y")) {
      blocked = true;
      enter();
      await blocker.wait;
    }
    return result;
  };
  return { runner, entered, release: blocker.release };
}

test("resolves every fixture path beneath a canonical repository root", async (t) => {
  const root = await temporaryRepository(t);
  const stateDir = join(root, ".tmp", "ssh-worker");

  assert.equal(DEFAULT_SSH_PORT, 2222);
  assert.equal(DEFAULT_CODEX_VERSION, "0.142.5");
  assert.equal(SSH_ALIAS, "qiyan-ssh-worker");
  assert.deepEqual(resolveFixturePaths(root), {
    repositoryRoot: root,
    composeFile: join(root, "docker", "ssh-worker", "compose.yaml"),
    stateDir,
    privateKey: join(stateDir, "client-key", "id_ed25519"),
    publicKey: join(stateDir, "client-key", "id_ed25519.pub"),
    trustedHostKey: join(stateDir, "trusted-host-key.pub"),
    knownHosts: join(stateDir, "known_hosts"),
    sshConfig: join(stateDir, "config"),
  });
});

test("rejects relative, non-normalized, aliased, and config-hostile repository roots", async (t) => {
  const root = await temporaryRepository(t);
  assert.throws(() => resolveFixturePaths("relative/repository"), /absolute canonical repository root/u);
  assert.throws(() => resolveFixturePaths(`${root}/../${root.split("/").at(-1) ?? ""}`), /absolute canonical repository root/u);

  const alias = `${root}-alias`;
  await symlink(root, alias, "dir");
  t.after(() => rm(alias, { force: true }));
  assert.throws(() => resolveFixturePaths(alias), /absolute canonical repository root/u);

  const hostile = `${root}\nHost attacker`;
  await mkdir(hostile);
  t.after(() => rm(hostile, { recursive: true, force: true }));
  assert.throws(() => resolveFixturePaths(hostile), /SSH configuration characters/u);

  const expansionHostile = await mkdtemp(join(tmpdir(), "qiyan-${HOME}-"));
  t.after(() => rm(expansionHostile, { recursive: true, force: true }));
  const canonicalExpansionHostile = await realpath(expansionHostile);
  assert.throws(() => resolveFixturePaths(canonicalExpansionHostile), /SSH configuration characters/u);
});

test("formats one strict alias without ambient configuration or identities", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  assert.equal(formatSshConfig(paths, 2222), [
    "Host qiyan-ssh-worker",
    "  HostName 127.0.0.1",
    "  Port 2222",
    "  User codex",
    `  IdentityFile ${paths.privateKey}`,
    "  IdentitiesOnly yes",
    `  UserKnownHostsFile ${paths.knownHosts}`,
    "  StrictHostKeyChecking yes",
    "  BatchMode yes",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    "  ForwardAgent no",
    "  ClearAllForwardings yes",
    "",
  ].join("\n"));

  const config = formatSshConfig(paths, DEFAULT_SSH_PORT);
  assert.equal(config.match(/^Host /gmu)?.length, 1);
  assert.doesNotMatch(config, /StrictHostKeyChecking no|UserKnownHostsFile \/dev\/null|IdentityFile ~|Include /u);
});

test("rejects invalid ports and forged paths that could inject SSH configuration", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  for (const port of [0, 65_536, -1, 22.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => formatSshConfig(paths, port), /port must be an integer from 1 through 65535/u);
  }
  const forged = { ...paths, knownHosts: `${paths.knownHosts}\nStrictHostKeyChecking no` };
  assert.throws(() => formatSshConfig(forged, 2222), /fixture paths do not match/u);
});

test("builds SSH arguments with only the dedicated config before the fixed alias", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  assert.deepEqual(buildSshArgs(paths, ["true"]), ["-F", paths.sshConfig, "qiyan-ssh-worker", "true"]);
  assert.deepEqual(buildSshArgs(paths, ["printf", "%s", "-oProxyCommand=attacker"]), [
    "-F", paths.sshConfig, "qiyan-ssh-worker", "printf", "%s", "-oProxyCommand=attacker",
  ]);
});

test("stages, validates, and installs a new owner-only keypair", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner = stagingRunner(calls);
  const inspectingRunner: CommandRunner = async (command, args, options) => {
    if (!args.includes("-y")) {
      await assert.rejects(lstat(paths.privateKey));
      await assert.rejects(lstat(paths.publicKey));
      const stagedPath = args[args.indexOf("-f") + 1];
      assert.ok(stagedPath);
      assert.notEqual(stagedPath, paths.privateKey);
      assert.equal(dirname(stagedPath).startsWith(`${paths.stateDir}/.keygen-`), true);
    }
    return runner(command, args, options);
  };

  await ensureFixtureState(paths, inspectingRunner);

  assert.equal((await lstat(paths.stateDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(dirname(paths.privateKey))).mode & 0o777, 0o700);
  for (const keyPath of [paths.privateKey, paths.publicKey]) {
    const metadata = await lstat(keyPath);
    assert.equal(metadata.isFile(), true);
    assert.equal(metadata.nlink, 1);
    assert.equal(metadata.mode & 0o777, 0o600);
  }
  assert.equal((await lstat(paths.publicKey)).mode & 0o777, 0o600);
  const stagedPrivateKey = calls[0]?.args.at(-1);
  assert.ok(stagedPrivateKey);
  assert.deepEqual(calls, [
    {
      command: "ssh-keygen",
      args: ["-q", "-t", "ed25519", "-N", "", "-C", "qiyan-ssh-worker", "-f", stagedPrivateKey],
    },
    { command: "ssh-keygen", args: ["-y", "-f", stagedPrivateKey] },
  ]);
  assert.equal((await readFile(paths.publicKey, "utf8")).trim(), `${PUBLIC_KEY} qiyan-ssh-worker`);
  assert.deepEqual(await readdir(paths.stateDir), [
    "client-key",
  ]);
});

for (const generatedPublicMode of [0o644, 0o640, 0o600]) {
  test(`normalizes umask-reduced generated public mode ${generatedPublicMode.toString(8)} to 0600`, async (t) => {
    const paths = resolveFixturePaths(await temporaryRepository(t));
    await ensureFixtureState(paths, stagingRunner([], { generatedPublicMode }));
    assert.equal((await lstat(paths.publicKey)).mode & 0o777, 0o600);
  });
}

for (const generatedPublicMode of [0o664, 0o645]) {
  test(`rejects generated public mode ${generatedPublicMode.toString(8)} with bits outside 0644`, async (t) => {
    const paths = resolveFixturePaths(await temporaryRepository(t));
    await assert.rejects(
      ensureFixtureState(paths, stagingRunner([], { generatedPublicMode })),
      /generated public key.*mode/u,
    );
    await assert.rejects(lstat(paths.privateKey));
    await assert.rejects(lstat(paths.publicKey));
    await assertNoStagingDirectories(paths.stateDir);
  });
}

test("compares existing and derived keys by algorithm and blob while ignoring one-line comments", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingPair(paths);
  const calls: Array<{ command: string; args: readonly string[] }> = [];

  await ensureFixtureState(paths, stagingRunner(calls));

  assert.deepEqual(calls, [{ command: "ssh-keygen", args: ["-y", "-f", paths.privateKey] }]);
  await ensureFixtureState(paths, stagingRunner([], { derivedPublicKey: `${PUBLIC_KEY} qiyan-ssh-worker\r` }));

  for (const derivedPublicKey of [
    `${PUBLIC_KEY} first comment\n${PUBLIC_KEY} second key`,
    `\n${PUBLIC_KEY} leading blank line`,
    `${PUBLIC_KEY} doubled terminal LF\n`,
    `${PUBLIC_KEY} doubled terminal CRLF\r\n\r`,
    "not-an-ssh-public-key",
  ]) {
    await assert.rejects(
      ensureFixtureState(paths, stagingRunner([], { derivedPublicKey })),
      (error: unknown) => {
        assert.doesNotMatch(String(error), /AAAAC3Nza|not-an-ssh-public-key/u);
        return /not a valid Ed25519 public key/u.test(String(error));
      },
    );
  }

  await writeFile(paths.publicKey, `${PUBLIC_KEY} stored CRLF comment\r\n`, { mode: 0o600 });
  await ensureFixtureState(paths, stagingRunner([]));
  for (const storedPublicKey of [
    `${PUBLIC_KEY} first comment\n${PUBLIC_KEY} second key\n`,
    `\n${PUBLIC_KEY} leading blank line\n`,
    `${PUBLIC_KEY} doubled terminal LF\n\n`,
    `${PUBLIC_KEY} doubled terminal CRLF\r\n\r\n`,
  ]) {
    await writeFile(paths.publicKey, storedPublicKey, { mode: 0o600 });
    await assert.rejects(ensureFixtureState(paths, stagingRunner([])), /not a valid Ed25519 public key/u);
  }
});

test("fails closed for missing or mismatched public keys without returning key material", async (t) => {
  const missing = resolveFixturePaths(await temporaryRepository(t));
  await mkdir(dirname(missing.privateKey), { recursive: true, mode: 0o700 });
  await chmod(missing.stateDir, 0o700);
  await chmod(dirname(missing.privateKey), 0o700);
  await writeFile(missing.privateKey, "opaque-test-private-key", { mode: 0o600 });
  await assert.rejects(ensureFixtureState(missing, stagingRunner([])), /keypair is incomplete/u);

  const generatedMissing = resolveFixturePaths(await temporaryRepository(t));
  await assert.rejects(
    ensureFixtureState(generatedMissing, stagingRunner([], { createPublicKey: false })),
    /generated SSH keypair is incomplete/u,
  );
  await assert.rejects(lstat(generatedMissing.privateKey));
  await assert.rejects(lstat(generatedMissing.publicKey));
  await assertNoStagingDirectories(generatedMissing.stateDir);

  const mismatched = resolveFixturePaths(await temporaryRepository(t));
  await installExistingPair(mismatched);
  await assert.rejects(
    ensureFixtureState(mismatched, stagingRunner([], { derivedPublicKey: "ssh-ed25519 AAAADIFFERENT" })),
    (error: unknown) => {
      assert.doesNotMatch(String(error), /opaque-test-private-key|AAAAC3Nza|AAAADIFFERENT/u);
      return /does not match/u.test(String(error));
    },
  );
});

test("rejects symlinked, incorrectly owned, accessible, special, and hard-linked fixture state", async (t) => {
  const symlinkPaths = resolveFixturePaths(await temporaryRepository(t));
  const external = await mkdtemp(join(tmpdir(), "qiyan-ssh-external-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await mkdir(dirname(symlinkPaths.stateDir), { recursive: true });
  await symlink(external, symlinkPaths.stateDir, "dir");
  await assert.rejects(ensureFixtureState(symlinkPaths, stagingRunner([])), /state directory must not be a symbolic link/u);

  const modePaths = resolveFixturePaths(await temporaryRepository(t));
  await mkdir(modePaths.stateDir, { recursive: true, mode: 0o755 });
  await chmod(modePaths.stateDir, 0o755);
  await assert.rejects(ensureFixtureState(modePaths, stagingRunner([])), /state directory must have mode 0700/u);

  const uidPaths = resolveFixturePaths(await temporaryRepository(t));
  await mkdir(uidPaths.stateDir, { recursive: true, mode: 0o700 });
  const actualUid = (await lstat(uidPaths.stateDir)).uid;
  await assert.rejects(
    ensureFixtureState(uidPaths, stagingRunner([]), { currentUid: actualUid + 1 }),
    /must be owned by the current user/u,
  );

  const specialPaths = resolveFixturePaths(await temporaryRepository(t));
  await mkdir(dirname(specialPaths.privateKey), { recursive: true, mode: 0o700 });
  await chmod(specialPaths.stateDir, 0o700);
  await chmod(dirname(specialPaths.privateKey), 0o700);
  await mkdir(specialPaths.privateKey, { mode: 0o700 });
  await writeFile(specialPaths.publicKey, `${PUBLIC_KEY}\n`, { mode: 0o600 });
  await assert.rejects(ensureFixtureState(specialPaths, stagingRunner([])), /private key must be a regular file/u);

  const accessiblePaths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingPair(accessiblePaths);
  await chmod(accessiblePaths.privateKey, 0o640);
  await assert.rejects(ensureFixtureState(accessiblePaths, stagingRunner([])), /private key must not be group- or world-accessible/u);

  const hardLinkPaths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingPair(hardLinkPaths);
  await link(hardLinkPaths.publicKey, join(hardLinkPaths.stateDir, "second-public-link"));
  await assert.rejects(ensureFixtureState(hardLinkPaths, stagingRunner([])), /public key must have exactly one link/u);
});

test("rejects a symlink in the state directory parent", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  const external = await mkdtemp(join(tmpdir(), "qiyan-ssh-parent-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await symlink(external, dirname(paths.stateDir), "dir");
  await assert.rejects(ensureFixtureState(paths, stagingRunner([])), /state parent must not be a symbolic link/u);
});

test("requires an existing state parent to be owned and not group- or world-writable", async (t) => {
  const wrongOwnerPaths = resolveFixturePaths(await temporaryRepository(t));
  const wrongOwnerParent = dirname(wrongOwnerPaths.stateDir);
  await mkdir(wrongOwnerParent, { mode: 0o700 });
  const actualUid = (await lstat(wrongOwnerParent)).uid;
  await assert.rejects(
    ensureFixtureState(wrongOwnerPaths, stagingRunner([]), { currentUid: actualUid + 1 }),
    /state parent must be owned by the current user/u,
  );

  for (const mode of [0o770, 0o702]) {
    const writablePaths = resolveFixturePaths(await temporaryRepository(t));
    const writableParent = dirname(writablePaths.stateDir);
    await mkdir(writableParent, { mode });
    await chmod(writableParent, mode);
    await assert.rejects(
      ensureFixtureState(writablePaths, stagingRunner([])),
      /state parent must not be group- or world-writable/u,
    );
  }
});

test("removes a safe stale key staging directory before generating a complete pair", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await prepareEmptyState(paths);
  const stale = join(paths.stateDir, ".keygen-Ab12z9");
  await mkdir(stale, { mode: 0o700 });
  await writeFile(join(stale, "partial"), "not-secret", { mode: 0o600 });
  const restrictiveStale = join(paths.stateDir, ".keygen-Cd34x8");
  await mkdir(restrictiveStale, { mode: 0o700 });
  await chmod(restrictiveStale, 0o500);
  const abandonedLeaseTemporary = join(paths.stateDir, ".operation-lease-Ef56w7");
  await mkdir(abandonedLeaseTemporary, { mode: 0o700 });
  await chmod(abandonedLeaseTemporary, 0o500);

  await ensureFixtureState(paths, stagingRunner([]));

  await assertNoStagingDirectories(paths.stateDir);
  assert.deepEqual(await readdir(paths.stateDir), ["client-key"]);
});

test("rejects suspicious stale key staging entries without following or removing them", async (t) => {
  const symlinkPaths = resolveFixturePaths(await temporaryRepository(t));
  await prepareEmptyState(symlinkPaths);
  const external = await mkdtemp(join(tmpdir(), "qiyan-stale-stage-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  const staleSymlink = join(symlinkPaths.stateDir, ".keygen-Ab12z9");
  await symlink(external, staleSymlink, "dir");
  await assert.rejects(ensureFixtureState(symlinkPaths, stagingRunner([])), /stale SSH key staging entry must be a regular directory/u);
  assert.equal((await lstat(staleSymlink)).isSymbolicLink(), true);

  const specialPaths = resolveFixturePaths(await temporaryRepository(t));
  await prepareEmptyState(specialPaths);
  const staleSpecial = join(specialPaths.stateDir, ".keygen-Cd34x8");
  await writeFile(staleSpecial, "not-secret", { mode: 0o600 });
  await assert.rejects(ensureFixtureState(specialPaths, stagingRunner([])), /stale SSH key staging entry must be a regular directory/u);
  assert.equal((await lstat(staleSpecial)).isFile(), true);

  const modePaths = resolveFixturePaths(await temporaryRepository(t));
  await prepareEmptyState(modePaths);
  const staleWrongMode = join(modePaths.stateDir, ".keygen-Ef56w7");
  await mkdir(staleWrongMode, { mode: 0o755 });
  await chmod(staleWrongMode, 0o755);
  await assert.rejects(ensureFixtureState(modePaths, stagingRunner([])), /stale SSH key staging entry must have mode 0700/u);
  assert.equal((await lstat(staleWrongMode)).isDirectory(), true);
});

test("serializes concurrent fixture preparation without deleting the live staging directory", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  const gated = gatedStagingRunner();
  const first = ensureFixtureState(paths, gated.runner);
  await gated.entered;
  const liveStages = (await readdir(paths.stateDir)).filter((name) => /^\.keygen-[A-Za-z0-9]{6}$/u.test(name));
  assert.equal(liveStages.length, 1);

  let overlapError: unknown;
  try {
    await assert.rejects(ensureFixtureState(paths, stagingRunner([])), /SSH fixture operation already running/u);
    assert.deepEqual(
      (await readdir(paths.stateDir)).filter((name) => /^\.keygen-[A-Za-z0-9]{6}$/u.test(name)),
      liveStages,
    );
  } catch (error) {
    overlapError = error;
  } finally {
    gated.release();
    await first.catch(() => undefined);
  }
  if (overlapError !== undefined) throw overlapError;
  await first;
  await assert.rejects(lstat(operationLeasePath(paths)));
});

test("serializes SSH config writing behind active fixture preparation", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  const gated = gatedStagingRunner();
  const first = ensureFixtureState(paths, gated.runner);
  await gated.entered;

  let overlapError: unknown;
  try {
    await assert.rejects(writeSshConfig(paths), /SSH fixture operation already running/u);
    await assert.rejects(lstat(paths.sshConfig));
  } catch (error) {
    overlapError = error;
  } finally {
    gated.release();
    await first.catch(() => undefined);
  }
  if (overlapError !== undefined) throw overlapError;
  await first;
});

test("reclaims a verifiably stale operation lease and removes abandoned lease temporaries", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installOperationLease(paths, { pid: 2_147_483_647, startTime: "1" });
  const abandoned = join(paths.stateDir, ".operation-lease-Ab12z9");
  await mkdir(abandoned, { mode: 0o700 });
  await chmod(abandoned, 0o500);

  await ensureFixtureState(paths, stagingRunner([]));

  await assert.rejects(lstat(operationLeasePath(paths)));
  assert.equal((await readdir(paths.stateDir)).some((name) => name.startsWith(".operation-lease-")), false);
});

test("does not remove an operation lease owned by the current process identity", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  const owner = await readLinuxProcessIdentity(process.pid);
  const lease = await installOperationLease(paths, owner);
  const originalOwner = await readFile(join(lease, "owner.json"), "utf8");

  await assert.rejects(ensureFixtureState(paths, stagingRunner([])), /SSH fixture operation already running/u);

  assert.equal(await readFile(join(lease, "owner.json"), "utf8"), originalOwner);
});

test("fails closed for malformed or replaced operation leases", async (t) => {
  const malformedPaths = resolveFixturePaths(await temporaryRepository(t));
  const malformedLease = await installOperationLease(malformedPaths, "{not-json}\n");
  await assert.rejects(ensureFixtureState(malformedPaths, stagingRunner([])), /SSH fixture operation lease is invalid/u);
  assert.equal((await lstat(malformedLease)).isDirectory(), true);

  const replacedPaths = resolveFixturePaths(await temporaryRepository(t));
  await prepareEmptyState(replacedPaths);
  const external = await mkdtemp(join(tmpdir(), "qiyan-operation-lease-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  await symlink(external, operationLeasePath(replacedPaths), "dir");
  await assert.rejects(ensureFixtureState(replacedPaths, stagingRunner([])), /operation lease must not be a symbolic link/u);
  assert.equal((await lstat(operationLeasePath(replacedPaths))).isSymbolicLink(), true);
});

for (const runnerFailure of ["throw", "nonzero"] as const) {
  test(`cleans key staging state when ssh-keygen returns ${runnerFailure}`, async (t) => {
    const paths = resolveFixturePaths(await temporaryRepository(t));
    const runner: CommandRunner = async () => {
      if (runnerFailure === "throw") throw new Error("runner failure with no secret");
      return { code: 1, signal: null, stdout: "", stderr: "ignored" };
    };

    await assert.rejects(ensureFixtureState(paths, runner), /SSH key generation failed/u);
    await assertNoStagingDirectories(paths.stateDir);
    await assert.rejects(lstat(paths.privateKey));
    await assert.rejects(lstat(paths.publicKey));
  });
}

test("fails closed when the state directory is replaced during key generation", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  const displacedState = `${paths.stateDir}-displaced`;
  const baseRunner = stagingRunner([]);
  let replaced = false;
  const runner: CommandRunner = async (command, args, options) => {
    const result = await baseRunner(command, args, options);
    if (!replaced && command === "ssh-keygen" && !args.includes("-y")) {
      replaced = true;
      await rename(paths.stateDir, displacedState);
      await mkdir(paths.stateDir, { mode: 0o700 });
      const stagedPrivateKey = args[args.indexOf("-f") + 1];
      assert.ok(stagedPrivateKey);
      await mkdir(dirname(stagedPrivateKey), { mode: 0o700 });
      await baseRunner(command, args, options);
    }
    return result;
  };

  await assert.rejects(ensureFixtureState(paths, runner), /state directory.*replaced/u);
  await assert.rejects(lstat(paths.privateKey));
  await assert.rejects(lstat(paths.publicKey));
  await assert.rejects(lstat(paths.sshConfig));
});

test("fails before installation when the acquired operation lease is replaced", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  const displacedLease = join(paths.stateDir, ".operation-lease-displaced");
  const currentOwner = await readLinuxProcessIdentity(process.pid);
  const baseRunner = stagingRunner([]);
  let replaced = false;
  const runner: CommandRunner = async (command, args, options) => {
    const result = await baseRunner(command, args, options);
    if (!replaced && command === "ssh-keygen" && !args.includes("-y")) {
      replaced = true;
      await rename(operationLeasePath(paths), displacedLease);
      await mkdir(operationLeasePath(paths), { mode: 0o700 });
      await writeFile(
        join(operationLeasePath(paths), "owner.json"),
        `${JSON.stringify(currentOwner)}\n`,
        { mode: 0o600 },
      );
    }
    return result;
  };

  await assert.rejects(ensureFixtureState(paths, runner), /operation lease was replaced/u);
  await assert.rejects(lstat(paths.privateKey));
  await assert.rejects(lstat(paths.publicKey));
});

test("requires an existing atomic client key directory to remain private", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingPair(paths);
  await chmod(dirname(paths.privateKey), 0o755);
  await assert.rejects(ensureFixtureState(paths, stagingRunner([])), /client key directory must have mode 0700/u);
});

test("writes and replaces the SSH config atomically as an owner-only regular file", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await ensureFixtureState(paths, stagingRunner([]));

  await writeSshConfig(paths, 2222);
  assert.equal(await readFile(paths.sshConfig, "utf8"), formatSshConfig(paths, 2222));
  let metadata = await lstat(paths.sshConfig);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.nlink, 1);
  assert.equal(metadata.mode & 0o777, 0o600);

  await writeSshConfig(paths, 2200);
  assert.match(await readFile(paths.sshConfig, "utf8"), /^  Port 2200$/mu);
  metadata = await lstat(paths.sshConfig);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.deepEqual(await readdir(paths.stateDir), [
    "client-key",
    "config",
  ]);
});

test("config replacement rejects symlinks, special files, hard links, wrong modes, and wrong owners", async (t) => {
  const symlinkPaths = resolveFixturePaths(await temporaryRepository(t));
  await ensureFixtureState(symlinkPaths, stagingRunner([]));
  await symlink("missing", symlinkPaths.sshConfig);
  await assert.rejects(writeSshConfig(symlinkPaths), /SSH config must be a regular file/u);

  const specialPaths = resolveFixturePaths(await temporaryRepository(t));
  await ensureFixtureState(specialPaths, stagingRunner([]));
  await mkdir(specialPaths.sshConfig, { mode: 0o700 });
  await assert.rejects(writeSshConfig(specialPaths), /SSH config must be a regular file/u);

  const hardLinkPaths = resolveFixturePaths(await temporaryRepository(t));
  await ensureFixtureState(hardLinkPaths, stagingRunner([]));
  await writeFile(hardLinkPaths.sshConfig, "old", { mode: 0o600 });
  await link(hardLinkPaths.sshConfig, join(hardLinkPaths.stateDir, "config-link"));
  await assert.rejects(writeSshConfig(hardLinkPaths), /SSH config must have exactly one link/u);

  const modePaths = resolveFixturePaths(await temporaryRepository(t));
  await ensureFixtureState(modePaths, stagingRunner([]));
  await writeFile(modePaths.sshConfig, "old", { mode: 0o644 });
  await assert.rejects(writeSshConfig(modePaths), /SSH config must have mode 0600/u);

  const ownerPaths = resolveFixturePaths(await temporaryRepository(t));
  await ensureFixtureState(ownerPaths, stagingRunner([]));
  await writeFile(ownerPaths.sshConfig, "old", { mode: 0o600 });
  const actualUid = (await lstat(ownerPaths.sshConfig)).uid;
  await assert.rejects(
    writeSshConfig(ownerPaths, 2222, { currentUid: actualUid + 1 }),
    /must be owned by the current user/u,
  );
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  composeArgs,
  deriveComposeProjectName,
  downFixture,
  resetFixture,
  upFixture,
} from "../../scripts/ssh-worker-lifecycle.ts";
import {
  buildSshArgs,
  resolveFixturePaths,
  type CommandResult,
  type CommandRunner,
  type CommandRunnerOptions,
  type FixturePaths,
} from "../../scripts/ssh-worker-support.ts";

const CLIENT_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClientFixtureKey";
const HOST_KEY_A = "AAAAC3NzaC1lZDI1NTE5AAAAIHostFixtureKeyA";
const HOST_KEY_B = "AAAAC3NzaC1lZDI1NTE5AAAAIHostFixtureKeyB";
const SENTINEL_SECRET = "sentinel-environment-secret";
const RAW_STDERR = "raw-child-stderr-must-not-escape";

const EFFECTIVE_SSHD_CONFIG = [
  "port 22",
  "hostkey /var/lib/ssh-host-keys/ssh_host_ed25519_key",
  "authorizedkeysfile .ssh/authorized_keys",
  "pubkeyauthentication yes",
  "authenticationmethods publickey",
  "disableforwarding no",
  "allowtcpforwarding no",
  "allowstreamlocalforwarding local",
  "allowagentforwarding no",
  "x11forwarding no",
  "permittunnel no",
  "setenv CODEX_HOME=/home/codex/.codex",
  "permitrootlogin no",
  "passwordauthentication no",
  "kbdinteractiveauthentication no",
  "permitemptypasswords no",
  "usepam no",
  "",
].join("\n");

interface RunnerCall {
  command: string;
  args: string[];
  options: CommandRunnerOptions | undefined;
}

interface RunnerBehavior {
  composeVersion?: CommandResult | Error;
  composeUp?: CommandResult | Error;
  effectiveSshdConfig?: string;
  hostKeyFiles?: string;
  hostKey?: string;
  keyscanResult?: CommandResult | Error;
  hostKeyValidation?: CommandResult | Error;
  sshProof?: CommandResult | Error;
  beforeResult?: (call: RunnerCall) => Promise<void> | void;
}

function result(stdout = "", stderr = ""): CommandResult {
  return { code: 0, signal: null, stdout, stderr };
}

function failedResult(stderr = RAW_STDERR): CommandResult {
  return { code: 1, signal: null, stdout: "", stderr };
}

function cloneOptions(options: CommandRunnerOptions | undefined): CommandRunnerOptions | undefined {
  if (options === undefined) return undefined;
  return {
    ...(options.env === undefined ? {} : { env: { ...options.env } }),
    ...(options.inherit === undefined ? {} : { inherit: options.inherit }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
}

function lifecycleRunner(calls: RunnerCall[], behavior: RunnerBehavior = {}): CommandRunner {
  return async (command, readonlyArgs, options) => {
    const args = [...readonlyArgs];
    const call = { command, args, options: cloneOptions(options) };
    calls.push(call);
    await behavior.beforeResult?.(call);

    if (command === "ssh-keygen" && args.includes("-q")) {
      const keyPath = args.at(-1);
      assert.ok(keyPath);
      await writeFile(keyPath, "opaque-client-private-key", { mode: 0o600 });
      await writeFile(`${keyPath}.pub`, `${CLIENT_PUBLIC_KEY} qiyan-ssh-worker\n`, { mode: 0o644 });
      return result();
    }
    if (command === "ssh-keygen" && args.includes("-y")) {
      return result(`${CLIENT_PUBLIC_KEY} qiyan-ssh-worker\n`);
    }
    if (command === "ssh-keygen" && args.includes("-lf")) {
      const response = behavior.hostKeyValidation ?? result("256 SHA256:test fixture (ED25519)\n");
      if (response instanceof Error) throw response;
      return response;
    }
    if (command === "docker" && args.join(" ") === "compose version") {
      const response = behavior.composeVersion ?? result("Docker Compose version v2.test\n");
      if (response instanceof Error) throw response;
      return response;
    }
    if (command === "docker" && args.includes("up")) {
      const response = behavior.composeUp ?? result();
      if (response instanceof Error) throw response;
      return response;
    }
    if (command === "docker" && args.includes("/usr/sbin/sshd")) {
      return result(behavior.effectiveSshdConfig ?? EFFECTIVE_SSHD_CONFIG);
    }
    if (command === "docker" && args.includes("find")) {
      return result(behavior.hostKeyFiles ?? "");
    }
    if (command === "docker" && args.includes("down")) return result();
    if (command === "ssh-keyscan") {
      const response = behavior.keyscanResult
        ?? result(`[127.0.0.1]:2222 ssh-ed25519 ${behavior.hostKey ?? HOST_KEY_A}\n`);
      if (response instanceof Error) throw response;
      return response;
    }
    if (command === "ssh") {
      const response = behavior.sshProof ?? result();
      if (response instanceof Error) throw response;
      return response;
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

async function temporaryRepository(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-ssh-worker-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

async function installExistingClientKey(paths: FixturePaths): Promise<void> {
  await mkdir(dirname(paths.privateKey), { recursive: true, mode: 0o700 });
  await chmod(paths.stateDir, 0o700);
  await chmod(dirname(paths.privateKey), 0o700);
  await writeFile(paths.privateKey, "opaque-client-private-key", { mode: 0o600 });
  await writeFile(paths.publicKey, `${CLIENT_PUBLIC_KEY} qiyan-ssh-worker\n`, { mode: 0o600 });
}

function fixtureEnvironment(paths: FixturePaths, port = 2222, codexVersion = "0.142.5") {
  return {
    PATH: "/test/bin",
    SENTINEL_SECRET,
    QIYAN_SSH_WORKER_PUBLIC_KEY: paths.publicKey,
    QIYAN_SSH_WORKER_PORT: String(port),
    QIYAN_SSH_WORKER_CODEX_VERSION: codexVersion,
  };
}

function assertSafeError(error: unknown): void {
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, new RegExp(`${SENTINEL_SECRET}|${RAW_STDERR}|${HOST_KEY_A}|${HOST_KEY_B}`, "u"));
}

async function assertSafeRejection(promise: Promise<unknown>, expected: RegExp): Promise<void> {
  try {
    await promise;
    assert.fail("expected operation to reject");
  } catch (error) {
    assertSafeError(error);
    assert.match((error as Error).message, expected);
  }
}

function composeExecSshdArgs(paths: FixturePaths): string[] {
  return composeArgs(paths, [
    "exec",
    "--no-TTY",
    "--user",
    "root",
    "ssh-worker",
    "/usr/sbin/sshd",
    "-T",
    "-f",
    "/etc/ssh/sshd_config",
    "-C",
    "user=codex,host=localhost,addr=127.0.0.1",
  ]);
}

function composeExecHostKeyAbsenceArgs(paths: FixturePaths): string[] {
  return composeArgs(paths, [
    "exec",
    "--no-TTY",
    "--user",
    "root",
    "ssh-worker",
    "find",
    "/etc/ssh",
    "-maxdepth",
    "1",
    "-name",
    "ssh_host_*",
    "-print",
    "-quit",
  ]);
}

test("derives a stable checkout-specific Compose project name", async (t) => {
  const root = await temporaryRepository(t);
  const otherRoot = await temporaryRepository(t);
  const paths = resolveFixturePaths(root);
  const expectedSuffix = createHash("sha256").update(root).digest("hex").slice(0, 12);

  assert.equal(deriveComposeProjectName(paths), `qiyan-ssh-worker-${expectedSuffix}`);
  assert.notEqual(deriveComposeProjectName(paths), deriveComposeProjectName(resolveFixturePaths(otherRoot)));
  assert.deepEqual(composeArgs(paths, ["up", "--detach", "--build"]), [
    "compose",
    "--project-name",
    `qiyan-ssh-worker-${expectedSuffix}`,
    "--file",
    paths.composeFile,
    "up",
    "--detach",
    "--build",
  ]);
});

test("starts the fixture with exact bounded commands, private trust state, and strict SSH proof", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  const calls: RunnerCall[] = [];
  const runner = lifecycleRunner(calls);
  const env = { PATH: "/test/bin", SENTINEL_SECRET };

  await upFixture(paths, { runner, env, now: () => 0, sleep: async () => {} });

  assert.deepEqual(calls.map(({ command }) => command), [
    "docker",
    "ssh-keygen",
    "ssh-keygen",
    "docker",
    "docker",
    "docker",
    "ssh-keyscan",
    "ssh-keygen",
    "ssh",
  ]);
  assert.deepEqual(calls[0]?.args, ["compose", "version"]);
  assert.deepEqual(calls[3]?.args, composeArgs(paths, ["up", "--detach", "--build"]));
  assert.deepEqual(calls[4]?.args, composeExecSshdArgs(paths));
  assert.deepEqual(calls[5]?.args, composeExecHostKeyAbsenceArgs(paths));
  assert.deepEqual(calls[6]?.args, ["-T", "1", "-t", "ed25519", "-p", "2222", "127.0.0.1"]);
  const candidatePath = calls[7]?.args[1];
  assert.ok(candidatePath?.startsWith(`${paths.stateDir}/.host-key-candidate-`));
  assert.deepEqual(calls[7]?.args, ["-lf", candidatePath, "-E", "sha256"]);
  assert.deepEqual(calls[8]?.args, buildSshArgs(paths, ["true"]));
  assert.equal(calls[8]?.options?.timeoutMs, 10_000);
  for (const call of calls) {
    assert.ok(call.options?.timeoutMs !== undefined && call.options.timeoutMs > 0, `${call.command} is bounded`);
  }
  for (const call of calls.filter(({ command }) => command === "docker")) {
    assert.deepEqual(call.options?.env, fixtureEnvironment(paths));
  }
  assert.equal(await readFile(paths.trustedHostKey, "utf8"), `ssh-ed25519 ${HOST_KEY_A}\n`);
  assert.equal(await readFile(paths.knownHosts, "utf8"), `[127.0.0.1]:2222 ssh-ed25519 ${HOST_KEY_A}\n`);
  assert.match(await readFile(paths.sshConfig, "utf8"), /StrictHostKeyChecking yes/u);
  for (const path of [paths.privateKey, paths.publicKey, paths.trustedHostKey, paths.knownHosts, paths.sshConfig]) {
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
  }
  assert.equal((await readdir(paths.stateDir)).some((name) => name.startsWith(".host-key-candidate-")), false);
});

test("holds one state lease from client-key validation through Compose startup", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingClientKey(paths);
  const leasePath = join(paths.stateDir, ".operation-lease");
  const observedInodes: number[] = [];
  const runner = lifecycleRunner([], {
    beforeResult: async ({ command, args }) => {
      if ((command === "ssh-keygen" && args.includes("-y")) || (command === "docker" && args.includes("up"))) {
        observedInodes.push((await lstat(leasePath)).ino);
      }
    },
  });

  await upFixture(paths, { runner, now: () => 0, sleep: async () => {} });

  assert.equal(observedInodes.length, 2);
  assert.equal(observedInodes[0], observedInodes[1]);
});

test("validates the port and exact three-component Codex version before dispatch", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  for (const port of [0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const calls: RunnerCall[] = [];
    await assert.rejects(
      upFixture(paths, { runner: lifecycleRunner(calls), port }),
      /SSH port must be an integer from 1 through 65535/u,
    );
    assert.equal(calls.length, 0);
  }
  for (const codexVersion of ["0.142", "v0.142.5", "0.142.5-beta", "0.142.5.1", " 0.142.5"] ) {
    const calls: RunnerCall[] = [];
    await assert.rejects(
      upFixture(paths, { runner: lifecycleRunner(calls), codexVersion }),
      /Codex version must contain exactly three decimal components/u,
    );
    assert.equal(calls.length, 0);
  }
});

test("retains identical authoritative trust and rewrites only address state for a changed port", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingClientKey(paths);
  const firstCalls: RunnerCall[] = [];
  await upFixture(paths, {
    runner: lifecycleRunner(firstCalls),
    env: { PATH: "/test/bin", SENTINEL_SECRET },
    now: () => 0,
    sleep: async () => {},
  });
  const trustedBefore = await lstat(paths.trustedHostKey);

  const secondCalls: RunnerCall[] = [];
  await upFixture(paths, {
    runner: lifecycleRunner(secondCalls, {
      keyscanResult: result(`[127.0.0.1]:2223 ssh-ed25519 ${HOST_KEY_A}\n`),
    }),
    port: 2223,
    env: { PATH: "/test/bin", SENTINEL_SECRET },
    now: () => 0,
    sleep: async () => {},
  });

  const trustedAfter = await lstat(paths.trustedHostKey);
  assert.equal(trustedAfter.ino, trustedBefore.ino);
  assert.equal(trustedAfter.mtimeMs, trustedBefore.mtimeMs);
  assert.equal(await readFile(paths.trustedHostKey, "utf8"), `ssh-ed25519 ${HOST_KEY_A}\n`);
  assert.equal(await readFile(paths.knownHosts, "utf8"), `[127.0.0.1]:2223 ssh-ed25519 ${HOST_KEY_A}\n`);
  assert.match(await readFile(paths.sshConfig, "utf8"), /Port 2223/u);
  for (const call of secondCalls.filter(({ command }) => command === "docker")) {
    assert.deepEqual(call.options?.env, fixtureEnvironment(paths, 2223));
  }
});

test("rejects a changed host key without overwriting either trust file", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingClientKey(paths);
  await upFixture(paths, {
    runner: lifecycleRunner([]),
    now: () => 0,
    sleep: async () => {},
  });
  const trustedBefore = await readFile(paths.trustedHostKey);
  const knownBefore = await readFile(paths.knownHosts);

  await assertSafeRejection(upFixture(paths, {
    runner: lifecycleRunner([], { hostKey: HOST_KEY_B }),
    env: { PATH: "/test/bin", SENTINEL_SECRET },
    now: () => 0,
    sleep: async () => {},
  }), /SSH host key changed/u);
  assert.deepEqual(await readFile(paths.trustedHostKey), trustedBefore);
  assert.deepEqual(await readFile(paths.knownHosts), knownBefore);
});

test("fails closed when known_hosts exists without authoritative trust", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingClientKey(paths);
  const known = `[127.0.0.1]:2222 ssh-ed25519 ${HOST_KEY_A}\n`;
  await writeFile(paths.knownHosts, known, { mode: 0o600 });

  await assertSafeRejection(upFixture(paths, {
    runner: lifecycleRunner([]),
    env: { PATH: "/test/bin", SENTINEL_SECRET },
    now: () => 0,
    sleep: async () => {},
  }), /known_hosts exists without authoritative SSH host trust/u);
  assert.equal(await readFile(paths.knownHosts, "utf8"), known);
  await assert.rejects(lstat(paths.trustedHostKey));
  await assert.rejects(lstat(paths.sshConfig));
});

test("bounds host readiness polling with the injected clock and sleeper", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingClientKey(paths);
  const calls: RunnerCall[] = [];
  let now = 0;

  await assertSafeRejection(upFixture(paths, {
    runner: lifecycleRunner(calls, { keyscanResult: failedResult() }),
    env: { PATH: "/test/bin", SENTINEL_SECRET },
    now: () => now,
    sleep: async (milliseconds) => { now += Math.max(milliseconds, 10_000); },
  }), /SSH worker readiness timed out after 30 seconds/u);
  assert.equal(calls.filter(({ command }) => command === "ssh-keyscan").length, 3);
  assert.equal(calls.some(({ args }) => args.includes("down")), false);
  assert.equal((await readdir(paths.stateDir)).some((name) => name.startsWith(".host-key-candidate-")), false);
});

test("maps candidate fingerprint rejection to a redacted host-key validation error", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingClientKey(paths);
  await assertSafeRejection(upFixture(paths, {
    runner: lifecycleRunner([], { hostKeyValidation: failedResult() }),
    env: { PATH: "/test/bin", SENTINEL_SECRET },
    now: () => 0,
    sleep: async () => {},
  }), /SSH host key validation failed/u);
  assert.equal((await readdir(paths.stateDir)).some((name) => name.startsWith(".host-key-candidate-")), false);
});

test("rejects an effective sshd policy mismatch before scanning a host key", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingClientKey(paths);
  const calls: RunnerCall[] = [];
  await assertSafeRejection(upFixture(paths, {
    runner: lifecycleRunner(calls, {
      effectiveSshdConfig: EFFECTIVE_SSHD_CONFIG.replace("allowstreamlocalforwarding local", "allowstreamlocalforwarding no"),
    }),
    env: { PATH: "/test/bin", SENTINEL_SECRET },
  }), /SSH daemon effective configuration mismatch/u);
  assert.equal(calls.some(({ command }) => command === "ssh-keyscan"), false);
});

test("rejects container host keys outside the persistent volume", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingClientKey(paths);
  const calls: RunnerCall[] = [];
  await assertSafeRejection(upFixture(paths, {
    runner: lifecycleRunner(calls, { hostKeyFiles: "/etc/ssh/ssh_host_ed25519_key\n" }),
    env: { PATH: "/test/bin", SENTINEL_SECRET },
  }), /SSH daemon host-key isolation check failed/u);
  assert.equal(calls.some(({ command }) => command === "ssh-keyscan"), false);
});

test("maps missing Compose, startup failure, and likely port conflicts separately without leaking diagnostics", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  const cases: Array<readonly [RunnerBehavior, RegExp]> = [
    [{ composeVersion: new Error(`${RAW_STDERR} ${SENTINEL_SECRET}`) }, /Docker Compose is not available/u],
    [{ composeUp: failedResult() }, /SSH worker image build or startup failed/u],
    [{ composeUp: failedResult(`Bind for 127.0.0.1:2222 failed: port is already allocated ${RAW_STDERR}`) }, /SSH worker port is already in use/u],
  ];
  for (const [behavior, expected] of cases) {
    await assertSafeRejection(upFixture(paths, {
      runner: lifecycleRunner([], behavior),
      env: { PATH: "/test/bin", SENTINEL_SECRET },
      now: () => 0,
      sleep: async () => {},
    }), expected);
  }
});

test("preserves pinned state and maps strict SSH rejection without raw output", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingClientKey(paths);
  await assertSafeRejection(upFixture(paths, {
    runner: lifecycleRunner([], { sshProof: failedResult() }),
    env: { PATH: "/test/bin", SENTINEL_SECRET },
    now: () => 0,
    sleep: async () => {},
  }), /SSH client key was rejected/u);
  assert.equal(await readFile(paths.trustedHostKey, "utf8"), `ssh-ed25519 ${HOST_KEY_A}\n`);
  assert.equal(await readFile(paths.knownHosts, "utf8"), `[127.0.0.1]:2222 ssh-ed25519 ${HOST_KEY_A}\n`);
});

test("stops the checkout-specific fixture without deleting volumes", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  const calls: RunnerCall[] = [];
  await downFixture(paths, {
    runner: lifecycleRunner(calls),
    port: 2201,
    codexVersion: "1.2.3",
    env: { PATH: "/test/bin", SENTINEL_SECRET },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, composeArgs(paths, ["down"]));
  assert.equal(calls[0]?.args.includes("--volumes"), false);
  assert.deepEqual(calls[0]?.options?.env, fixtureEnvironment(paths, 2201, "1.2.3"));
  assert.ok((calls[0]?.options?.timeoutMs ?? 0) > 0);
});

test("reset requires confirmation, uses only the checkout project, and leaves a private empty state directory", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  const otherPaths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingClientKey(paths);
  await writeFile(paths.trustedHostKey, `ssh-ed25519 ${HOST_KEY_A}\n`, { mode: 0o600 });
  await writeFile(paths.knownHosts, `[127.0.0.1]:2222 ssh-ed25519 ${HOST_KEY_A}\n`, { mode: 0o600 });
  await installExistingClientKey(otherPaths);
  const calls: RunnerCall[] = [];
  const runner = lifecycleRunner(calls);

  assert.deepEqual(await resetFixture(paths, { runner, confirmed: false }), {
    reset: false,
    stateDirectoryRetained: true,
  });
  assert.equal(calls.length, 0);
  assert.ok((await lstat(paths.privateKey)).isFile());

  assert.deepEqual(await resetFixture(paths, {
    runner,
    confirmed: true,
    env: { PATH: "/test/bin", SENTINEL_SECRET },
  }), { reset: true, stateDirectoryRetained: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, composeArgs(paths, ["down", "--volumes", "--remove-orphans"]));
  assert.deepEqual(await readdir(paths.stateDir), []);
  assert.equal((await lstat(paths.stateDir)).mode & 0o777, 0o700);
  assert.ok((await lstat(otherPaths.privateKey)).isFile());
});

test("reset validates the complete local state before deleting Docker volumes", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingClientKey(paths);
  await writeFile(join(paths.stateDir, "unexpected-state"), "do-not-delete", { mode: 0o600 });
  const calls: RunnerCall[] = [];

  await assert.rejects(
    resetFixture(paths, { runner: lifecycleRunner(calls), confirmed: true }),
    /unexpected files/u,
  );

  assert.equal(calls.some(({ args }) => args.includes("--volumes")), false);
  assert.equal(await readFile(join(paths.stateDir, "unexpected-state"), "utf8"), "do-not-delete");
});

test("reset rejects incorrectly permissioned managed state before deleting Docker volumes", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingClientKey(paths);
  await writeFile(paths.trustedHostKey, `ssh-ed25519 ${HOST_KEY_A}\n`, { mode: 0o600 });
  await chmod(paths.trustedHostKey, 0o400);
  const calls: RunnerCall[] = [];

  await assert.rejects(
    resetFixture(paths, { runner: lifecycleRunner(calls), confirmed: true }),
    /trusted host key.*mode 0600/u,
  );

  assert.equal(calls.some(({ args }) => args.includes("--volumes")), false);
  assert.equal(await readFile(paths.trustedHostKey, "utf8"), `ssh-ed25519 ${HOST_KEY_A}\n`);
});

test("an interrupted reset leaves a durable intent that blocks startup and resumes safely", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingClientKey(paths);
  const interruption = join(paths.stateDir, "unexpected-after-docker-reset");
  const resetIntent = join(paths.stateDir, ".reset-intent.json");
  const failingRunner = lifecycleRunner([], {
    beforeResult: async ({ command, args }) => {
      if (command === "docker" && args.includes("--volumes")) {
        await writeFile(interruption, "simulated crash boundary", { mode: 0o600 });
      }
    },
  });

  await assert.rejects(
    resetFixture(paths, { runner: failingRunner, confirmed: true }),
    /unexpected files/u,
  );
  assert.equal(await readFile(resetIntent, "utf8"), '{"version":1}\n');
  await assert.rejects(
    upFixture(paths, { runner: lifecycleRunner([]), now: () => 0, sleep: async () => {} }),
    /reset is incomplete/u,
  );

  await rm(interruption);
  assert.deepEqual(await resetFixture(paths, {
    runner: lifecycleRunner([]),
    confirmed: true,
  }), { reset: true, stateDirectoryRetained: true });
  assert.deepEqual(await readdir(paths.stateDir), []);
});

test("reset fails instead of racing an active lifecycle trust transaction", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  await installExistingClientKey(paths);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { entered = resolve; });
  const calls: RunnerCall[] = [];
  const runner = lifecycleRunner(calls, {
    beforeResult: async ({ command, args }) => {
      if (command === "docker" && args.includes("up")) {
        entered();
        await gate;
      }
    },
  });

  const starting = upFixture(paths, { runner, now: () => 0, sleep: async () => {} });
  await blocked;
  await assert.rejects(
    resetFixture(paths, { runner, confirmed: true }),
    /SSH fixture operation already running/u,
  );
  assert.equal(calls.filter(({ args }) => args.includes("--volumes")).length, 0);
  release();
  await starting;
});

test("rejects forged lifecycle paths before any command runs", async (t) => {
  const paths = resolveFixturePaths(await temporaryRepository(t));
  const forged = { ...paths, composeFile: join(paths.repositoryRoot, "attacker-compose.yaml") };
  const calls: RunnerCall[] = [];
  await assert.rejects(
    downFixture(forged, { runner: lifecycleRunner(calls) }),
    /fixture paths do not match the canonical repository root/u,
  );
  assert.equal(calls.length, 0);
});

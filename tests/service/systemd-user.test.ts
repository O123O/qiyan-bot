import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import {
  buildServiceEffectiveEnvironment,
  MANAGED_UNIT_MARKER,
  NodeSystemdUnitStore,
  readServiceMainPid,
  SystemdUserService,
  renderSystemdUserUnit,
  type SystemdRunner,
} from "../../src/service/systemd-user.ts";

test("readServiceMainPid parses --value; non-running and spawn failure ⇒ undefined (never throws)", async () => {
  assert.equal(await readServiceMainPid(process.env, async () => ({ code: 0, signal: null, stdout: "12345\n" })), 12345);
  assert.equal(await readServiceMainPid(process.env, async () => ({ code: 0, signal: null, stdout: "0\n" })), undefined, "MainPID=0 ⇒ not running");
  assert.equal(await readServiceMainPid(process.env, async () => ({ code: 0, signal: null, stdout: "\n" })), undefined, "empty ⇒ undefined");
  assert.equal(await readServiceMainPid(process.env, async () => ({ code: 4, signal: null, stdout: "" })), undefined, "non-zero ⇒ undefined");
  assert.equal(await readServiceMainPid(process.env, async () => ({ code: null, signal: "SIGTERM", stdout: "" })), undefined, "killed ⇒ undefined");
  assert.equal(await readServiceMainPid(process.env, async () => { throw new Error("systemctl not found"); }), undefined, "spawn failure ⇒ undefined");
});

test("renders a secret-free foreground user unit with safely quoted paths", () => {
  const base = {
    nodeExecutable: "/usr/bin/node",
    executable: "/bin/qiyan",
    qiyanHome: "/home/user/.qiyan-bot",
    path: "/home/user/.local/bin:/usr/local/bin:/usr/bin",
    host: "build-host.example.com",
  };
  const unit = renderSystemdUserUnit({
    nodeExecutable: "/home/user/Node Runtime/node%24",
    executable: "/home/user/My Bin/qiyan%bot",
    qiyanHome: "/home/user/QiYan Home",
    path: "/home/user/My Bin:/opt/tool%kit/bin:/usr/bin",
    host: "render-host.example.net",
  });
  assert.match(unit, new RegExp(`^${MANAGED_UNIT_MARKER.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\n`, "u"));
  assert.match(unit, /Type=simple/u);
  assert.match(unit, /WorkingDirectory=\/home\/user\/QiYan Home/u);
  assert.doesNotMatch(unit, /WorkingDirectory="/u);
  assert.match(unit, /ExecStart="\/home\/user\/Node Runtime\/node%%24" "\/home\/user\/My Bin\/qiyan%%bot" --home "\/home\/user\/QiYan Home"/u);
  assert.match(unit, /^Environment="PATH=\/home\/user\/My Bin:\/opt\/tool%%kit\/bin:\/usr\/bin"$/mu);
  assert.match(unit, /Restart=on-failure/u);
  assert.match(unit, /TimeoutStopSec=30s/u);
  assert.match(unit, /UMask=0077/u);
  assert.match(unit, /^ConditionHost=render-host\.example\.net$/mu);
  assert.doesNotMatch(unit, /EnvironmentFile|TOKEN=|auth\.json/u);
  for (const host of ["", "bad host", "host\nConditionHost=evil", "host$", "omniml-*", "a".repeat(254)]) {
    assert.throws(() => renderSystemdUserUnit({ ...base, host }), /host/u);
  }
  assert.throws(() => renderSystemdUserUnit({ ...base, nodeExecutable: "relative" }), /absolute/u);
  assert.throws(() => renderSystemdUserUnit({ ...base, executable: "relative" }), /absolute/u);
  assert.throws(() => renderSystemdUserUnit({ ...base, executable: "/bin/qiyan\nExecStart=/bin/evil" }), /unsupported characters/u);
  assert.throws(() => renderSystemdUserUnit({ ...base, executable: "/home/user/$work/qiyan-bot" }), /unsupported characters/u);
  for (const path of ["", "/usr/bin::/bin", "relative:/usr/bin", "/usr/../bin", "/usr/bin\nEnvironment=EVIL=1"]) {
    assert.throws(() => renderSystemdUserUnit({ ...base, path }), /PATH/u);
  }
  assert.throws(
    () => renderSystemdUserUnit({ ...base, path: `/${"%".repeat(32 * 1024 - 1)}` }),
    /(?:PATH|unit).*too large/iu,
  );
});

test("service-effective validation removes every environment value unset by the unit", () => {
  assert.deepEqual(buildServiceEffectiveEnvironment({
    HOME: "/home/user",
    PATH: "/bin",
    QIYAN_HOME: "/shell-only/home",
    TELEGRAM_BOT_TOKEN: "secret-token",
    ASSISTANT_WORKDIR: "/shell-only/workdir",
    SLACK_TEAM_ID: "derived-or-retained",
  }), {
    HOME: "/home/user",
    PATH: "/bin",
    SLACK_TEAM_ID: "derived-or-retained",
  });
});

test("installs, controls, and reports one user service with fixed systemctl arguments", async () => {
  const calls: string[][] = [];
  const journalCalls: string[][] = [];
  const writes: Array<{ path: string; contents: string }> = [];
  const removals: string[] = [];
  const runner: SystemdRunner = async (args) => {
    calls.push([...args]);
    if (args[0] === "is-active") return { code: 0, signal: null, stdout: "active\n" };
    if (args[0] === "is-enabled") return { code: 0, signal: null, stdout: "enabled\n" };
    return { code: 0, signal: null, stdout: "" };
  };
  const service = new SystemdUserService({
    userHome: "/home/user",
    nodeExecutable: "/usr/bin/node",
    executable: "/home/user/.local/bin/qiyan-bot",
    host: "install-host.example.org",
    env: { PATH: "/home/user/.local/bin:/opt/user tools/bin:/usr/bin" },
    runner,
    journalRunner: async (args) => { journalCalls.push([...args]); return { code: 0, signal: null, stdout: "safe journal output\n" }; },
    unitStore: {
      withOperationLease: async (operation) => operation(),
      install: async (path, contents) => { writes.push({ path, contents }); },
      verifyManaged: async () => true,
      remove: async (path) => { removals.push(path); },
    },
  });

  assert.equal(await service.execute("install", { qiyanHome: "/home/user/.qiyan-bot" }), "Installed and started qiyan-bot.service.\n");
  assert.equal(await service.execute("start"), "Started qiyan-bot.service.\n");
  assert.equal(await service.execute("stop"), "Stopped qiyan-bot.service.\n");
  assert.equal(await service.execute("restart"), "Restarted qiyan-bot.service.\n");
  assert.equal(await service.execute("status"), "qiyan-bot.service is active and enabled.\nRecent logs: qiyan-bot service logs\n");
  assert.equal(await service.execute("logs"), "safe journal output\n");
  assert.equal(await service.execute("uninstall"), "Stopped and removed qiyan-bot.service.\n");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.path, "/home/user/.config/systemd/user/qiyan-bot.service");
  assert.match(writes[0]?.contents ?? "", /ExecStart="\/usr\/bin\/node" "\/home\/user\/\.local\/bin\/qiyan-bot"/u);
  assert.match(writes[0]?.contents ?? "", /^ConditionHost=install-host\.example\.org$/mu);
  assert.match(writes[0]?.contents ?? "", /^Environment="PATH=\/home\/user\/\.local\/bin:\/opt\/user tools\/bin:\/usr\/bin"$/mu);
  assert.deepEqual(removals, ["/home/user/.config/systemd/user/qiyan-bot.service"]);
  assert.deepEqual(journalCalls, [["--user", "--unit", "qiyan-bot.service", "--lines", "100", "--no-pager", "--output", "short-iso"]]);
  assert.deepEqual(calls, [
    ["daemon-reload"],
    ["enable", "qiyan-bot.service"],
    ["restart", "qiyan-bot.service"],
    ["start", "qiyan-bot.service"],
    ["stop", "qiyan-bot.service"],
    ["restart", "qiyan-bot.service"],
    ["is-active", "qiyan-bot.service"],
    ["is-enabled", "qiyan-bot.service"],
    ["disable", "--now", "qiyan-bot.service"],
    ["daemon-reload"],
  ]);
});

test("service install rejects a missing or unsafe terminal PATH before acquiring its real filesystem lease", async (context) => {
  for (const path of [undefined, "", "relative:/usr/bin", "/usr/bin::/bin"]) {
    const userHome = await mkdtemp(join(tmpdir(), "qiyan-systemd-invalid-path-"));
    context.after(() => rm(userHome, { recursive: true, force: true }));
    await chmod(userHome, 0o700);
    let systemctlCalls = 0;
    const service = new SystemdUserService({
      userHome,
      nodeExecutable: "/usr/bin/node",
      executable: join(userHome, ".local/bin/qiyan-bot"),
      env: path === undefined ? {} : { PATH: path },
      runner: async () => { systemctlCalls += 1; throw new Error("systemctl must not run"); },
    });
    await assert.rejects(service.execute("install", { qiyanHome: join(userHome, ".qiyan-bot") }), /PATH/u);
    assert.equal(systemctlCalls, 0);
    await assert.rejects(lstat(join(userHome, ".config")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  }
});

test("systemctl failures are actionable without returning command output", async () => {
  const service = new SystemdUserService({
    userHome: "/home/user",
    nodeExecutable: "/usr/bin/node",
    executable: "/home/user/.local/bin/qiyan-bot",
    runner: async () => ({ code: 1, signal: null, stdout: "secret-token\n" }),
    unitStore: { withOperationLease: async (operation) => operation(), install: async () => undefined, verifyManaged: async () => true, remove: async () => undefined },
  });
  await assert.rejects(
    service.execute("start"),
    (error: unknown) => error instanceof AppError
      && error.code === "CONFIGURATION_ERROR"
      && error.message === "systemctl --user start qiyan-bot.service failed with status 1",
  );
});

test("read-only status and logs remain available when a stale operation lock exists", async () => {
  let leaseCalls = 0;
  const service = new SystemdUserService({
    userHome: "/home/user",
    nodeExecutable: "/usr/bin/node",
    executable: "/home/user/.local/bin/qiyan-bot",
    runner: async (args) => args[0] === "is-active"
      ? { code: 0, signal: null, stdout: "active\n" }
      : { code: 0, signal: null, stdout: "enabled\n" },
    journalRunner: async () => ({ code: 0, signal: null, stdout: "recent\n" }),
    unitStore: {
      withOperationLease: async () => { leaseCalls += 1; throw new Error("stale lock"); },
      install: async () => undefined,
      verifyManaged: async () => true,
      remove: async () => undefined,
    },
  });
  assert.match(await service.execute("status"), /active and enabled/u);
  assert.equal(await service.execute("logs"), "recent\n");
  assert.equal(leaseCalls, 0);
});

test("status rejects an unrecognized failed probe instead of reporting unknown health", async () => {
  const service = new SystemdUserService({
    userHome: "/home/user",
    nodeExecutable: "/usr/bin/node",
    executable: "/home/user/.local/bin/qiyan-bot",
    runner: async () => ({ code: 1, signal: null, stdout: "secret-token\n" }),
    unitStore: { withOperationLease: async (operation) => operation(), install: async () => undefined, verifyManaged: async () => true, remove: async () => undefined },
  });
  await assert.rejects(
    service.execute("status"),
    (error: unknown) => error instanceof AppError
      && error.message === "systemctl --user is-active qiyan-bot.service failed with status 1",
  );
});

test("status reports documented nonzero systemd enabled states", async () => {
  const service = new SystemdUserService({
    userHome: "/home/user",
    nodeExecutable: "/usr/bin/node",
    executable: "/home/user/.local/bin/qiyan-bot",
    runner: async (args) => args[0] === "is-active"
      ? { code: 3, signal: null, stdout: "inactive\n" }
      : { code: 1, signal: null, stdout: "masked-runtime\n" },
    unitStore: { withOperationLease: async (operation) => operation(), install: async () => undefined, verifyManaged: async () => true, remove: async () => undefined },
  });
  assert.equal(await service.execute("status"), "qiyan-bot.service is inactive and masked-runtime.\nRecent logs: qiyan-bot service logs\n");
});

test("uninstall is idempotent and reloads systemd after an already-removed unit", async () => {
  const calls: string[][] = [];
  const service = new SystemdUserService({
    userHome: "/home/user",
    nodeExecutable: "/usr/bin/node",
    executable: "/home/user/.local/bin/qiyan-bot",
    runner: async (args) => { calls.push([...args]); return { code: 0, signal: null, stdout: "" }; },
    unitStore: {
      withOperationLease: async (operation) => operation(),
      install: async () => undefined,
      verifyManaged: async () => false,
      remove: async () => { throw new Error("must not remove"); },
    },
  });
  assert.equal(await service.execute("uninstall"), "qiyan-bot.service is not installed.\n");
  assert.deepEqual(calls, [["daemon-reload"]]);
});

test("uninstall verifies unit ownership before changing systemd state", async () => {
  const calls: string[][] = [];
  const service = new SystemdUserService({
    userHome: "/home/user",
    nodeExecutable: "/usr/bin/node",
    executable: "/home/user/.local/bin/qiyan-bot",
    runner: async (args) => { calls.push([...args]); return { code: 0, signal: null, stdout: "" }; },
    unitStore: {
      withOperationLease: async (operation) => operation(),
      install: async () => undefined,
      verifyManaged: async () => { throw new AppError("CONFIGURATION_ERROR", "unit is not managed by qiyan-bot"); },
      remove: async () => undefined,
    },
  });
  await assert.rejects(service.execute("uninstall"), /not managed by qiyan-bot/u);
  assert.deepEqual(calls, []);
});

test("rejects a custom XDG config home instead of writing outside systemd's search path", () => {
  assert.throws(() => new SystemdUserService({
    userHome: "/home/user",
    nodeExecutable: "/usr/bin/node",
    executable: "/home/user/.local/bin/qiyan-bot",
    env: { XDG_CONFIG_HOME: "/home/user/custom-config" },
    runner: async () => ({ code: 0, signal: null, stdout: "" }),
    unitStore: { withOperationLease: async (operation) => operation(), install: async () => undefined, verifyManaged: async () => true, remove: async () => undefined },
  }), /custom XDG_CONFIG_HOME is not supported/u);
});

test("managed unit storage is idempotent and refuses symlinks or unmanaged replacement", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "qiyan-systemd-home-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await chmod(home, 0o700);
  const store = new NodeSystemdUnitStore(home, process.getuid?.());
  const unitPath = join(home, ".config", "systemd", "user", "qiyan-bot.service");
  const managed = `${MANAGED_UNIT_MARKER}\n[Unit]\nDescription=managed\n`;
  await assert.rejects(store.install(unitPath, `${managed}${"x".repeat(64 * 1024)}`), /too large/u);
  await assert.rejects(lstat(unitPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  await store.install(unitPath, managed);
  await store.install(unitPath, managed);
  assert.equal(await readFile(unitPath, "utf8"), managed);
  assert.equal((await lstat(unitPath)).mode & 0o777, 0o644);
  await assert.rejects(store.install(unitPath, `${MANAGED_UNIT_MARKER}\n[Unit]\nDescription=changed\n`), /uninstall it before installing a changed unit/u);
  await store.remove(unitPath);
  await assert.rejects(lstat(unitPath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");

  await writeFile(unitPath, "[Unit]\nDescription=user-owned\n", { mode: 0o644 });
  await assert.rejects(store.install(unitPath, managed), /not managed by qiyan-bot/u);
  await assert.rejects(store.remove(unitPath), /not managed by qiyan-bot/u);
  await rm(unitPath);
  await mkdir(join(home, "target"));
  await symlink(join(home, "target"), unitPath);
  await assert.rejects(store.install(unitPath, managed), /regular owner file/u);
});

test("cross-process unit lease serializes service operations", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "qiyan-systemd-lease-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await chmod(home, 0o700);
  const store = new NodeSystemdUnitStore(home, process.getuid?.());
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const first = store.withOperationLease(async () => { entered(); await held; });
  await started;
  await assert.rejects(store.withOperationLease(async () => undefined), /service operation is already in progress/u);
  release();
  await first;
  await store.withOperationLease(async () => undefined);
});

test("final install and remove fences preserve concurrent unmanaged replacements", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "qiyan-systemd-fence-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await chmod(home, 0o700);
  const unitPath = join(home, ".config", "systemd", "user", "qiyan-bot.service");
  const managed = `${MANAGED_UNIT_MARKER}\n[Unit]\nDescription=managed\n`;
  const unmanaged = "[Unit]\nDescription=concurrent-user-unit\n";

  const publishing = new NodeSystemdUnitStore(home, process.getuid?.(), {
    beforePublish: async () => { await writeFile(unitPath, unmanaged, { mode: 0o644 }); },
  });
  await assert.rejects(publishing.install(unitPath, managed), /changed during install/u);
  assert.equal(await readFile(unitPath, "utf8"), unmanaged);
  await rm(unitPath);

  const initial = new NodeSystemdUnitStore(home, process.getuid?.());
  await initial.install(unitPath, managed);
  const removing = new NodeSystemdUnitStore(home, process.getuid?.(), {
    beforeRemove: async () => { await rm(unitPath); await writeFile(unitPath, unmanaged, { mode: 0o644 }); },
  });
  await assert.rejects(removing.remove(unitPath), /changed during removal/u);
  assert.equal(await readFile(unitPath, "utf8"), unmanaged);
});

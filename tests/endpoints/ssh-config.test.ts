import assert from "node:assert/strict";
import test from "node:test";
import {
  SshGenerationPlanner,
  buildControlMasterCheckArgs,
  buildControlMasterExitArgs,
  buildSshArgs,
  buildSshStreamForwardCancelArgs,
  buildSshStreamForwardArgs,
  buildSshReverseForwardArgs,
  buildSshReverseForwardCancelArgs,
  parseSshConfig,
  planSshConnection,
} from "../../src/endpoints/ssh-config.ts";

const parsed = `hostname host.example\nuser xin\nport 2222\ncontrolmaster no\ncontrolpath none\n`;

test("parses effective SSH configuration and pins the final destination", () => {
  const effective = parseSshConfig(parsed);
  const plan = planSshConnection("devbox", effective, "/run/user/1000/qiyan");
  assert.deepEqual(plan.destination, { hostname: "host.example", user: "xin", port: 2222 });
  assert.equal(plan.ownsControlMaster, true);
  assert.match(plan.controlPath!, /\/ssh\/[a-f0-9]{24}$/u);
  const args = buildSshArgs(plan, ["-N"]);
  assert.deepEqual(args.slice(0, 6), ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10"]);
  assert.ok(args.includes("HostName=host.example"));
  assert.ok(args.includes("xin"));
  assert.ok(args.includes("2222"));
  assert.ok(args.includes("ControlPersist=yes"));
  assert.equal(args.includes("ControlPersist=60"), false);
  assert.equal(args.at(-1), "devbox");
});

test("honors a usable user ControlMaster without taking ownership", () => {
  const effective = parseSshConfig(`${parsed}controlmaster auto\ncontrolpath /tmp/user-master\n`);
  const plan = planSshConnection("devbox", effective, "/private/runtime");
  assert.equal(plan.ownsControlMaster, false);
  assert.equal(plan.controlPath, "/tmp/user-master");
  const args = buildSshArgs(plan, []);
  assert.deepEqual(args.slice(args.indexOf("-S"), args.indexOf("-S") + 2), ["-S", "/tmp/user-master"]);
  assert.ok(args.includes("ControlMaster=no"));
  assert.doesNotMatch(args.join(" "), /ControlPersist/u);
  assert.throws(() => buildControlMasterExitArgs(plan), /user-owned/u);
});

test("stream-local forwarding is registered and cancelled on the authenticated ControlMaster", () => {
  const plan = planSshConnection("devbox", parseSshConfig(`${parsed}controlmaster auto\ncontrolpath /tmp/user-master\n`), "/private/runtime");
  const local = "/private/qiyan/f-01234567.sock";
  const remote = "/tmp/qiyan-1000/abcdef/app-server.sock";
  const check = buildControlMasterCheckArgs(plan);
  const forward = buildSshStreamForwardArgs(plan, local, remote);
  const cancel = buildSshStreamForwardCancelArgs(plan, local, remote);
  for (const [args, command] of [[check, "check"], [forward, "forward"], [cancel, "cancel"]] as const) {
    assert.deepEqual(args.slice(args.indexOf("-S"), args.indexOf("-S") + 2), ["-S", "/tmp/user-master"]);
    assert.deepEqual(args.slice(args.indexOf("-O"), args.indexOf("-O") + 2), ["-O", command]);
    assert.equal(args.at(-1), "devbox");
    assert.doesNotMatch(args.join(" "), /ControlPath=none|ControlPersist=60|-N|-T|-n/u);
  }
  for (const option of ["ExitOnForwardFailure=yes", "StreamLocalBindUnlink=no", "StreamLocalBindMask=0177"]) {
    assert.ok(forward.includes(option), option);
  }
  assert.ok(forward.includes(`${local}:${remote}`));
  assert.ok(cancel.includes(`${local}:${remote}`));
});

test("reverse forwarding binds a REMOTE loopback port (bind-not-relax) on the ControlMaster", () => {
  const plan = planSshConnection("devbox", parseSshConfig(`${parsed}controlmaster auto\ncontrolpath /tmp/user-master\n`), "/private/runtime");
  // remotePort 0 = ask the remote sshd to allocate a free port (the tunnel reads it back)
  const forward = buildSshReverseForwardArgs(plan, 0, 40001);
  const cancel = buildSshReverseForwardCancelArgs(plan, 34567, 40001);
  assert.deepEqual(forward.slice(forward.indexOf("-O"), forward.indexOf("-O") + 2), ["-O", "forward"]);
  assert.deepEqual(cancel.slice(cancel.indexOf("-O"), cancel.indexOf("-O") + 2), ["-O", "cancel"]);
  // remote binds to 127.0.0.1 (never 0.0.0.0) → only the remote host's processes can connect
  assert.deepEqual(forward.slice(forward.indexOf("-R"), forward.indexOf("-R") + 2), ["-R", "127.0.0.1:0:127.0.0.1:40001"]);
  // cancel must carry the EXACT allocated spec — the only form ssh accepts to remove a forward
  assert.ok(cancel.includes("127.0.0.1:34567:127.0.0.1:40001"));
  assert.ok(forward.includes("ExitOnForwardFailure=yes"));
  assert.equal(forward.at(-1), "devbox");
  assert.doesNotMatch(forward.join(" "), /GatewayPorts=yes|0\.0\.0\.0/u);
  for (const bad of [[-1, 40001], [65_536, 1], [1, 0], [1, -1]] as const) {
    assert.throws(() => buildSshReverseForwardArgs(plan, bad[0], bad[1]), /reverse-forward port/u);
  }
});

test("rejects malformed effective configuration and unsafe aliases", () => {
  assert.throws(() => parseSshConfig("hostname x\nuser y\nport nope\n"), /port/u);
  assert.throws(() => planSshConnection("bad alias", parseSshConfig(parsed), "/private/runtime"), /endpoint alias/u);
});

test("falls back to an owned master when the effective ControlPath is unsafe", () => {
  for (const controlPath of ["relative/socket", "/tmp/bad\npath", `/tmp/${"x".repeat(110)}`]) {
    const plan = planSshConnection("devbox", { ...parseSshConfig(parsed), controlMaster: "auto", controlPath }, "/private/runtime");
    assert.equal(plan.ownsControlMaster, true);
    assert.ok(buildControlMasterExitArgs(plan).includes("exit"));
  }
});

test("interactive ControlMaster modes use QiYan's noninteractive fallback", () => {
  for (const controlMaster of ["ask", "autoask"]) {
    const plan = planSshConnection("devbox", { ...parseSshConfig(parsed), controlMaster, controlPath: "/tmp/user-master" }, "/private/runtime");
    assert.equal(plan.ownsControlMaster, true);
  }
});

test("re-resolves SSH configuration and checks the durable binding on every generation", async () => {
  let hostname = "host-one";
  const checked: Array<{ endpointId: string; hostname: string; references: boolean }> = [];
  const planner = new SshGenerationPlanner({
    sshBinary: "ssh",
    runtimeDir: "/private/runtime",
    hasReferences: (endpointId) => endpointId === "devbox",
    checkExisting: (endpointId, destination, references) => { checked.push({ endpointId, hostname: destination.hostname, references }); },
    attestControlMaster: async () => undefined,
    run: async (command, args) => {
      assert.equal(command, "ssh");
      assert.deepEqual(args, ["-G", "devbox"]);
      return { stdout: Buffer.from(`hostname ${hostname}\nuser xin\nport 22\ncontrolmaster no\ncontrolpath none\n`), stderr: Buffer.alloc(0) };
    },
  });
  const first = await planner.createGeneration("devbox", "devbox");
  hostname = "host-two";
  const second = await planner.createGeneration("devbox", "devbox");
  assert.equal(first.pendingBinding.destination.hostname, "host-one");
  assert.equal(second.pendingBinding.destination.hostname, "host-two");
  assert.deepEqual(checked, [
    { endpointId: "devbox", hostname: "host-one", references: true },
    { endpointId: "devbox", hostname: "host-two", references: true },
  ]);
});

test("generation reuses a live user master and falls back to an owned master when it is absent", async () => {
  const calls: string[][] = [];
  let userMasterAvailable = true;
  const planner = new SshGenerationPlanner({
    sshBinary: "ssh",
    runtimeDir: "/private/runtime",
    hasReferences: () => true,
    checkExisting: () => undefined,
    attestControlMaster: async () => undefined,
    run: async (_command, args) => {
      calls.push([...args]);
      if (args[0] === "-G") {
        return {
          stdout: Buffer.from("hostname host.example\nuser xin\nport 22\ncontrolmaster auto\ncontrolpath /private/user-master\n"),
          stderr: Buffer.alloc(0),
        };
      }
      assert.equal(args[args.indexOf("-O") + 1], "check");
      if (!userMasterAvailable) throw new Error("master unavailable");
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    },
  });

  const reused = await planner.createGeneration("devbox", "devbox");
  assert.equal(reused.plan.ownsControlMaster, false);
  assert.equal(reused.plan.controlPath, "/private/user-master");

  userMasterAvailable = false;
  const fallback = await planner.createGeneration("devbox", "devbox");
  assert.equal(fallback.plan.ownsControlMaster, true);
  assert.match(fallback.plan.controlPath!, /^\/private\/runtime\/ssh\/[a-f0-9]{24}$/u);
  assert.ok(buildSshArgs(fallback.plan, []).includes("ControlMaster=auto"));
  assert.deepEqual(calls.map((args) => args[0] === "-G" ? "config" : args[args.indexOf("-O") + 1]), [
    "config", "check", "config", "check",
  ]);
});

test("generation attests a configured user master before probing it", async () => {
  const events: string[] = [];
  const planner = new SshGenerationPlanner({
    sshBinary: "ssh",
    runtimeDir: "/private/runtime",
    hasReferences: () => true,
    checkExisting: () => undefined,
    attestControlMaster: async () => { events.push("attest"); throw new Error("unsafe socket"); },
    run: async (_command, args) => {
      if (args[0] !== "-G") assert.fail("an unattested user master must not be probed");
      events.push("config");
      return {
        stdout: Buffer.from("hostname host.example\nuser xin\nport 22\ncontrolmaster auto\ncontrolpath /private/user-master\n"),
        stderr: Buffer.alloc(0),
      };
    },
  });

  const generation = await planner.createGeneration("devbox", "devbox");
  assert.equal(generation.plan.ownsControlMaster, true);
  assert.deepEqual(events, ["config", "attest"]);
});

test("generation cancellation never becomes an owned-master fallback", async () => {
  for (const boundary of ["attest", "check"] as const) {
    const controller = new AbortController();
    const planner = new SshGenerationPlanner({
      sshBinary: "ssh",
      runtimeDir: "/private/runtime",
      hasReferences: () => true,
      checkExisting: () => undefined,
      attestControlMaster: async () => {
        if (boundary !== "attest") return;
        controller.abort(new Error("cancelled during attestation"));
        throw controller.signal.reason;
      },
      run: async (_command, args) => {
        if (args[0] === "-G") {
          return {
            stdout: Buffer.from("hostname host.example\nuser xin\nport 22\ncontrolmaster auto\ncontrolpath /private/user-master\n"),
            stderr: Buffer.alloc(0),
          };
        }
        controller.abort(new Error("cancelled during master check"));
        throw controller.signal.reason;
      },
    });

    await assert.rejects(planner.createGeneration("devbox", "devbox", controller.signal), /cancelled during/u);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { StartupPhaseError } from "../src/app.ts";
import { formatCliHelp, formatStartupError, parseCliArgs } from "../src/cli.ts";
import { AppError } from "../src/core/errors.ts";

test("parses an explicit assistant workdir", () => {
  assert.deepEqual(parseCliArgs([]), { command: "run" });
  assert.deepEqual(parseCliArgs(["--workdir", "./manager"]), { command: "run", assistantWorkdir: "./manager" });
  assert.deepEqual(parseCliArgs(["--home", "/srv/qiyan", "--workdir", "/srv/qiyan/work"]), {
    command: "run", qiyanHome: "/srv/qiyan", assistantWorkdir: "/srv/qiyan/work",
  });
  assert.deepEqual(parseCliArgs(["assistant-login"]), { command: "assistant-login" });
  assert.deepEqual(parseCliArgs(["assistant-login", "--home", "/srv/qiyan"]), { command: "assistant-login", qiyanHome: "/srv/qiyan" });
  assert.deepEqual(parseCliArgs(["weixin-login"]), { command: "weixin-login" });
  assert.deepEqual(parseCliArgs(["weixin-login", "--home", "/srv/qiyan"]), { command: "weixin-login", qiyanHome: "/srv/qiyan" });
  assert.deepEqual(parseCliArgs(["config-check", "--home", "/srv/qiyan"]), { command: "config-check", qiyanHome: "/srv/qiyan" });
  assert.deepEqual(parseCliArgs(["--version"]), { command: "version" });
  assert.deepEqual(parseCliArgs(["--update"]), { command: "update" });
  assert.deepEqual(parseCliArgs(["service", "install"]), { command: "service", action: "install" });
  assert.deepEqual(parseCliArgs(["service", "install", "--home", "/srv/qiyan"]), { command: "service", action: "install", qiyanHome: "/srv/qiyan" });
  assert.deepEqual(parseCliArgs(["service", "start"]), { command: "service", action: "start" });
  assert.deepEqual(parseCliArgs(["service", "stop"]), { command: "service", action: "stop" });
  assert.deepEqual(parseCliArgs(["service", "restart"]), { command: "service", action: "restart" });
  assert.deepEqual(parseCliArgs(["service", "status"]), { command: "service", action: "status" });
  assert.deepEqual(parseCliArgs(["service", "logs"]), { command: "service", action: "logs" });
  assert.deepEqual(parseCliArgs(["service", "uninstall"]), { command: "service", action: "uninstall" });
});

test("parses top-level and command-specific help without accepting extra arguments", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { command: "help", topic: "root" });
  assert.deepEqual(parseCliArgs(["-h"]), { command: "help", topic: "root" });
  assert.deepEqual(parseCliArgs(["assistant-login", "--help"]), { command: "help", topic: "assistant-login" });
  assert.deepEqual(parseCliArgs(["weixin-login", "-h"]), { command: "help", topic: "weixin-login" });
  assert.deepEqual(parseCliArgs(["config-check", "--help"]), { command: "help", topic: "config-check" });
  assert.deepEqual(parseCliArgs(["service", "--help"]), { command: "help", topic: "service" });
  assert.deepEqual(parseCliArgs(["service", "install", "--help"]), { command: "help", topic: "service" });
  assert.throws(() => parseCliArgs(["--help", "--home", "/srv/qiyan"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["assistant-login", "--help", "--home", "/srv/qiyan"]), /unknown argument/);
});

test("formats useful top-level and command-specific help", () => {
  const root = formatCliHelp("root");
  assert.match(root, /^QiYan personal assistant bot\n/u);
  assert.match(root, /Usage:\n  qiyan-bot \[--home <path>\] \[--workdir <path>\]/u);
  assert.match(root, /qiyan-bot assistant-login \[--home <path>\]/u);
  assert.match(root, /qiyan-bot service <action>/u);
  assert.doesNotMatch(root, /recover-dashboard-metadata/u);
  assert.match(root, /starts the long-lived bot in the foreground/u);
  assert.match(root, /-h, --help/u);
  assert.match(root, /Requires Node\.js 24 or newer\./u);
  assert.equal(root.endsWith("\n"), true);

  const login = formatCliHelp("assistant-login");
  assert.match(login, /Usage:\n  qiyan-bot assistant-login \[--home <path>\]/u);
  assert.doesNotMatch(login, /--workdir/u);

  assert.match(formatCliHelp("weixin-login"), /qiyan-bot weixin-login \[--home <path>\]/u);
  assert.match(formatCliHelp("config-check"), /qiyan-bot config-check \[--home <path>\]/u);
  assert.match(formatCliHelp("service"), /install\|start\|stop\|restart\|status\|logs\|uninstall/u);
  assert.match(formatCliHelp("service"), /journal/u);
  assert.match(formatCliHelp("service"), /captures.*PATH.*reinstall/isu);
});

test("rejects missing, repeated, and unknown CLI arguments", () => {
  assert.throws(() => parseCliArgs(["--workdir"]), /requires a path/);
  assert.throws(() => parseCliArgs(["--home"]), /requires a path/);
  assert.throws(() => parseCliArgs(["--workdir", "one", "--workdir", "two"]), /only once/);
  assert.throws(() => parseCliArgs(["--home", "one", "--home", "two"]), /only once/);
  assert.throws(() => parseCliArgs(["--unknown"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["assistant-login", "--workdir", "one"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["weixin-login", "--workdir", "one"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["config-check", "--workdir", "one"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["--version", "--workdir", "one"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["--update", "--version"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["service"]), /service action is required/);
  assert.throws(() => parseCliArgs(["service", "unknown-secret"]), /unknown service action/);
  assert.throws(() => parseCliArgs(["service", "start", "--home", "/srv/qiyan"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["service", "install", "--workdir", "/srv/qiyan"]), /unknown argument/);
  assert.throws(() => parseCliArgs(["recover-dashboard-metadata"]), /unknown argument/);
});

test("does not echo an unknown argument into a startup error", () => {
  let failure: unknown;
  try { parseCliArgs(["--unknown=secret-token"]); } catch (error) { failure = error; }
  assert.equal(formatStartupError(failure), "CONFIGURATION_ERROR: unknown argument");
  assert.doesNotMatch(formatStartupError(failure), /secret-token/);
});

test("formats only known user-facing startup failures", () => {
  assert.equal(formatStartupError(new AppError("CONFIGURATION_ERROR", "managed file changed")), "CONFIGURATION_ERROR: managed file changed");
  assert.equal(formatStartupError(new Error("request contained secret-token")), "startup failed");
});

test("formats startup phases and only sanitized typed causes", () => {
  assert.equal(
    formatStartupError(new StartupPhaseError("endpoint", new Error("spawn included secret-token"))),
    "STARTUP_ERROR: Codex App Server startup failed; verify CODEX_BINARY, Codex version, and assistant authentication",
  );
  assert.equal(
    formatStartupError(new StartupPhaseError("endpoint", new AppError("UNSUPPORTED_CAPABILITY", "requires Codex app-server 1.2.3 or newer"))),
    "STARTUP_ERROR: Codex App Server startup failed; verify CODEX_BINARY, Codex version, and assistant authentication (UNSUPPORTED_CAPABILITY: requires Codex app-server 1.2.3 or newer)",
  );
  assert.equal(
    formatStartupError(new StartupPhaseError("assistant", new AppError("OPERATION_UNCERTAIN", "response included secret-token"))),
    "STARTUP_ERROR: assistant session initialization failed (OPERATION_UNCERTAIN)",
  );
  assert.equal(
    formatStartupError(new StartupPhaseError("endpoint", new AppError("CONFIGURATION_ERROR", "assistant profile is not authenticated"))),
    "CONFIGURATION_ERROR: assistant profile is not authenticated",
  );
  assert.equal(
    formatStartupError(new StartupPhaseError("secret-phase-name", new Error("secret-token"))),
    "STARTUP_ERROR: application startup failed",
  );
  assert.equal(
    formatStartupError(new StartupPhaseError("constructor", new Error("secret-token"))),
    "STARTUP_ERROR: application startup failed",
  );
});

test("parses web-ui subcommands with --host/--port for start and --home for all", () => {
  assert.deepEqual(parseCliArgs(["web-ui", "start"]), { command: "web-ui", action: "start" });
  assert.deepEqual(parseCliArgs(["web-ui", "stop"]), { command: "web-ui", action: "stop" });
  assert.deepEqual(parseCliArgs(["web-ui", "status"]), { command: "web-ui", action: "status" });
  assert.deepEqual(parseCliArgs(["web-ui", "status", "--home", "/srv/qiyan"]), { command: "web-ui", action: "status", qiyanHome: "/srv/qiyan" });
  assert.deepEqual(parseCliArgs(["web-ui", "start", "--host", "0.0.0.0", "--port", "8420"]), { command: "web-ui", action: "start", host: "0.0.0.0", port: 8420 });
  assert.deepEqual(parseCliArgs(["web-ui", "start", "--port", "9000", "--home", "/h"]), { command: "web-ui", action: "start", port: 9000, qiyanHome: "/h" });
  assert.deepEqual(parseCliArgs(["web-ui", "--help"]), { command: "help", topic: "web-ui" });
  assert.deepEqual(parseCliArgs(["web-ui", "stop", "--help"]), { command: "help", topic: "web-ui" });
  assert.throws(() => parseCliArgs(["web-ui"]), /web-ui action is required/u);
  assert.throws(() => parseCliArgs(["web-ui", "bogus"]), /unknown web-ui action/u);
  assert.throws(() => parseCliArgs(["web-ui", "start", "extra"]), /unknown argument/u);
  assert.throws(() => parseCliArgs(["web-ui", "stop", "--host", "x"]), /unknown argument/u); // --host only for start
  assert.throws(() => parseCliArgs(["web-ui", "start", "--port", "notanum"]), /--port must be an integer/u);
  assert.throws(() => parseCliArgs(["web-ui", "start", "--host"]), /--host requires a value/u);
  assert.match(formatCliHelp("web-ui"), /web-ui start \[--host/u);
  assert.match(formatCliHelp("root"), /web-ui start \[--host/u);
});

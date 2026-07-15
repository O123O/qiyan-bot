import { createApp, type BotApp } from "./app.ts";
import { formatCliHelp, parseCliArgs, type WebUiAction } from "./cli.ts";
import { loadConfig, loadAssistantLoginConfig } from "./config.ts";
import { loadConfigSource } from "./config-source.ts";
import { runAssistantLogin } from "./assistant/login.ts";
import { readPackageInfo } from "./distribution/package-info.ts";
import { updateFromLatestRelease } from "./distribution/update.ts";
import { validateAssistantWorkspacePaths } from "./assistant/workspace.ts";
import { WeixinAuthClient } from "./chat-apps/weixin/auth-client.ts";
import { WeixinCredentialStore } from "./chat-apps/weixin/credential-store.ts";
import { createNodeWeixinLoginTerminal, runWeixinLogin } from "./chat-apps/weixin/login.ts";
import { bootstrapWeixin } from "./chat-apps/weixin/bootstrap.ts";
import { buildServiceEffectiveEnvironment, readServiceMainPid, SystemdUserService } from "./service/systemd-user.ts";
import { installWebUiSignalHandler } from "./webui/webui-signal.ts";
import { readWebUiEnabled, webUiStatePath, writeWebUiEnabled } from "./webui/webui-state.ts";
import { AppError } from "./core/errors.ts";
import { createOperationalLogSink } from "./core/operational-log.ts";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export async function main(
  env = process.env,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const command = parseCliArgs(argv);
  // Own SIGUSR2 before any startup await so a `web-ui` toggle signal can never terminate the
  // long-lived bot (SIGUSR2's default disposition). Placement is load-bearing: it MUST precede
  // loadConfigSource/bootstrapWeixin/createApp below.
  if (command.command === "run") installWebUiSignalHandler();
  if (command.command === "help") {
    process.stdout.write(formatCliHelp(command.topic));
    return;
  }
  if (command.command === "version") {
    const packageInfo = await readPackageInfo();
    process.stdout.write(`${packageInfo.version}\n`);
    return;
  }
  if (command.command === "update") {
    const result = await updateFromLatestRelease({ env });
    process.stdout.write(`Updated qiyan-bot to ${result.version} in ${result.prefix}.\n`);
    process.stdout.write("Restart any running qiyan-bot process to use this version.\n");
    return;
  }
  if (command.command === "service") {
    const userHome = serviceUserHome(env);
    const executable = process.argv[1];
    if (!executable || !isAbsolute(executable)) throw new AppError("CONFIGURATION_ERROR", "service management requires an absolute qiyan-bot executable path");
    const service = new SystemdUserService({ userHome, nodeExecutable: process.execPath, executable, env });
    if (command.action === "install") {
      service.validateInstallEnvironment();
      const selected = await loadConfigSource(env, command.qiyanHome === undefined ? {} : { cliHome: command.qiyanHome });
      const loaded = await loadConfigSource(buildServiceEffectiveEnvironment(env), { cliHome: selected.qiyanHome });
      const weixin = await bootstrapWeixin(loaded.qiyanHome);
      const config = loadConfig(loaded.values, { qiyanHome: loaded.qiyanHome, weixinConfigured: weixin.configured });
      await validateAssistantWorkspacePaths({ workdir: config.assistantWorkdir, dataDir: config.dataDir, registryPath: config.sessionRegistryPath });
      process.stdout.write(await service.execute("install", { qiyanHome: loaded.qiyanHome }));
    } else {
      process.stdout.write(await service.execute(command.action));
    }
    return;
  }
  if (command.command === "assistant-login") {
    const loaded = await loadConfigSource(env, command.qiyanHome === undefined ? {} : { cliHome: command.qiyanHome });
    await runAssistantLogin(loadAssistantLoginConfig(loaded.values, loaded.qiyanHome), loaded.hostEnv);
    return;
  }
  if (command.command === "weixin-login") {
    const loaded = await loadConfigSource(env, command.qiyanHome === undefined ? {} : { cliHome: command.qiyanHome });
    const transport = { fetch: (url: URL, init: RequestInit) => fetch(url, init) };
    const controller = new AbortController();
    const abort = () => { controller.abort(); };
    const terminal = createNodeWeixinLoginTerminal();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      await runWeixinLogin({
        store: new WeixinCredentialStore(loaded.qiyanHome),
        auth: new WeixinAuthClient(transport),
        terminal,
        signal: controller.signal,
      });
    } catch (error) {
      if (!controller.signal.aborted || !(error instanceof Error) || error.name !== "AbortError") throw error;
      terminal.status("WeChat authorization cancelled; no changes were made.");
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
    return;
  }
  const loaded = await loadConfigSource(env, command.qiyanHome === undefined ? {} : { cliHome: command.qiyanHome });
  const weixin = await bootstrapWeixin(loaded.qiyanHome);
  if (command.command === "config-check") {
    const config = loadConfig(loaded.values, { qiyanHome: loaded.qiyanHome, weixinConfigured: weixin.configured });
    await validateAssistantWorkspacePaths({ workdir: config.assistantWorkdir, dataDir: config.dataDir, registryPath: config.sessionRegistryPath });
    process.stdout.write("Configuration OK.\n");
    return;
  }
  if (command.command === "web-ui") {
    const config = loadConfig(loaded.values, { qiyanHome: loaded.qiyanHome, weixinConfigured: weixin.configured });
    await runWebUiCommand(command.action, {
      qiyanHome: loaded.qiyanHome,
      ...(config.webUi ? { webUi: { host: config.webUi.host, port: config.webUi.port } } : {}),
      dataDir: config.dataDir,
      mainPid: () => readServiceMainPid(env),
      signal: (pid) => { try { process.kill(pid, "SIGUSR2"); return true; } catch { return false; } },
      readToken: (dataDir) => { try { return readFileSync(join(dataDir, "web-token"), "utf8").trim() || undefined; } catch { return undefined; } },
      write: (text) => process.stdout.write(text),
    });
    return;
  }
  const config = loadConfig(loaded.values, {
    qiyanHome: loaded.qiyanHome,
    weixinConfigured: weixin.configured,
    ...(command.assistantWorkdir === undefined ? {} : { assistantWorkdir: command.assistantWorkdir }),
  });
  const app = await createApp(config, {
    ...(weixin.configured ? { weixinCredential: weixin.credential } : {}),
    onOperationalEvent: createOperationalLogSink(),
    requestRestart: () => { requestServiceRestart(); },
  });
  await runForegroundApp(app);
}

export interface WebUiCommandDeps {
  qiyanHome: string;
  webUi?: { host: string; port: number }; // undefined ⇒ WEB_UI not configured
  dataDir: string;
  mainPid(): Promise<number | undefined>; // the running bot's main PID, or undefined
  signal(pid: number): boolean; // deliver SIGUSR2; false on ESRCH (PID died)
  readToken(dataDir: string): string | undefined; // best-effort persisted web token
  write(text: string): void;
}

// `qiyan-bot web-ui start|stop|status`. start/stop persist the desired state atomically and, when
// the bot is running, signal it to reconcile live (no restart). Signalling is safe regardless of
// config because the running bot always installs a SIGUSR2 handler (see installWebUiSignalHandler);
// the config guard here is UX only.
export async function runWebUiCommand(action: WebUiAction, deps: WebUiCommandDeps): Promise<void> {
  const statePath = webUiStatePath(deps.qiyanHome);
  if (action === "status") {
    let desired: string;
    try { desired = readWebUiEnabled(statePath) ? "enabled" : "disabled"; }
    catch { desired = "unreadable (kept as-is)"; }
    const pid = await deps.mainPid();
    const lines = [
      `Web UI: ${deps.webUi ? "configured" : "not configured (set WEB_UI=1 and restart)"}`,
      `Desired: ${desired}`,
      `Bot service: ${pid === undefined ? "not running" : `running (pid ${pid})`}`,
    ];
    if (deps.webUi) {
      const base = `http://${deps.webUi.host}:${deps.webUi.port}`;
      const token = deps.readToken(deps.dataDir);
      lines.push(`URL: ${token ? `${base}/?token=${token}` : `${base} (token shown by: qiyan-bot service logs)`}`);
    }
    deps.write(`${lines.join("\n")}\n`);
    return;
  }
  if (!deps.webUi) {
    deps.write("Web UI is not configured; set WEB_UI=1 (and WEB_HOST/WEB_PORT) in <qiyanHome>/.env and restart.\n");
    return;
  }
  writeWebUiEnabled(statePath, action === "start");
  const pid = await deps.mainPid();
  const signalled = pid !== undefined && deps.signal(pid);
  deps.write(signalled
    ? `Web UI ${action === "start" ? "started" : "stopped"}.\n`
    : "Saved; the bot is not running — it will apply on next start.\n");
}

interface ServiceProcessControl {
  pid: number;
  exitCode: string | number | null | undefined;
  kill(pid: number, signal: string): unknown;
}

export function requestServiceRestart(control: ServiceProcessControl = process): void {
  control.exitCode = 1;
  control.kill(control.pid, "SIGTERM");
}

function serviceUserHome(env: NodeJS.ProcessEnv): string {
  const home = env.HOME;
  if (!home || !isAbsolute(home) || resolve(home) !== home) throw new AppError("CONFIGURATION_ERROR", "HOME must be an absolute normalized path for service management");
  return home;
}

interface ForegroundSignals {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export const foregroundReadyMessage = "QiYan is running in the foreground. Press Ctrl+C to stop.\n";

export async function runForegroundApp(
  app: BotApp,
  options: {
    signals?: ForegroundSignals;
    write?: (text: string) => void;
    onStopError?: () => void;
  } = {},
): Promise<void> {
  await app.start();
  (options.write ?? ((text) => { process.stdout.write(text); }))(foregroundReadyMessage);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void app.stop().catch(options.onStopError ?? (() => { process.exitCode = 1; }));
  };
  const signals = options.signals ?? process;
  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);
}

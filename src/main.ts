import { createApp, type BotApp } from "./app.ts";
import { formatCliHelp, parseCliArgs } from "./cli.ts";
import { loadConfig, loadAssistantLoginConfig } from "./config.ts";
import { loadConfigSource } from "./config-source.ts";
import { runAssistantLogin } from "./assistant/login.ts";
import { readPackageInfo } from "./distribution/package-info.ts";
import { updateFromLatestRelease } from "./distribution/update.ts";
import { validateAssistantWorkspacePaths } from "./assistant/workspace.ts";
import { WeixinAuthClient } from "./weixin/auth-client.ts";
import { WeixinCredentialStore } from "./weixin/credential-store.ts";
import { createNodeWeixinLoginTerminal, runWeixinLogin } from "./weixin/login.ts";
import { bootstrapWeixin } from "./weixin/bootstrap.ts";
import { buildServiceEffectiveEnvironment, SystemdUserService } from "./service/systemd-user.ts";
import { AppError } from "./core/errors.ts";
import { createOperationalLogSink } from "./core/operational-log.ts";
import { isAbsolute, resolve } from "node:path";

export async function main(env = process.env, argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = parseCliArgs(argv);
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
  const config = loadConfig(loaded.values, {
    qiyanHome: loaded.qiyanHome,
    weixinConfigured: weixin.configured,
    ...(command.assistantWorkdir === undefined ? {} : { assistantWorkdir: command.assistantWorkdir }),
  });
  const app = await createApp(config, {
    ...(weixin.configured ? { weixinCredential: weixin.credential } : {}),
    onOperationalEvent: createOperationalLogSink(),
  });
  await runForegroundApp(app);
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

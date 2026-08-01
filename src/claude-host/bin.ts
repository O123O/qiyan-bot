// `qiyan-claude-host`: the long-lived Claude host a remote endpoint's sessions run inside.
//
// It exists so a remote turn outlives QiYan and the ssh channel: the SDK queries live HERE,
// inside the endpoint's tmux generation, and QiYan is only a client on the other end of an
// owner-only unix socket. Behaviour is not duplicated — this serves the same LocalClaudeHost
// that a local endpoint runs in-process, so there is exactly one implementation of a session.
//
// Shipped as its own bundle (scripts/build.mjs → assets/remote/qiyan-claude-host.mjs) and
// installed by the ssh helper alongside it, digest-pinned like every other remote asset.
import { pathToFileURL } from "node:url";
import { AppError } from "../core/errors.ts";
import { APP_VERSION } from "../version.ts";
import { LocalClaudeHost } from "./host.ts";
import { checkClaudeRuntimeRequirements, loadAgentSdk } from "./requirements.ts";
import { sdkSessionPreparer, type QueryFn } from "./sdk-query.ts";
import { ClaudeHostServer } from "./transport.ts";

export interface ClaudeHostBinOptions {
  socketPath: string;
  claudeExecutable: string;
  // Absolute path to the installed Agent SDK's entry file. Mandatory, not a convenience:
  // this bundle lives outside any node_modules tree, where an ESM import of the bare
  // specifier cannot resolve — and NODE_PATH, which would rescue a CJS require, does not
  // apply to ESM. The ssh helper resolves it on this machine and passes it down.
  sdkPath: string;
}

export function parseClaudeHostArgs(argv: readonly string[]): ClaudeHostBinOptions {
  const value = (name: string): string => {
    const index = argv.indexOf(name);
    const found = index < 0 ? undefined : argv[index + 1];
    if (found === undefined || found.startsWith("--")) {
      throw new AppError("CONFIGURATION_ERROR", `qiyan-claude-host requires ${name} <path>`);
    }
    return found;
  };
  return { socketPath: value("--socket"), claudeExecutable: value("--claude"), sdkPath: value("--sdk") };
}

// Fails closed on a missing SDK or CLI: the supervisor sees the process exit and the
// endpoint reports the prerequisite error, rather than a socket that accepts turns it
// cannot run.
export async function serveClaudeHost(options: ClaudeHostBinOptions): Promise<ClaudeHostServer> {
  const importer = (): Promise<unknown> => import(pathToFileURL(options.sdkPath).href);
  const requirements = await checkClaudeRuntimeRequirements({
    claudeExecutable: options.claudeExecutable,
    importer,
  });
  // Already resolved by the check above, so this only reads the module registry's cached
  // record; it is separate because the check reports versions, not the module itself.
  const sdk = await loadAgentSdk(importer);
  const host = new LocalClaudeHost(sdkSessionPreparer(sdk.query as QueryFn, {
    claudeExecutable: options.claudeExecutable,
    // Every session's permission mode is the user's own; a host-wide warning has no
    // client to reach from here, so it stays in the launcher's log.
    onWarning: (message) => process.stderr.write(`qiyan-claude-host: ${message}\n`),
  }));
  const server = new ClaudeHostServer(host, {
    hostBuild: APP_VERSION,
    sdkVersion: requirements.sdkVersion,
    claudeVersion: requirements.claudeVersion,
    // The runtime token is what the supervisor uses to prove this process is the one it
    // started, so it is also the generation a reconnecting backend compares against.
    runtimeGeneration: process.env.QIYAN_RUNTIME_TOKEN ?? "",
  });
  await server.listen(options.socketPath);
  // A stop request kills the process group; draining first ends every SDK query, which
  // settles in-flight turns as interrupted instead of orphaning their Claude children.
  const drain = (): void => {
    void (async () => {
      await host.shutdown().catch(() => undefined);
      await server.close().catch(() => undefined);
      process.exit(0);
    })();
  };
  process.once("SIGTERM", drain);
  process.once("SIGINT", drain);
  return server;
}

// Runs only when this module IS the process entry (the bundled host), so a test can import
// serveClaudeHost without binding a socket.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void serveClaudeHost(parseClaudeHostArgs(process.argv.slice(2))).catch((error: unknown) => {
    process.stderr.write(`qiyan-claude-host: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

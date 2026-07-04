import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  checkFixture,
  fixtureRuntimeOptions,
  loginFixture,
  resolveFixturePaths,
  runCli,
  type CommandResult,
  type CommandRunner,
  type StreamingChild,
  type StreamingChildFactory,
} from "./ssh-worker-support.ts";
import { downFixture, resetFixture, upFixture } from "./ssh-worker-lifecycle.ts";

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_KILL_GRACE_MS = 1_000;

function appendBounded(chunks: Buffer[], value: Buffer, size: { value: number }): void {
  size.value += value.length;
  if (size.value > MAX_COMMAND_OUTPUT_BYTES) throw new Error("SSH worker command output limit exceeded");
  chunks.push(value);
}

export const nodeCommandRunner: CommandRunner = async (command, args, options = {}): Promise<CommandResult> => {
  const inherited = options.inherit === true;
  const child = spawn(command, [...args], {
    env: options.env,
    shell: false,
    stdio: inherited ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const stdoutSize = { value: 0 };
  const stderrSize = { value: 0 };
  let outputFailure: Error | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let forceKill: NodeJS.Timeout | undefined;
  let timedOut = false;
  if (!inherited) {
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outputFailure !== undefined) return;
      try {
        appendBounded(stdout, chunk, stdoutSize);
      } catch (error) {
        outputFailure = error as Error;
        child.kill("SIGTERM");
        forceKill ??= setTimeout(() => child.kill("SIGKILL"), COMMAND_KILL_GRACE_MS);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (outputFailure !== undefined) return;
      try {
        appendBounded(stderr, chunk, stderrSize);
      } catch (error) {
        outputFailure = error as Error;
        child.kill("SIGTERM");
        forceKill ??= setTimeout(() => child.kill("SIGKILL"), COMMAND_KILL_GRACE_MS);
      }
    });
  }

  if (options.timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), COMMAND_KILL_GRACE_MS);
    }, options.timeoutMs);
  }
  try {
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (closeCode, closeSignal) => resolve([closeCode, closeSignal]));
    });
    if (outputFailure !== undefined) throw outputFailure;
    if (timedOut) throw new Error("SSH worker command timed out");
    return {
      code,
      signal,
      stdout: inherited ? "" : Buffer.concat(stdout).toString("utf8"),
      stderr: inherited ? "" : Buffer.concat(stderr).toString("utf8"),
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (forceKill !== undefined) clearTimeout(forceKill);
  }
};

function readableBytes(stream: NodeJS.ReadableStream): AsyncIterable<Uint8Array> {
  return (async function* () {
    for await (const chunk of stream) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    }
  })();
}

export const nodeStreamingChildFactory: StreamingChildFactory = (command, args, options = {}) => {
  const child = spawn(command, [...args], {
    env: options.env,
    shell: false,
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const close = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  const started = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  if (child.stdin === null || child.stdout === null) throw new Error("SSH App Server streams are unavailable");
  const stdin = child.stdin;
  let stdinFailure: Error | undefined;
  const stdinRejectors = new Set<(error: Error) => void>();
  stdin.on("error", (error: Error) => {
    stdinFailure = error;
    for (const reject of stdinRejectors) reject(error);
    stdinRejectors.clear();
  });
  const useStdin = (operation: (done: (error?: Error | null) => void) => void): Promise<void> => (
    new Promise<void>((resolve, reject) => {
      if (stdinFailure !== undefined) {
        reject(stdinFailure);
        return;
      }
      const rejectPending = (error: Error): void => { reject(error); };
      stdinRejectors.add(rejectPending);
      operation((error) => {
        stdinRejectors.delete(rejectPending);
        if (error === null || error === undefined) resolve();
        else reject(error);
      });
    })
  );
  const streaming: StreamingChild = {
    started,
    stdout: readableBytes(child.stdout),
    exit,
    close,
    writeStdin: (value) => useStdin((done) => { stdin.write(value, "utf8", done); }),
    endStdin: () => useStdin((done) => { stdin.end(done); }),
    kill: (signal) => { child.kill(signal); },
  };
  return streaming;
};

async function main(): Promise<number> {
  const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const paths = resolveFixturePaths(repositoryRoot);
  const { port, codexVersion } = fixtureRuntimeOptions(process.env);
  return runCli(process.argv.slice(2), {
    up: () => upFixture(paths, { runner: nodeCommandRunner, port, codexVersion }),
    login: () => loginFixture(paths, nodeCommandRunner, { port }),
    check: () => checkFixture(paths, {
      runner: nodeCommandRunner,
      spawn: nodeStreamingChildFactory,
      port,
      codexVersion,
      onPhase: (phase) => { process.stdout.write(`SSH worker check: ${phase}\n`); },
    }),
    down: () => downFixture(paths, { runner: nodeCommandRunner, port, codexVersion }),
    reset: async () => {
      await resetFixture(paths, { runner: nodeCommandRunner, port, codexVersion, confirmed: true });
    },
  }, {
    readLine: async (prompt) => {
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await readline.question(prompt);
      } finally {
        readline.close();
      }
    },
    stdout: (value) => { process.stdout.write(value); },
    stderr: (value) => { process.stderr.write(value); },
  });
}

if (import.meta.main) {
  process.exitCode = await main();
}

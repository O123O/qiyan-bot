import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { AppError } from "../core/errors.ts";

export interface BoundedProcessResult { stdout: Buffer; stderr: Buffer }

export interface ReadyProcessStream {
  readonly input: Writable;
  readonly output: Readable;
  onClose(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
}

export function openReadyProcessStream(
  command: string,
  args: readonly string[],
  options: { readyMarker: Uint8Array; timeoutMs: number; maxPreludeBytes: number },
): Promise<ReadyProcessStream> {
  if (options.readyMarker.byteLength < 1 || options.readyMarker.byteLength > 256
    || options.maxPreludeBytes < options.readyMarker.byteLength) {
    return Promise.reject(new AppError("CONFIGURATION_ERROR", "invalid process readiness marker"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const marker = Buffer.from(options.readyMarker);
    const output = new PassThrough();
    const closeListeners = new Set<(error?: Error) => void>();
    let prelude = Buffer.alloc(0);
    let stderrBytes = 0;
    let ready = false;
    let startupSettled = false;
    let intentional = false;
    let terminal = false;
    let processExited = false;
    let terminalError: Error | undefined;
    let exitResolve!: () => void;
    const exited = new Promise<void>((done) => { exitResolve = done; });
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const terminate = (): void => {
      if (processExited) return;
      child.kill("SIGTERM");
      if (!escalation) {
        escalation = setTimeout(() => child.kill("SIGKILL"), 250);
        escalation.unref?.();
      }
    };
    const notifyClose = (error?: Error): void => {
      if (terminal) return;
      terminal = true;
      terminalError = error;
      output.end();
      for (const listener of closeListeners) listener(error);
    };
    const failStartup = (error: Error): void => {
      if (startupSettled) {
        if (!intentional) notifyClose(error);
        terminate();
        return;
      }
      startupSettled = true;
      clearTimeout(timeout);
      terminate();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      output.destroy();
      reject(error);
    };
    const forwardOutput = (chunk: Uint8Array): void => {
      if (terminal || intentional || output.writableEnded || output.destroyed) return;
      if (!output.write(chunk)) child.stdout.pause();
    };
    output.on("drain", () => {
      if (!terminal && !intentional) child.stdout.resume();
    });
    const handle: ReadyProcessStream = {
      input: child.stdin,
      output,
      onClose(listener) {
        if (terminal) {
          const error = terminalError;
          queueMicrotask(() => listener(error));
          return () => undefined;
        }
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      async close() {
        if (intentional) { await exited; return; }
        intentional = true;
        child.stdin.destroy();
        output.end();
        terminate();
        await exited;
      },
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (terminal) return;
      if (ready) { forwardOutput(chunk); return; }
      prelude = Buffer.concat([prelude, Buffer.from(chunk)]);
      if (prelude.byteLength > options.maxPreludeBytes) {
        failStartup(new AppError("ENDPOINT_UNAVAILABLE", "SSH process exceeded its readiness output limit"));
        return;
      }
      const boundary = prelude.indexOf(marker);
      if (boundary < 0) return;
      const following = prelude.subarray(boundary + marker.byteLength);
      prelude = Buffer.alloc(0);
      ready = true;
      startupSettled = true;
      clearTimeout(timeout);
      resolve(handle);
      if (following.byteLength > 0) forwardOutput(following);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > options.maxPreludeBytes) {
        failStartup(new AppError("ENDPOINT_UNAVAILABLE", ready
          ? "SSH process exceeded its diagnostic output limit"
          : "SSH process exceeded its readiness output limit"));
      }
    });
    child.stdin.on("error", () => {
      if (!intentional && ready) notifyClose(new AppError("ENDPOINT_UNAVAILABLE", "SSH process input closed"));
    });
    child.once("error", () => failStartup(new AppError("ENDPOINT_UNAVAILABLE", ready
      ? "SSH process stream failed"
      : "SSH process stream failed before readiness")));
    child.once("exit", (code, signal) => {
      processExited = true;
      if (escalation) clearTimeout(escalation);
      exitResolve();
      const error = code === 0 && !signal ? undefined : new AppError(
        "ENDPOINT_UNAVAILABLE",
        ready ? "SSH process stream failed" : "SSH process stream failed before readiness",
        code === null ? undefined : { exitCode: code },
      );
      if (!startupSettled) failStartup(error ?? new AppError("ENDPOINT_UNAVAILABLE", "SSH process stream closed before readiness"));
      else if (!intentional) notifyClose(error);
    });
    child.stdout.once("close", () => { if (ready) output.end(); });
    const timeout = setTimeout(() => failStartup(new AppError("ENDPOINT_UNAVAILABLE", "SSH process readiness timed out")), options.timeoutMs);
    timeout.unref?.();
  });
}

export function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number; input?: Uint8Array | AsyncIterable<Uint8Array | string>; signal?: AbortSignal },
): Promise<BoundedProcessResult> {
  if (options.signal?.aborted) {
    return Promise.reject(options.signal.reason instanceof Error ? options.signal.reason : new Error("SSH process aborted"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let inputSettled = options.input === undefined;
    let stdoutClosed = false;
    let stderrClosed = false;
    let exitOutcome: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let terminalError: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let hardDeadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (hardDeadline) clearTimeout(hardDeadline);
      options.signal?.removeEventListener("abort", abort);
      if (error) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const finishExited = () => {
      if (!exitOutcome || !inputSettled || !stdoutClosed || !stderrClosed) return;
      if (terminalError) { finish(terminalError); return; }
      if (exitOutcome.code === 0) finish();
      else finish(new AppError(
        "ENDPOINT_UNAVAILABLE",
        `SSH process failed (${exitOutcome.signal ? "signal" : `exit ${exitOutcome.code ?? "unknown"}`})`,
        exitOutcome.code === null ? undefined : { exitCode: exitOutcome.code },
      ));
    };
    const stop = (error: Error) => {
      if (settled || terminalError) return;
      terminalError = error;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 250);
      escalation.unref?.();
      hardDeadline = setTimeout(() => finish(error), 2_000);
      hardDeadline.unref?.();
      finishExited();
    };
    const capture = (target: Buffer[]) => (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > options.maxOutputBytes) { stop(new AppError("ENDPOINT_UNAVAILABLE", "SSH process exceeded its output limit")); return; }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.stdout.once("close", () => { stdoutClosed = true; finishExited(); });
    child.stderr.once("close", () => { stderrClosed = true; finishExited(); });
    child.once("error", () => finish(terminalError ?? new AppError("ENDPOINT_UNAVAILABLE", "SSH process could not start")));
    child.once("exit", (code, signal) => {
      exitOutcome = { code, signal };
      finishExited();
    });
    const timeout = setTimeout(() => stop(new AppError("ENDPOINT_UNAVAILABLE", "SSH process timed out")), options.timeoutMs);
    timeout.unref?.();
    const abort = () => stop(options.signal?.reason instanceof Error ? options.signal.reason : new Error("SSH process aborted"));
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () => {
      inputSettled = true;
      stop(new AppError("ENDPOINT_UNAVAILABLE", "SSH process input closed before it was sent"));
      finishExited();
    });
    if (options.input !== undefined) {
      void writeProcessInput(child.stdin, options.input).then(() => {
        inputSettled = true;
        finishExited();
      }, () => {
        inputSettled = true;
        stop(new AppError("ENDPOINT_UNAVAILABLE", "SSH process input could not be sent"));
        finishExited();
      });
    } else child.stdin.end();
  });
}

async function writeProcessInput(
  target: import("node:stream").Writable,
  input: Uint8Array | AsyncIterable<Uint8Array | string>,
): Promise<void> {
  if (Symbol.asyncIterator in Object(input)) {
    for await (const value of input as AsyncIterable<Uint8Array | string>) {
      const chunk = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
      if (!target.write(chunk)) await once(target, "drain");
    }
  } else if (!target.write(input as Uint8Array)) await once(target, "drain");
  await new Promise<void>((resolve, reject) => target.end((error?: Error | null) => error ? reject(error) : resolve()));
}

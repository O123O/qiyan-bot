import { spawn } from "node:child_process";
import { AppError } from "../core/errors.ts";

export interface BoundedProcessResult { stdout: Buffer; stderr: Buffer }

export function runBoundedProcess(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number; input?: Uint8Array; signal?: AbortSignal },
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
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    };
    const finishExited = () => {
      if (!exitOutcome || !inputSettled) return;
      if (terminalError) { finish(terminalError); return; }
      if (exitOutcome.code === 0) finish();
      else finish(new AppError("ENDPOINT_UNAVAILABLE", `SSH process failed (${exitOutcome.signal ? "signal" : `exit ${exitOutcome.code ?? "unknown"}`})`));
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
      bytes += chunk.byteLength;
      if (bytes > options.maxOutputBytes) { stop(new AppError("ENDPOINT_UNAVAILABLE", "SSH process exceeded its output limit")); return; }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
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
    if (options.input) {
      child.stdin.write(options.input, (error) => {
        inputSettled = true;
        if (error) stop(new AppError("ENDPOINT_UNAVAILABLE", "SSH process input could not be sent"));
        else child.stdin.end();
        finishExited();
      });
    } else {
      child.stdin.end();
    }
  });
}

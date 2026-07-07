import { spawn } from "node:child_process";

export class AdvisoryLockUnavailableError extends Error {
  constructor() {
    super("advisory locking is unavailable");
    this.name = "AdvisoryLockUnavailableError";
  }
}

export async function tryAcquireAdvisoryLock(fd: number): Promise<boolean> {
  for (const binary of ["/usr/bin/flock", "/bin/flock"]) {
    const result = await runFlock(binary, fd);
    if (result === "missing") continue;
    if (result === "acquired") return true;
    if (result === "busy") return false;
    throw new Error("advisory lock helper failed");
  }
  throw new AdvisoryLockUnavailableError();
}

function runFlock(binary: string, fd: number): Promise<"acquired" | "busy" | "missing" | "failed"> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "ignore", fd],
      env: {},
    });
    let missing = false;
    child.once("error", (error: NodeJS.ErrnoException) => {
      missing = error.code === "ENOENT";
      resolve(missing ? "missing" : "failed");
    });
    child.once("exit", (code, signal) => {
      if (missing) return;
      if (signal !== null) resolve("failed");
      else if (code === 0) resolve("acquired");
      else if (code === 1) resolve("busy");
      else resolve("failed");
    });
  });
}

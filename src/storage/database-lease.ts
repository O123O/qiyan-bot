import { constants as fsConstants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AdvisoryLockUnavailableError, tryAcquireAdvisoryLock } from "../core/advisory-lock.ts";
import { AppError } from "../core/errors.ts";

export interface DatabaseLease {
  release(): Promise<void>;
}

interface DatabaseLeaseOptions {
  expectedUid?: number;
  afterLock?: () => Promise<void>;
}

const unsafeLock = "QiYan Bot state database lock is unsafe";
const changedLock = "QiYan Bot state database lock changed unexpectedly";

export async function acquireDatabaseLease(
  databasePath: string,
  options: DatabaseLeaseOptions = {},
): Promise<DatabaseLease> {
  if (process.platform !== "linux") throw configuration("Safe QiYan Bot state database locking requires Linux");
  const expectedUid = options.expectedUid ?? process.geteuid?.() ?? process.getuid?.();
  if (expectedUid === undefined) throw configuration(unsafeLock);
  const lockPath = join(dirname(databasePath), `.${basename(databasePath)}.lock`);
  let file: FileHandle | undefined;
  try {
    try {
      file = await open(lockPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK, 0o600);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      file = await open(lockPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    }

    let pinned = await file.stat({ bigint: true });
    if (!pinned.isFile() || pinned.uid !== BigInt(expectedUid) || pinned.nlink !== 1n) throw configuration(unsafeLock);
    if ((pinned.mode & 0o777n) !== 0o600n) {
      await file.chmod(0o600);
      await file.sync();
      pinned = await file.stat({ bigint: true });
      if (!pinned.isFile() || pinned.uid !== BigInt(expectedUid) || pinned.nlink !== 1n || (pinned.mode & 0o777n) !== 0o600n) {
        throw configuration(unsafeLock);
      }
    }

    let acquired: boolean;
    try { acquired = await tryAcquireAdvisoryLock(file.fd); }
    catch (error) {
      if (error instanceof AdvisoryLockUnavailableError) {
        throw configuration("Safe QiYan Bot state database locking is unavailable");
      }
      throw configuration("QiYan Bot state database lock could not be acquired safely");
    }
    if (!acquired) throw configuration("QiYan Bot state database is already in use");

    await options.afterLock?.();
    const held = await file.stat({ bigint: true });
    const current = await lstat(lockPath, { bigint: true }).catch(() => undefined);
    if (
      !held.isFile()
      || held.dev !== pinned.dev
      || held.ino !== pinned.ino
      || held.uid !== pinned.uid
      || held.nlink !== 1n
      || (held.mode & 0o777n) !== 0o600n
      || !current?.isFile()
      || current.isSymbolicLink()
      || current.dev !== pinned.dev
      || current.ino !== pinned.ino
      || current.uid !== pinned.uid
      || current.nlink !== 1n
      || (current.mode & 0o777n) !== 0o600n
    ) throw configuration(changedLock);

    const retained = file;
    file = undefined;
    let release: Promise<void> | undefined;
    return {
      release: () => {
        release ??= retained.close();
        return release;
      },
    };
  } catch (error) {
    await file?.close().catch(() => undefined);
    if (error instanceof AppError) throw error;
    throw configuration(unsafeLock);
  }
}

function configuration(message: string): AppError {
  return new AppError("CONFIGURATION_ERROR", message);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

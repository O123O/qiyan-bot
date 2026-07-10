import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { AdvisoryLockUnavailableError, tryAcquireAdvisoryLock } from "../../core/advisory-lock.ts";
import { AppError } from "../../core/errors.ts";
import { validateTencentUrl } from "./endpoint-policy.ts";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

const credentialDocumentSchema = z.object({
  version: z.literal(1),
  account_generation_id: z.uuid(),
  credential_revision_id: z.uuid(),
  ilink_bot_id: z.string().min(1).max(1024),
  ilink_user_id: z.string().min(1).max(1024),
  bot_token: z.string().min(1).max(16 * 1024),
  api_base_url: z.string().min(1).max(16 * 1024),
  authenticated_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

const confirmedCredentialSchema = z.object({
  botId: z.string().min(1).max(1024),
  ownerUserId: z.string().min(1).max(1024),
  botToken: z.string().min(1).max(16 * 1024),
  apiBaseUrl: z.string().min(1).max(16 * 1024),
  authenticatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

type CredentialDocument = z.infer<typeof credentialDocumentSchema>;

export interface ConfirmedWeixinCredential {
  botId: string;
  ownerUserId: string;
  botToken: string;
  apiBaseUrl: string;
  authenticatedAt: number;
}

export interface WeixinCredential {
  accountGenerationId: string;
  credentialRevisionId: string;
  botId: string;
  ownerUserId: string;
  botToken: string;
  apiBaseUrl: string;
  authenticatedAt: number;
}

export interface WeixinCredentialPublic {
  accountGenerationId: string;
  credentialRevisionId: string;
  botId: string;
  ownerUserId: string;
  apiBaseUrl: string;
}

export interface WeixinCredentialHandle {
  readonly public: Readonly<WeixinCredentialPublic>;
  withVerifiedCredential<T>(operation: (credential: Readonly<WeixinCredential>) => Promise<T>): Promise<T>;
}

type WriteStep = "credentials-directory-synced" | "temporary-opened" | "temporary-synced" | "renamed" | "directory-synced";

interface StoreOptions {
  expectedUid?: number;
  beforeRename?: () => Promise<void>;
  observeWriteStep?: (step: WriteStep) => void;
}

interface DirectoryPin {
  path: string;
  dev: bigint;
  ino: bigint;
  uid: bigint;
}

interface FilePin extends DirectoryPin {
  size: bigint;
  digest: string;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface LockPin extends DirectoryPin {
  nlink: bigint;
}

interface PreparedPaths {
  credentialPath: string;
  directories: readonly DirectoryPin[];
  credentialDirectory: DirectoryPin;
}

interface CredentialState {
  credential: WeixinCredential;
  pin: FilePin;
}

export class WeixinCredentialStore {
  private readonly qiyanHome: string;
  private readonly expectedUid: number | undefined;

  constructor(qiyanHome: string, private readonly options: StoreOptions = {}) {
    this.qiyanHome = resolve(qiyanHome);
    this.expectedUid = options.expectedUid ?? process.geteuid?.();
  }

  async loadPinned(): Promise<WeixinCredentialHandle | undefined> {
    try {
      const paths = await this.preparePaths();
      const state = await this.readCredential(paths.credentialPath, true);
      if (!state) return undefined;
      for (const pin of paths.directories) await this.assertDirectoryPin(pin);
      const credential = Object.freeze({ ...state.credential });
      const publicCredential = Object.freeze(toPublic(credential));
      const pins = [...paths.directories];
      const filePin = state.pin;
      return {
        public: publicCredential,
        withVerifiedCredential: async <T>(operation: (value: Readonly<WeixinCredential>) => Promise<T>): Promise<T> => {
          for (const pin of pins) await this.assertDirectoryPin(pin);
          let current: CredentialState | undefined;
          try { current = await this.readCredential(paths.credentialPath, false); }
          catch { throw managedError("WeChat credential file changed unexpectedly"); }
          if (!current || !sameFilePin(current.pin, filePin)) throw managedError("WeChat credential file changed unexpectedly");
          return operation(credential);
        },
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw managedError("cannot load WeChat credentials");
    }
  }

  async commitConfirmed(input: ConfirmedWeixinCredential): Promise<WeixinCredentialPublic> {
    try {
      const parsed = confirmedCredentialSchema.parse(input);
      const apiBaseUrl = validateApiBaseUrl(parsed.apiBaseUrl);
      const paths = await this.preparePaths();
      return await this.withCredentialLock(paths, async (directory, directoryEntryRoot, lock) => {
        const existing = await this.readCredential(
          join(directoryEntryRoot, "weixin.json"),
          true,
          paths.credentialPath,
        );
        const accountGenerationId = existing
          && existing.credential.botId === parsed.botId
          && existing.credential.ownerUserId === parsed.ownerUserId
          ? existing.credential.accountGenerationId
          : randomUUID();
        const document: CredentialDocument = {
          version: 1,
          account_generation_id: accountGenerationId,
          credential_revision_id: randomUUID(),
          ilink_bot_id: parsed.botId,
          ilink_user_id: parsed.ownerUserId,
          bot_token: parsed.botToken,
          api_base_url: apiBaseUrl,
          authenticated_at: parsed.authenticatedAt,
        };
        await this.atomicWrite(
          paths,
          directory,
          directoryEntryRoot,
          lock,
          Buffer.from(`${JSON.stringify(document, null, 2)}\n`),
          existing?.pin,
        );
        return toPublic(fromDocument(document));
      });
    } catch (error) {
      if (error instanceof AppError && error.message.startsWith("WeChat credential")) throw error;
      throw managedError("cannot store WeChat credentials");
    }
  }

  private async preparePaths(): Promise<PreparedPaths> {
    const home = await this.requireDirectory(this.qiyanHome, false, "QiYan home");
    const credentialsPath = join(this.qiyanHome, "credentials");
    let created = false;
    try {
      await mkdir(credentialsPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const credentials = await this.requireDirectory(credentialsPath, true, "WeChat credentials directory");
    await this.assertDirectoryPin(home);
    if (created) {
      await this.syncDirectoryPin(home);
      this.options.observeWriteStep?.("credentials-directory-synced");
    }
    return {
      credentialPath: join(credentialsPath, "weixin.json"),
      directories: [home, credentials],
      credentialDirectory: credentials,
    };
  }

  private async requireDirectory(path: string, repairMode: boolean, label: string): Promise<DirectoryPin> {
    const initial = await lstat(path, { bigint: true });
    if (!initial.isDirectory() || initial.isSymbolicLink()) throw managedError(`${label} must be a real directory`);
    this.assertOwner(initial.uid, label);
    const directory = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      let opened = await directory.stat({ bigint: true });
      if (!opened.isDirectory() || opened.dev !== initial.dev || opened.ino !== initial.ino) throw managedError(`${label} changed unexpectedly`);
      this.assertOwner(opened.uid, label);
      if (await realpath(path) !== path) throw managedError(`${label} must use its canonical path`);
      if (repairMode && (opened.mode & 0o777n) !== 0o700n) {
        await directory.chmod(0o700);
        await directory.sync();
        opened = await directory.stat({ bigint: true });
      }
      const current = await lstat(path, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
        throw managedError(`${label} changed unexpectedly`);
      }
      this.assertOwner(current.uid, label);
      if ((current.mode & 0o777n) !== 0o700n) throw managedError(`${label} must have private mode 0700`);
      return { path, dev: current.dev, ino: current.ino, uid: current.uid };
    } finally {
      await directory.close();
    }
  }

  private async assertDirectoryPin(pin: DirectoryPin): Promise<void> {
    let current;
    try { current = await lstat(pin.path, { bigint: true }); }
    catch { throw managedError(`WeChat credential directory changed unexpectedly`); }
    if (
      !current.isDirectory()
      || current.isSymbolicLink()
      || current.dev !== pin.dev
      || current.ino !== pin.ino
      || current.uid !== pin.uid
      || (current.mode & 0o777n) !== 0o700n
      || await realpath(pin.path).catch(() => undefined) !== pin.path
    ) throw managedError("WeChat credential directory changed unexpectedly");
  }

  private async readCredential(path: string, repairMode: boolean, canonicalPath = path): Promise<CredentialState | undefined> {
    let initial;
    try { initial = await lstat(path, { bigint: true }); }
    catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    if (!initial.isFile() || initial.isSymbolicLink()) throw managedError("WeChat credential must be a regular file, not a symlink");
    this.assertOwner(initial.uid, "WeChat credential file");
    if (initial.nlink !== 1n) throw managedError("WeChat credential file must not have a hard link");

    let file;
    try { file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
    catch { throw managedError("WeChat credential file cannot be opened safely"); }
    try {
      let opened = await file.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== initial.dev || opened.ino !== initial.ino || opened.nlink !== 1n) {
        throw managedError("WeChat credential file changed unexpectedly");
      }
      this.assertOwner(opened.uid, "WeChat credential file");
      const bytes = await readBounded(file, MAX_CREDENTIAL_BYTES);
      const afterRead = await file.stat({ bigint: true });
      if (
        afterRead.dev !== opened.dev
        || afterRead.ino !== opened.ino
        || afterRead.size !== BigInt(bytes.length)
        || afterRead.mtimeNs !== opened.mtimeNs
        || afterRead.ctimeNs !== opened.ctimeNs
      ) throw managedError("WeChat credential file changed unexpectedly");
      opened = afterRead;
      let document: CredentialDocument;
      try { document = credentialDocumentSchema.parse(JSON.parse(bytes.toString("utf8"))) as CredentialDocument; }
      catch { throw managedError("WeChat credential file is invalid"); }
      const canonicalBaseUrl = validateApiBaseUrl(document.api_base_url);
      if (canonicalBaseUrl !== document.api_base_url) throw managedError("WeChat credential file is invalid");
      if (repairMode && (opened.mode & 0o777n) !== 0o600n) {
        await file.chmod(0o600);
        opened = await file.stat({ bigint: true });
      }
      const current = await lstat(path, { bigint: true });
      if (
        !current.isFile()
        || current.isSymbolicLink()
        || current.dev !== opened.dev
        || current.ino !== opened.ino
        || current.uid !== opened.uid
        || current.nlink !== 1n
        || current.size !== opened.size
        || current.mtimeNs !== opened.mtimeNs
        || current.ctimeNs !== opened.ctimeNs
        || (current.mode & 0o777n) !== 0o600n
        || await realpath(path).catch(() => undefined) !== canonicalPath
      ) throw managedError("WeChat credential file changed unexpectedly");
      return {
        credential: fromDocument(document),
        pin: {
          path: canonicalPath,
          dev: current.dev,
          ino: current.ino,
        uid: current.uid,
        size: BigInt(bytes.length),
        digest: createHash("sha256").update(bytes).digest("hex"),
        mtimeNs: current.mtimeNs,
        ctimeNs: current.ctimeNs,
        },
      };
    } finally {
      await file.close();
    }
  }

  private async atomicWrite(
    paths: PreparedPaths,
    directory: Awaited<ReturnType<typeof open>>,
    directoryEntryRoot: string,
    lock: { file: Awaited<ReturnType<typeof open>>; pin: LockPin },
    bytes: Uint8Array,
    prior?: FilePin,
  ): Promise<void> {
    const temporaryName = `.${basename(paths.credentialPath)}.${process.pid}.${randomUUID()}.tmp`;
    const temporary = join(directoryEntryRoot, temporaryName);
    const target = join(directoryEntryRoot, "weixin.json");
    try {
      const file = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      this.options.observeWriteStep?.("temporary-opened");
      try {
        await file.writeFile(bytes);
        await file.sync();
        this.options.observeWriteStep?.("temporary-synced");
      } finally {
        await file.close();
      }
      await this.options.beforeRename?.();
      for (const pin of paths.directories) await this.assertDirectoryPin(pin);
      await this.assertDirectoryHandle(directory, paths.credentialDirectory);
      await this.assertLockHandle(lock.file, lock.pin);
      const current = await this.readCredential(target, false, paths.credentialPath);
      if ((prior === undefined) !== (current === undefined) || (prior && current && !sameFilePin(prior, current.pin))) {
        throw managedError("WeChat credential file changed unexpectedly");
      }
      await rename(temporary, target);
      this.options.observeWriteStep?.("renamed");
      for (const pin of paths.directories) await this.assertDirectoryPin(pin);
      await this.assertDirectoryHandle(directory, paths.credentialDirectory);
      await this.assertLockHandle(lock.file, lock.pin);
      const written = await this.readCredential(target, false, paths.credentialPath);
      if (!written || written.pin.digest !== createHash("sha256").update(bytes).digest("hex")) {
        throw managedError("WeChat credential file changed unexpectedly");
      }
      await directory.sync();
      this.options.observeWriteStep?.("directory-synced");
    } finally {
      await unlink(temporary).catch((error) => { if (!isErrno(error, "ENOENT")) throw error; });
    }
  }

  private async withCredentialLock<T>(
    paths: PreparedPaths,
    action: (
      directory: Awaited<ReturnType<typeof open>>,
      directoryEntryRoot: string,
      lock: { file: Awaited<ReturnType<typeof open>>; pin: LockPin },
    ) => Promise<T>,
  ): Promise<T> {
    if (process.platform !== "linux") throw managedError("safe WeChat credential updates require Linux");
    const directory = await open(paths.credentialDirectory.path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const directoryEntryRoot = `/proc/self/fd/${directory.fd}`;
    const lockPath = join(directoryEntryRoot, ".weixin.lock");
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await this.assertDirectoryHandle(directory, paths.credentialDirectory);
      let created = false;
      try {
        lock = await open(lockPath, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
        created = true;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        try { lock = await open(lockPath, fsConstants.O_RDWR | fsConstants.O_NOFOLLOW); }
        catch { throw managedError("WeChat credential lock is unsafe"); }
      }
      let value = await lock.stat({ bigint: true });
      this.assertOwner(value.uid, "WeChat credential lock");
      if (!value.isFile() || value.nlink !== 1n) throw managedError("WeChat credential lock is unsafe");
      const acquired = await acquireAdvisoryLock(lock.fd);
      if (!acquired) throw managedError("WeChat credential update is already in progress");
      if ((value.mode & 0o777n) !== 0o600n) {
        await lock.chmod(0o600);
        await lock.sync();
        value = await lock.stat({ bigint: true });
      }
      const pin: LockPin = {
        path: join(paths.credentialDirectory.path, ".weixin.lock"),
        dev: value.dev,
        ino: value.ino,
        uid: value.uid,
        nlink: value.nlink,
      };
      await this.assertLockHandle(lock, pin);
      if (created) await directory.sync();
      return await action(directory, directoryEntryRoot, { file: lock, pin });
    } finally {
      await lock?.close().catch(() => undefined);
      await directory.close();
    }
  }

  private async syncDirectoryPin(pin: DirectoryPin): Promise<void> {
    const directory = await open(pin.path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      await this.assertDirectoryHandle(directory, pin);
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  private async assertDirectoryHandle(directory: Awaited<ReturnType<typeof open>>, pin: DirectoryPin): Promise<void> {
    const value = await directory.stat({ bigint: true });
    if (!value.isDirectory() || value.dev !== pin.dev || value.ino !== pin.ino || value.uid !== pin.uid || (value.mode & 0o777n) !== 0o700n) {
      throw managedError("WeChat credential directory changed unexpectedly");
    }
  }

  private async assertLockHandle(lock: Awaited<ReturnType<typeof open>>, pin: LockPin): Promise<void> {
    const value = await lock.stat({ bigint: true });
    const current = await lstat(pin.path, { bigint: true }).catch(() => undefined);
    if (
      !value.isFile()
      || value.dev !== pin.dev
      || value.ino !== pin.ino
      || value.uid !== pin.uid
      || value.nlink !== pin.nlink
      || (value.mode & 0o777n) !== 0o600n
      || !current?.isFile()
      || current.isSymbolicLink()
      || current.dev !== pin.dev
      || current.ino !== pin.ino
      || current.uid !== pin.uid
      || current.nlink !== pin.nlink
    ) throw managedError("WeChat credential lock changed unexpectedly");
  }

  private assertOwner(uid: bigint, label: string): void {
    if (this.expectedUid !== undefined && uid !== BigInt(this.expectedUid)) throw managedError(`${label} must be owned by the current user`);
  }
}

async function readBounded(file: Awaited<ReturnType<typeof open>>, maxBytes: number): Promise<Buffer> {
  const bytes = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > maxBytes) throw managedError("WeChat credential file is too large");
  return bytes.subarray(0, offset);
}

function validateApiBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw managedError("WeChat credential file is invalid"); }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") throw managedError("WeChat credential file is invalid");
  validateTencentUrl(new URL("/ilink/bot/getconfig", url), "get-config");
  return url.origin;
}

function fromDocument(document: CredentialDocument): WeixinCredential {
  return {
    accountGenerationId: document.account_generation_id,
    credentialRevisionId: document.credential_revision_id,
    botId: document.ilink_bot_id,
    ownerUserId: document.ilink_user_id,
    botToken: document.bot_token,
    apiBaseUrl: document.api_base_url,
    authenticatedAt: document.authenticated_at,
  };
}

function toPublic(credential: WeixinCredential): WeixinCredentialPublic {
  return {
    accountGenerationId: credential.accountGenerationId,
    credentialRevisionId: credential.credentialRevisionId,
    botId: credential.botId,
    ownerUserId: credential.ownerUserId,
    apiBaseUrl: credential.apiBaseUrl,
  };
}

function sameFilePin(left: FilePin, right: FilePin): boolean {
  return left.path === right.path
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.size === right.size
    && left.digest === right.digest
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function acquireAdvisoryLock(fd: number): Promise<boolean> {
  try { return await tryAcquireAdvisoryLock(fd); }
  catch (error) {
    if (error instanceof AdvisoryLockUnavailableError) throw managedError("safe WeChat credential locking is unavailable");
    throw managedError("cannot acquire the WeChat credential lock");
  }
}

function managedError(message: string): AppError {
  return new AppError("CONFIGURATION_ERROR", message);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

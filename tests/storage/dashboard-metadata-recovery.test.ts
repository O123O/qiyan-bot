import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, chown, link, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { openDatabase } from "../../src/storage/database.ts";
import { acquireDatabaseLease } from "../../src/storage/database-lease.ts";
import {
  installPreparedDashboardMetadataRecovery,
  prepareDashboardMetadataRecovery,
  recoverDashboardMetadata,
  RECOVERY_TABLES,
  type RecoveryInstallStep,
} from "../../src/storage/dashboard-metadata-recovery.ts";
import { runConversationRoutingBackfill } from "../../src/storage/conversation-cutover.ts";

interface Watermarks {
  notification?: number;
  settings?: number;
  token?: number;
  goal?: number;
  runtime?: number;
}

test("recovery copies every readable table exactly and rebuilds only dashboard metadata", async (t) => {
  const value = await recoveryFixture(t, { notification: 4, settings: 7, token: 12, goal: 9, runtime: 11 });
  const sourceBefore = await readFile(value.databasePath);
  const reported: string[] = [];

  const prepared = await prepareDashboardMetadataRecovery(value.databasePath, {
    onBackupComplete: (path) => { reported.push(path); },
  });

  assert.deepEqual(reported, [prepared.quarantinePath]);
  assert.deepEqual(await readFile(value.databasePath), sourceBefore);
  assert.equal(prepared.copiedTableCount, RECOVERY_TABLES.length - 1);
  assert.equal(prepared.nextObservationSequence, 13);
  assert.doesNotMatch(JSON.stringify(prepared), /private project note|private operation result/u);

  const candidate = new DatabaseSync(prepared.candidatePath, { readOnly: true });
  const note = candidate.prepare("SELECT project_summary, supervision_objective FROM session_manager_notes").get()!;
  assert.equal(note.project_summary, "private project note");
  assert.equal(note.supervision_objective, "private operation result");
  assert.deepEqual({ ...candidate.prepare("SELECT * FROM session_dashboard_meta").get()! }, {
    singleton: 1,
    assistant_root: null,
    dirty: 1,
    revision: 0,
    next_observation_sequence: 13,
    last_render_error: null,
    render_failure_generation: 0,
  });
  assert.equal(candidate.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");
  assert.equal(candidate.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  assert.deepEqual(candidate.prepare("PRAGMA foreign_key_check").all(), []);
  candidate.close();

  const manifest = JSON.parse(await readFile(join(prepared.quarantinePath, "manifest.json"), "utf8")) as Record<string, unknown>;
  assert.equal(manifest.state, "backup_complete");
  assert.equal(manifest.canonical_basename, "bot.sqlite3");
  assert.doesNotMatch(JSON.stringify(manifest), /private project note|private operation result|\/tmp\//u);
});

test("each persisted watermark can independently determine the next observation sequence", async (t) => {
  for (const key of ["notification", "settings", "token", "goal", "runtime"] as const) {
    const value = await recoveryFixture(t, { [key]: 41 });
    const prepared = await prepareDashboardMetadataRecovery(value.databasePath);
    assert.equal(prepared.nextObservationSequence, 42, key);
    const candidate = new DatabaseSync(prepared.candidatePath, { readOnly: true });
    assert.equal(candidate.prepare("SELECT next_observation_sequence AS value FROM session_dashboard_meta").get()!.value, 42);
    candidate.close();
  }
});

test("recovery reads committed hot-WAL rows from its read-only working copy", async (t) => {
  const value = await recoveryFixture(t);
  const script = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0;");
    db.exec("UPDATE telegram_state SET next_update_id = 99 WHERE singleton = 1");
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, value.databasePath], { encoding: "utf8", env: {} });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");

  const ignoresWal = new DatabaseSync(`file:${value.databasePath}?immutable=1`, { readOnly: true });
  assert.equal(ignoresWal.prepare("SELECT next_update_id FROM telegram_state").get()!.next_update_id, 0);
  ignoresWal.close();
  const seesWal = new DatabaseSync(value.databasePath, { readOnly: true });
  assert.equal(seesWal.prepare("SELECT next_update_id FROM telegram_state").get()!.next_update_id, 99);
  seesWal.close();

  const before = await artifactBytes(value.databasePath);
  const prepared = await prepareDashboardMetadataRecovery(value.databasePath);
  const after = await artifactBytes(value.databasePath);
  assert.deepEqual(after, before);
  const candidate = new DatabaseSync(prepared.candidatePath, { readOnly: true });
  assert.equal(candidate.prepare("SELECT next_update_id FROM telegram_state").get()!.next_update_id, 99);
  candidate.close();
});

test("recovery rejects unsafe observation watermarks and removes its candidate", async (t) => {
  for (const watermark of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
    const value = await recoveryFixture(t, { settings: watermark });
    let quarantinePath: string | undefined;
    let failure: unknown;
    try {
      await prepareDashboardMetadataRecovery(value.databasePath, {
        onBackupComplete: (path) => { quarantinePath = path; },
      });
    } catch (error) { failure = error; }

    assert.equal(failure instanceof AppError && failure.code === "CONFIGURATION_ERROR"
      && failure.message === "QiYan Bot state database recovery failed; retained backup was not installed", true);
    assert.notEqual(quarantinePath, undefined);
    await assert.rejects(access(join(quarantinePath!, "candidate.sqlite3")));
    assert.equal(JSON.parse(await readFile(join(quarantinePath!, "manifest.json"), "utf8")).state, "backup_complete");
  }
});

test("structural validation ignores stored SQL formatting but rejects unexpected schema", async (t) => {
  const formatted = await recoveryFixture(t, {}, (db) => {
    rewriteSchemaSql(db, "qiyan_state", (sql) => sql.replace("CREATE TABLE qiyan_state", "CREATE  TABLE qiyan_state"));
  });
  const prepared = await prepareDashboardMetadataRecovery(formatted.databasePath);
  assert.equal(prepared.copiedTableCount, RECOVERY_TABLES.length - 1);

  const changed = await recoveryFixture(t, {}, (db) => {
    db.exec("CREATE INDEX unexpected_recovery_index ON session_manager_notes(project_summary)");
  });
  let quarantinePath: string | undefined;
  await assert.rejects(prepareDashboardMetadataRecovery(changed.databasePath, {
    onBackupComplete: (path) => { quarantinePath = path; },
  }), (error: unknown) => error instanceof AppError
    && error.message === "QiYan Bot state database recovery failed; retained backup was not installed");
  assert.notEqual(quarantinePath, undefined);
  await assert.rejects(access(join(quarantinePath!, "candidate.sqlite3")));

  const changedConstraint = await recoveryFixture(t, {}, (db) => {
    rewriteSchemaSql(db, "qiyan_state", (sql) => sql.replace("state_version INTEGER NOT NULL", "state_version INTEGER"));
  });
  await assert.rejects(prepareDashboardMetadataRecovery(changedConstraint.databasePath), (error: unknown) => error instanceof AppError
    && error.message === "QiYan Bot state database recovery failed; retained backup was not installed");
});

test("an unreadable authoritative table fails without exposing rows and leaves the source unchanged", async (t) => {
  const value = await recoveryFixture(t, {}, undefined, "session_manager_notes");
  const sourceBefore = await readFile(value.databasePath);
  let quarantinePath: string | undefined;
  let failure: unknown;
  try {
    await prepareDashboardMetadataRecovery(value.databasePath, {
      onBackupComplete: (path) => { quarantinePath = path; },
    });
  } catch (error) { failure = error; }

  assert.equal(failure instanceof AppError && failure.code === "CONFIGURATION_ERROR"
    && failure.message === "QiYan Bot state database recovery failed; retained backup was not installed", true);
  assert.doesNotMatch(failure instanceof Error ? failure.message : "", /private project note|private operation result/u);
  assert.deepEqual(await readFile(value.databasePath), sourceBefore);
  assert.notEqual(quarantinePath, undefined);
  await assert.rejects(access(join(quarantinePath!, "candidate.sqlite3")));
});

test("source races cannot publish an inconsistent backup manifest", async (t) => {
  for (const race of ["mutate", "add", "remove", "replace"] as const) {
    const value = await recoveryFixture(t);
    if (race === "remove") await writeFile(`${value.databasePath}-journal`, "stable-journal", { mode: 0o600 });
    let scratchPath: string | undefined;
    const reported: string[] = [];
    let failure: unknown;
    try {
      await prepareDashboardMetadataRecovery(value.databasePath, {
        beforeBackupComplete: async (path) => {
          scratchPath = path;
          if (race === "mutate") {
            const file = await open(value.databasePath, "r+");
            try { await file.write(Buffer.from([0x51]), 0, 1, 0); }
            finally { await file.close(); }
          } else if (race === "add") {
            await writeFile(`${value.databasePath}-wal`, "new-sidecar", { mode: 0o600 });
          } else if (race === "remove") {
            await rm(`${value.databasePath}-journal`);
          } else {
            const bytes = await readFile(value.databasePath);
            await rename(value.databasePath, `${value.databasePath}.replaced`);
            await writeFile(value.databasePath, bytes, { mode: 0o600 });
          }
        },
        onBackupComplete: (path) => { reported.push(path); },
      });
    } catch (error) { failure = error; }

    assert.equal(failure instanceof AppError && failure.code === "CONFIGURATION_ERROR"
      && failure.message === "QiYan Bot state database recovery source is unsafe", true, race);
    assert.deepEqual(reported, [], race);
    assert.notEqual(scratchPath, undefined, race);
    await assert.rejects(access(join(scratchPath!, "manifest.json")));
    await assert.rejects(access(scratchPath!));
  }
});

test("recovery rejects unsafe parent and artifact identities before publishing a backup", async (t) => {
  {
    const value = await recoveryFixture(t);
    await chmod(value.root, 0o770);
    await assert.rejects(prepareDashboardMetadataRecovery(value.databasePath), (error: unknown) => error instanceof AppError
      && error.message === "QiYan Bot state database recovery source is unsafe");
  }

  for (const artifactCase of ["main-symlink", "sidecar-symlink", "main-hardlink", "sidecar-fifo"] as const) {
    const value = await recoveryFixture(t);
    if (artifactCase === "main-symlink") {
      const target = join(value.root, "original.sqlite3");
      await rename(value.databasePath, target);
      await symlink(target, value.databasePath);
    } else if (artifactCase === "sidecar-symlink") {
      const target = join(value.root, "sidecar-target");
      await writeFile(target, "sidecar", { mode: 0o600 });
      await symlink(target, `${value.databasePath}-wal`);
    } else if (artifactCase === "main-hardlink") {
      await link(value.databasePath, join(value.root, "second-link.sqlite3"));
    } else {
      const child = spawnSync("mkfifo", [`${value.databasePath}-shm`], { encoding: "utf8" });
      assert.equal(child.status, 0);
    }
    await assert.rejects(prepareDashboardMetadataRecovery(value.databasePath), (error: unknown) => error instanceof AppError
      && error.message === "QiYan Bot state database recovery source is unsafe", artifactCase);
  }

  if (process.geteuid?.() === 0) {
    const value = await recoveryFixture(t);
    await chown(value.databasePath, 1, 1);
    await assert.rejects(prepareDashboardMetadataRecovery(value.databasePath), (error: unknown) => error instanceof AppError
      && error.message === "QiYan Bot state database recovery source is unsafe");
  }
});

test("recovery rejects replacement of its validated parent directory", async (t) => {
  const value = await recoveryFixture(t);
  const bytes = await readFile(value.databasePath);
  const movedRoot = `${value.root}-moved`;
  t.after(() => rm(movedRoot, { recursive: true, force: true }));
  const reported: string[] = [];

  await assert.rejects(prepareDashboardMetadataRecovery(value.databasePath, {
    afterParentValidation: async () => {
      await rename(value.root, movedRoot);
      await mkdir(value.root, { mode: 0o700 });
      await writeFile(value.databasePath, bytes, { mode: 0o600 });
    },
    onBackupComplete: (path) => { reported.push(path); },
  }), (error: unknown) => error instanceof AppError
    && error.message === "QiYan Bot state database recovery source is unsafe");
  assert.deepEqual(reported, []);
});

test("installation displaces the complete old artifact generation and advances the manifest", async (t) => {
  const value = await recoveryFixture(t);
  await createHotWal(value.databasePath);
  await writeFile(`${value.databasePath}-journal`, "", { mode: 0o600 });
  const before = await artifactBytes(value.databasePath);
  assert.deepEqual(Object.keys(before).sort(), ["-journal", "-shm", "-wal", "main"]);
  const prepared = await prepareDashboardMetadataRecovery(value.databasePath);

  await installPreparedDashboardMetadataRecovery(prepared);

  const manifest = JSON.parse(await readFile(join(prepared.quarantinePath, "manifest.json"), "utf8")) as Record<string, unknown>;
  assert.equal(manifest.state, "installed");
  await assert.rejects(access(prepared.candidatePath));
  for (const [key, bytes] of Object.entries(before)) {
    const suffix = key === "main" ? "" : key;
    const name = `bot.sqlite3${suffix}`;
    assert.equal((await readFile(join(prepared.quarantinePath, "backup", name))).toString("base64"), bytes);
    assert.equal((await readFile(join(prepared.quarantinePath, "displaced", name))).toString("base64"), bytes);
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) await assert.rejects(access(`${value.databasePath}${suffix}`));
  const installed = new DatabaseSync(value.databasePath, { readOnly: true });
  assert.equal(installed.prepare("SELECT next_update_id FROM telegram_state").get()!.next_update_id, 99);
  assert.equal(installed.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  installed.close();
});

test("ordinary installation failures restore originals, clean the candidate, and record rollback", async (t) => {
  const failureSteps: RecoveryInstallStep[] = [
    "write-installing",
    "move-original",
    "install-candidate",
    "sync-installed",
    "write-installed",
  ];
  for (const failureStep of failureSteps) {
    const value = await recoveryFixture(t);
    const before = await readFile(value.databasePath);
    const prepared = await prepareDashboardMetadataRecovery(value.databasePath);
    await assert.rejects(installPreparedDashboardMetadataRecovery(prepared, {
      beforeStep: async (step) => { if (step === failureStep) throw new Error("secret injected install failure"); },
    }), (error: unknown) => error instanceof AppError
      && error.message === "QiYan Bot state database recovery installation failed; original state was restored");

    assert.deepEqual(await readFile(value.databasePath), before, failureStep);
    await assert.rejects(access(prepared.candidatePath));
    assert.equal(JSON.parse(await readFile(join(prepared.quarantinePath, "manifest.json"), "utf8")).state, "rolled_back");
  }
});

test("partial multi-artifact displacement and published-candidate failures restore the exact generation", async (t) => {
  for (const failure of ["partial-displacement", "published-candidate"] as const) {
    const value = await recoveryFixture(t);
    await createHotWal(value.databasePath);
    await writeFile(`${value.databasePath}-journal`, "", { mode: 0o600 });
    const before = await artifactBytes(value.databasePath);
    const prepared = await prepareDashboardMetadataRecovery(value.databasePath);

    await assert.rejects(installPreparedDashboardMetadataRecovery(prepared, {
      beforeStep: async (step, detail) => {
        if (failure === "partial-displacement" && step === "move-original" && detail === "bot.sqlite3-shm") {
          throw new Error("secret partial displacement failure");
        }
        if (failure === "published-candidate" && step === "sync-installed") {
          throw new Error("secret post-publication failure");
        }
      },
    }), (error: unknown) => error instanceof AppError
      && error.message === "QiYan Bot state database recovery installation failed; original state was restored");

    assert.deepEqual(await artifactBytes(value.databasePath), before, failure);
    await assert.rejects(access(prepared.candidatePath));
    const manifest = JSON.parse(await readFile(join(prepared.quarantinePath, "manifest.json"), "utf8")) as {
      state: unknown;
      artifacts: Array<{ name: string; sha256: string }>;
    };
    assert.equal(manifest.state, "rolled_back");
    for (const artifact of manifest.artifacts) {
      const key = artifact.name === "bot.sqlite3" ? "main" : artifact.name.slice("bot.sqlite3".length);
      assert.equal(artifact.sha256, sha256(Buffer.from(before[key]!, "base64")), `${failure}:${artifact.name}`);
    }
  }
});

test("pre-install source, candidate, and backup tampering aborts without a restoration claim", async (t) => {
  for (const tamper of ["source", "candidate", "backup"] as const) {
    const value = await recoveryFixture(t);
    const prepared = await prepareDashboardMetadataRecovery(value.databasePath);
    const sourceBefore = await readFile(value.databasePath);
    const target = tamper === "source"
      ? value.databasePath
      : tamper === "candidate"
        ? prepared.candidatePath
        : join(prepared.quarantinePath, "backup", "bot.sqlite3");
    const file = await open(target, "r+");
    try { await file.write(Buffer.from([0x51]), 0, 1, 0); }
    finally { await file.close(); }
    const sourceAfterTamper = await readFile(value.databasePath);

    await assert.rejects(installPreparedDashboardMetadataRecovery(prepared), (error: unknown) => error instanceof AppError
      && error.message === "QiYan Bot state database recovery installation validation failed; candidate was not installed");
    const expectedSource = tamper === "source" ? sourceAfterTamper : sourceBefore;
    assert.deepEqual(await readFile(value.databasePath), expectedSource, tamper);
    assert.equal(JSON.parse(await readFile(join(prepared.quarantinePath, "manifest.json"), "utf8")).state, "backup_complete");
    await assert.rejects(access(prepared.candidatePath));
  }
});

test("rollback failure retains an installing manifest and gives only manual-restore guidance", async (t) => {
  const value = await recoveryFixture(t);
  await createHotWal(value.databasePath);
  await writeFile(`${value.databasePath}-journal`, "", { mode: 0o600 });
  const before = await artifactBytes(value.databasePath);
  const prepared = await prepareDashboardMetadataRecovery(value.databasePath);

  await assert.rejects(installPreparedDashboardMetadataRecovery(prepared, {
    beforeStep: async (step) => {
      if (step === "install-candidate") throw new Error("secret original install failure");
      if (step === "restore-original") throw new Error("secret rollback failure");
    },
  }), (error: unknown) => error instanceof AppError
    && error.message === "QiYan Bot state database recovery installation failed; manual restore is required from retained quarantine"
    && !/secret/u.test(error.message));

  const manifest = JSON.parse(await readFile(join(prepared.quarantinePath, "manifest.json"), "utf8")) as {
    state: unknown;
    artifacts: Array<{ name: string; sha256: string }>;
  };
  assert.equal(manifest.state, "installing");
  for (const artifact of manifest.artifacts) {
    const key = artifact.name === "bot.sqlite3" ? "main" : artifact.name.slice("bot.sqlite3".length);
    const backup = await readFile(join(prepared.quarantinePath, "backup", artifact.name));
    assert.equal(backup.toString("base64"), before[key]);
    assert.equal(sha256(backup), artifact.sha256);
  }
});

test("rollback interference prevents a restored-state claim", async (t) => {
  const value = await recoveryFixture(t);
  const prepared = await prepareDashboardMetadataRecovery(value.databasePath);

  await assert.rejects(installPreparedDashboardMetadataRecovery(prepared, {
    beforeStep: async (step) => {
      if (step === "install-candidate") throw new Error("secret install failure");
      if (step === "sync-rolled-back") {
        const file = await open(value.databasePath, "r+");
        try { await file.write(Buffer.from([0x51]), 0, 1, 0); }
        finally { await file.close(); }
      }
    },
  }), (error: unknown) => error instanceof AppError
    && error.message === "QiYan Bot state database recovery installation failed; manual restore is required from retained quarantine");
  assert.equal(JSON.parse(await readFile(join(prepared.quarantinePath, "manifest.json"), "utf8")).state, "installing");
});

test("the complete recovery operation excludes concurrent database owners and releases its lease", async (t) => {
  const value = await recoveryFixture(t);
  const held = await acquireDatabaseLease(value.databasePath);
  await assert.rejects(recoverDashboardMetadata(value.databasePath), (error: unknown) => error instanceof AppError
    && error.message === "QiYan Bot state database is already in use");
  await held.release();

  const backups: string[] = [];
  const recovered = await recoverDashboardMetadata(value.databasePath, {
    onBackupComplete: (path) => { backups.push(path); },
  });
  assert.deepEqual(backups, [recovered.quarantinePath]);
  const nextOwner = await acquireDatabaseLease(value.databasePath);
  await nextOwner.release();
});

test("lease cleanup failures preserve primary recovery outcomes", async (t) => {
  {
    const value = await recoveryFixture(t);
    await assert.rejects(recoverDashboardMetadata(value.databasePath, {
      acquireLease: async () => ({ release: async () => { throw new Error("secret release failure"); } }),
    }), (error: unknown) => error instanceof AppError
      && error.message === "QiYan Bot state database recovery completed, but database lease cleanup failed; keep the service stopped");
    const installed = new DatabaseSync(value.databasePath, { readOnly: true });
    assert.equal(installed.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
    installed.close();
  }

  {
    const value = await recoveryFixture(t);
    await assert.rejects(recoverDashboardMetadata(value.databasePath, {
      acquireLease: async () => ({ release: async () => { throw new Error("secret release failure"); } }),
      installOptions: {
        beforeStep: async (step) => {
          if (step === "install-candidate") throw new Error("secret install failure");
          if (step === "restore-original") throw new Error("secret rollback failure");
        },
      },
    }), (error: unknown) => error instanceof AppError
      && error.message === "QiYan Bot state database recovery installation failed; manual restore is required from retained quarantine");
  }
});

async function recoveryFixture(
  t: TestContext,
  watermarks: Watermarks = {},
  customize?: (db: DatabaseSync) => void,
  corruptTable = "session_dashboard_meta",
): Promise<{ root: string; databasePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "qiyan-bot-dashboard-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = join(root, "bot.sqlite3");
  const db = openDatabase(databasePath);
  runConversationRoutingBackfill(db);
  db.exec("UPDATE conversation_cutover SET phase = 'complete' WHERE singleton = 1");
  db.exec("UPDATE qiyan_state SET state_version = 3 WHERE product = 'qiyan-bot'");
  db.prepare(`INSERT INTO session_manager_notes
    (endpoint_id, thread_id, project_summary, supervision_objective, pending_follow_up, updated_at)
    VALUES ('local', 'thread-private', 'private project note', 'private operation result', NULL, 1)`).run();
  db.prepare(`INSERT INTO session_rollout_ownership
    (endpoint_id, thread_id, mapping_id, rollout_path, device, inode, byte_offset, external_turn_id, updated_at)
    VALUES ('local', 'thread-private', 'mapping-private', '/private/rollout', '1', '2', 3, NULL, 1)`).run();
  db.prepare(`INSERT INTO session_rollout_owned_turns
    (endpoint_id, thread_id, mapping_id, turn_id, recorded_at)
    VALUES ('local', 'thread-private', 'mapping-private', 'turn-private', 1)`).run();
  if (watermarks.notification !== undefined) {
    db.prepare(`INSERT INTO session_dashboard_notifications
      (sequence, endpoint_id, method, params_json, state, received_at)
      VALUES (?, 'local', 'test/method', '{}', 'completed', 1)`).run(watermarks.notification);
  }
  if (watermarks.settings !== undefined || watermarks.token !== undefined || watermarks.goal !== undefined) {
    db.prepare(`INSERT INTO session_dashboard_facts
      (endpoint_id, thread_id, current_settings_observation_sequence, token_observation_sequence, goal_observation_sequence)
      VALUES ('local', 'thread-private', ?, ?, ?)`).run(
        watermarks.settings ?? null,
        watermarks.token ?? null,
        watermarks.goal ?? null,
      );
  }
  if (watermarks.runtime !== undefined) {
    db.prepare(`INSERT INTO session_runtime
      (endpoint_id, thread_id, mapping_id, management_state, native_status, native_observation_sequence)
      VALUES ('local', 'thread-private', 'mapping-private', 'managed', 'idle', ?)`).run(watermarks.runtime);
  }
  customize?.(db);
  const rootPage = Number(db.prepare("SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = ?").get(corruptTable)!.rootpage);
  const pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
  db.close();

  const handle = await open(databasePath, "r+");
  try { await handle.write(Buffer.alloc(pageSize), 0, pageSize, (rootPage - 1) * pageSize); }
  finally { await handle.close(); }
  return { root, databasePath };
}

function rewriteSchemaSql(db: DatabaseSync, name: string, rewrite: (sql: string) => string): void {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE name = ?").get(name) as { sql: string };
  const rewritten = rewrite(row.sql);
  assert.notEqual(rewritten, row.sql);
  db.enableDefensive(false);
  db.exec("PRAGMA writable_schema=ON");
  try { db.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = ?").run(rewritten, name); }
  finally { db.exec("PRAGMA writable_schema=OFF"); db.enableDefensive(true); }
  const version = Number(db.prepare("PRAGMA schema_version").get()!.schema_version);
  db.exec(`PRAGMA schema_version=${version + 1}`);
}

async function artifactBytes(databasePath: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { result[suffix || "main"] = (await readFile(`${databasePath}${suffix}`)).toString("base64"); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return result;
}

async function createHotWal(databasePath: string): Promise<void> {
  const script = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0;");
    db.exec("UPDATE telegram_state SET next_update_id = 99 WHERE singleton = 1");
    process.exit(0);
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, databasePath], { encoding: "utf8", env: {} });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

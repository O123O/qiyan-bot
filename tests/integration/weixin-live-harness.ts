import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { DatabaseSync } from "node:sqlite";
import { createApp, type BotApp } from "../../src/app.ts";
import { AttachmentStore } from "../../src/attachments/store.ts";
import { ChatAdapterRegistry } from "../../src/chat-apps/shared/adapter-registry.ts";
import { DeliveryWorker } from "../../src/chat-apps/shared/delivery-worker.ts";
import { loadConfig, type BotConfig } from "../../src/config.ts";
import { loadConfigSource } from "../../src/config-source.ts";
import { openDatabase, type Database } from "../../src/storage/database.ts";
import { DeliveryStore } from "../../src/storage/delivery-store.ts";
import { WeixinAccountStore } from "../../src/chat-apps/weixin/account-store.ts";
import { WeixinApiClient } from "../../src/chat-apps/weixin/api-client.ts";
import { WeixinCredentialStore, type WeixinCredentialHandle, type WeixinCredentialPublic } from "../../src/chat-apps/weixin/credential-store.ts";
import { WeixinDeliveryAdapter } from "../../src/chat-apps/weixin/delivery-adapter.ts";
import { classifyWeixinMessage } from "../../src/chat-apps/weixin/event-classifier.ts";
import { WeixinOutboundStore } from "../../src/chat-apps/weixin/outbound-store.ts";

const requiredInbound = ["text", "image", "file", "voice_transcription", "unsupported_video"] as const;
const requiredOutbound = ["text_3999", "text_4000", "text_4001", "image", "file"] as const;
const maxFixtureWaitMs = 10 * 60_000;
const pollIntervalMs = 500;

export interface RedactedWeixinAcceptanceResult {
  authorizationIdentitiesDistinct: boolean;
  inboundKinds: typeof requiredInbound;
  outboundKinds: typeof requiredOutbound;
  unauthorizedInputCount: number;
  crossAdapterContinuation: boolean;
  restartCursorRecovered: boolean;
  duplicateAssistantInputs: number;
  secretLeakCount: number;
}

interface DirectStores {
  db: Database;
  deliveries: DeliveryStore;
  accounts: WeixinAccountStore;
}

interface ProductionBaseline {
  sourceArrival: number;
  inboxArrival: number;
  deliveryCreatedAt: number;
  cursor: string;
}

interface ProductionEvidence {
  inboundKinds: Set<string>;
  chatSourceCount: number;
  weixinSourceCount: number;
  otherSourceCount: number;
  incompleteSourceCount: number;
  missingMembershipCount: number;
  duplicateMembershipCount: number;
  attachmentSourceCount: number;
  weixinReplyCount: number;
  otherReplyCount: number;
  misroutedReplyCount: number;
  memberships: Map<string, number>;
  cursor: string;
}

export async function runRedactedWeixinAcceptance(): Promise<RedactedWeixinAcceptanceResult> {
  const loaded = await loadConfigSource(process.env);
  const credential = await new WeixinCredentialStore(loaded.qiyanHome).loadPinned();
  assert.ok(credential, "run qiyan-bot weixin-login before the live acceptance test");
  const config = loadConfig(loaded.values, { qiyanHome: loaded.qiyanHome, weixinConfigured: true });
  assert.equal(Boolean(config.chat.telegram || config.chat.slack), true,
    "the live cross-adapter acceptance requires configured Telegram or Slack alongside WeChat");
  const api = new WeixinApiClient(credential);
  await api.getConfig();

  const root = await mkdtemp(join(tmpdir(), "qiyan-weixin-live-"));
  const terminal = createInterface({ input: stdin, output: stdout });
  const direct = createDirectStores(join(root, "direct.sqlite3"), credential.public);
  const nonce = randomUUID();
  const crossFile = join(config.assistantWorkdir, `.qiyan-live-cross-${nonce}.txt`);
  const lines = [0, 1, 2, 3].map((index) => `${nonce}-${index + 1}`);
  const voiceFixture = `${nonce}-voice-transcription`;
  const unauthorizedFixture = `${nonce}-unauthorized-sender`;
  const fileFixtureName = `${nonce}.txt`;
  const fileFixtureContent = `${nonce}-file-content\n`;
  const messageBodies = [
    `Create ${crossFile} with exactly one line and a trailing newline: ${lines[0]}`,
    `Continue the live task by appending exactly one line to ${crossFile}: ${lines[1]}`,
    `Continue the same live task by appending exactly one line to ${crossFile}: ${lines[2]}`,
    `After restart, append exactly one final line to ${crossFile}: ${lines[3]}`,
  ];
  const instructions = join(root, "private-instructions.txt");
  await writeFile(instructions, [
    ...messageBodies.map((body, index) => `${index + 1}. ${body}`),
    `Voice fixture phrase: ${voiceFixture}`,
    `Unauthorized second-account text: ${unauthorizedFixture}`,
    `Generic file fixture name: ${fileFixtureName}`,
    `Generic file fixture content: ${fileFixtureContent}`,
  ].join("\n\n"), { mode: 0o600 });
  await rm(crossFile, { force: true });
  const capturedOutput: string[] = [];
  const restoreOutput = captureProcessOutput(capturedOutput);
  let activeApp: BotApp | undefined;
  try {
    await requireConfirmation(terminal,
      "Stop the running QiYan service. This test will start it twice and send visible WeChat test messages plus two small attachments. Type READY to continue: ",
      "READY");

    terminal.write("From a second personal account, send the prescribed unauthorized text from the private instruction file. Type SENT after sending it. No identity or content will be printed.\n");
    await requireConfirmation(terminal, "Second-account fixture: ", "SENT");
    const unauthorizedInputCount = await observeUnauthorizedFixture(api, credential.public);

    await sendOutboundFixtures(api, credential, credential.public, direct, root);

    activeApp = await startProductionApp(config, credential);
    const firstBaseline = productionBaseline(config);
    terminal.write(`Open the owner-only instruction file ${instructions}. Send instruction 1 from WeChat, then a separate image, the prescribed generic file, the prescribed transcribed voice phrase, and a video. Type SENT after all five.\n`);
    await requireConfirmation(terminal, "WeChat fixture stage: ", "SENT");
    await waitForEvidence(config, firstBaseline, async (value) =>
      requiredInbound.every((kind) => value.inboundKinds.has(kind))
      && value.weixinSourceCount >= 5
      && value.attachmentSourceCount >= 2
      && value.weixinReplyCount >= 1
      && value.misroutedReplyCount === 0
      && value.incompleteSourceCount === 0
      && value.missingMembershipCount === 0
      && value.duplicateMembershipCount === 0
      && await fileEquals(crossFile, `${lines[0]}\n`));

    terminal.write("Send instruction 2 from the configured Telegram or Slack owner conversation, then type SENT.\n");
    await requireConfirmation(terminal, "Cross-adapter middle stage: ", "SENT");
    await waitForEvidence(config, firstBaseline, async (value) =>
      value.otherSourceCount >= 1
      && value.otherReplyCount >= 1
      && value.misroutedReplyCount === 0
      && value.incompleteSourceCount === 0
      && value.missingMembershipCount === 0
      && value.duplicateMembershipCount === 0
      && await fileEquals(crossFile, `${lines[0]}\n${lines[1]}\n`));

    terminal.write("Send instruction 3 from WeChat, then type SENT.\n");
    await requireConfirmation(terminal, "Cross-adapter return stage: ", "SENT");
    const first = await waitForEvidence(config, firstBaseline, async (value) =>
      value.weixinSourceCount >= 6
      && value.weixinReplyCount >= 2
      && value.otherReplyCount >= 1
      && value.misroutedReplyCount === 0
      && value.incompleteSourceCount === 0
      && value.missingMembershipCount === 0
      && value.duplicateMembershipCount === 0
      && await fileEquals(crossFile, `${lines[0]}\n${lines[1]}\n${lines[2]}\n`));
    await stopProductionApp(activeApp);
    activeApp = undefined;

    const stoppedBaseline = productionBaseline(config);
    const oldMemberships = new Map(first.memberships);
    activeApp = await startProductionApp(config, credential);
    const afterRestart = productionBaseline(config);
    const restartBaseline = { ...afterRestart, cursor: stoppedBaseline.cursor };
    terminal.write("After this restart, send instruction 4 from WeChat and type SENT.\n");
    await requireConfirmation(terminal, "Restart fixture: ", "SENT");
    const restarted = await waitForEvidence(config, restartBaseline, async (value) =>
      value.weixinSourceCount >= 1
      && value.weixinReplyCount >= 1
      && value.misroutedReplyCount === 0
      && value.incompleteSourceCount === 0
      && value.missingMembershipCount === 0
      && value.duplicateMembershipCount === 0
      && value.cursor !== restartBaseline.cursor
      && await fileEquals(crossFile, `${lines.join("\n")}\n`));
    await stopProductionApp(activeApp);
    activeApp = undefined;

    const afterRestartAll = productionEvidence(config, firstBaseline);
    const changedOldMemberships = [...oldMemberships].filter(([id, count]) => afterRestartAll.memberships.get(id) !== count).length;
    const secretLeakCount = await countSecretLeaks(
      config,
      credential,
      direct,
      firstBaseline,
      capturedOutput,
      [...messageBodies, ...lines, voiceFixture, unauthorizedFixture, fileFixtureName, fileFixtureContent, `${lines.join("\n")}\n`],
    );
    const result: RedactedWeixinAcceptanceResult = {
      authorizationIdentitiesDistinct: credential.public.botId !== credential.public.ownerUserId,
      inboundKinds: requiredInbound,
      outboundKinds: requiredOutbound,
      unauthorizedInputCount,
      crossAdapterContinuation: first.weixinReplyCount >= 2
        && first.otherReplyCount >= 1
        && first.misroutedReplyCount === 0
        && await fileEquals(crossFile, `${lines.join("\n")}\n`),
      restartCursorRecovered: restarted.weixinSourceCount >= 1
        && restarted.cursor !== restartBaseline.cursor
        && changedOldMemberships === 0,
      duplicateAssistantInputs: afterRestartAll.duplicateMembershipCount + changedOldMemberships,
      secretLeakCount,
    };
    assertRedactedResult(result);
    return result;
  } finally {
    if (activeApp) await stopProductionApp(activeApp).catch(() => undefined);
    terminal.close();
    restoreOutput();
    direct.db.close();
    await rm(crossFile, { force: true });
    await rm(root, { recursive: true, force: true });
  }
}

function createDirectStores(path: string, credential: WeixinCredentialPublic): DirectStores {
  const db = openDatabase(path);
  const deliveries = new DeliveryStore(db);
  const accounts = new WeixinAccountStore(db, deliveries);
  accounts.activate(credential);
  return { db, deliveries, accounts };
}

async function observeUnauthorizedFixture(api: WeixinApiClient, credential: WeixinCredentialPublic): Promise<number> {
  let cursor = "";
  const deadline = Date.now() + maxFixtureWaitMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(65_000, remaining));
    try {
      const batch = await api.getUpdates(cursor, controller.signal, Math.min(60_000, remaining));
      cursor = batch.cursor ?? cursor;
      let observed = false;
      let accepted = 0;
      for (const candidate of batch.messages) {
        if (candidate.status !== "valid" || candidate.fromUserId === undefined || candidate.fromUserId === credential.ownerUserId
          || candidate.toUserId !== credential.botId || candidate.groupId !== undefined) continue;
        observed = true;
        if (classifyWeixinMessage(candidate, { botId: credential.botId, ownerUserId: credential.ownerUserId })) accepted += 1;
      }
      if (observed) return accepted;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("the unauthorized live fixture was not observed before the deadline");
}

async function startProductionApp(config: BotConfig, credential: WeixinCredentialHandle): Promise<BotApp> {
  try {
    const app = await createApp(config, { weixinCredential: credential });
    await app.start();
    return app;
  } catch {
    throw new Error("live QiYan startup failed; inspect private local diagnostics");
  }
}

async function stopProductionApp(app: BotApp): Promise<void> {
  try { await app.stop(); }
  catch { throw new Error("live QiYan shutdown failed; inspect private local diagnostics"); }
}

function productionBaseline(config: BotConfig): ProductionBaseline {
  return withProductionDatabase(config, (db) => ({
    sourceArrival: Number((db.prepare("SELECT COALESCE(MAX(arrival_sequence), 0) AS value FROM source_contexts").get() as { value: number }).value),
    inboxArrival: Number((db.prepare("SELECT COALESCE(MAX(arrival_sequence), 0) AS value FROM weixin_inbox").get() as { value: number }).value),
    deliveryCreatedAt: Date.now(),
    cursor: activeCursor(db),
  }));
}

async function waitForEvidence(
  config: BotConfig,
  baseline: ProductionBaseline,
  complete: (evidence: ProductionEvidence) => boolean | Promise<boolean>,
): Promise<ProductionEvidence> {
  const deadline = Date.now() + maxFixtureWaitMs;
  while (Date.now() < deadline) {
    const evidence = productionEvidence(config, baseline);
    if (await complete(evidence)) return evidence;
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error("live QiYan fixture processing did not complete before the deadline");
}

function productionEvidence(config: BotConfig, baseline: ProductionBaseline): ProductionEvidence {
  return withProductionDatabase(config, (db) => {
    const sources = db.prepare(`SELECT id, adapter_id, state, json_array_length(attachment_ids_json) AS attachments
      FROM source_contexts WHERE source_class = 'chat' AND arrival_sequence > ?`).all(baseline.sourceArrival) as
      Array<{ id: string; adapter_id: string; state: string; attachments: number }>;
    const membership = db.prepare(`SELECT s.id, COUNT(m.context_id) AS count
      FROM source_contexts s LEFT JOIN assistant_attempt_sources m ON m.context_id = s.id
      WHERE s.source_class = 'chat' AND s.arrival_sequence > ? GROUP BY s.id`).all(baseline.sourceArrival) as
      Array<{ id: string; count: number }>;
    const itemRows = db.prepare(`SELECT json_extract(item.value, '$.kind') AS kind,
        json_extract(item.value, '$.source') AS source, json_extract(item.value, '$.reason') AS reason
      FROM weixin_inbox AS inbox, json_each(inbox.normalized_json, '$.items') AS item
      WHERE inbox.arrival_sequence > ?`).all(baseline.inboxArrival) as Array<{ kind: string; source?: string; reason?: string }>;
    const replies = db.prepare(`SELECT delivery.adapter_id, delivery.conversation_key,
        attempt.adapter_id AS attempt_adapter_id, attempt.conversation_key AS attempt_conversation_key
      FROM deliveries delivery LEFT JOIN assistant_attempts attempt
        ON delivery.id = 'assistant:' || attempt.turn_id
      WHERE delivery.kind = 'assistant_final' AND delivery.state = 'confirmed' AND delivery.created_at >= ?`)
      .all(baseline.deliveryCreatedAt) as Array<{
        adapter_id: string;
        conversation_key: string;
        attempt_adapter_id?: string;
        attempt_conversation_key?: string;
      }>;
    const kinds = new Set<string>();
    for (const item of itemRows) {
      if (item.kind === "text") kinds.add(item.source === "voice" ? "voice_transcription" : "text");
      if (item.kind === "image" || item.kind === "file") kinds.add(item.kind);
      if (item.kind === "failed" && item.reason === "video_unsupported") kinds.add("unsupported_video");
    }
    const membershipBySource = new Map(membership.map((row) => [row.id, Number(row.count)]));
    return {
      inboundKinds: kinds,
      chatSourceCount: sources.length,
      weixinSourceCount: sources.filter(({ adapter_id }) => adapter_id === "weixin").length,
      otherSourceCount: sources.filter(({ adapter_id }) => adapter_id !== "weixin").length,
      incompleteSourceCount: sources.filter(({ state }) => state !== "completed").length,
      missingMembershipCount: sources.filter(({ id }) => (membershipBySource.get(id) ?? 0) === 0).length,
      duplicateMembershipCount: sources.reduce((total, { id }) => total + Math.max(0, (membershipBySource.get(id) ?? 0) - 1), 0),
      attachmentSourceCount: sources.filter(({ adapter_id, attachments }) => adapter_id === "weixin" && attachments > 0).length,
      weixinReplyCount: replies.filter(({ adapter_id }) => adapter_id === "weixin").length,
      otherReplyCount: replies.filter(({ adapter_id }) => adapter_id !== "weixin").length,
      misroutedReplyCount: replies.filter((reply) => reply.adapter_id !== reply.attempt_adapter_id
        || reply.conversation_key !== reply.attempt_conversation_key).length,
      memberships: membershipBySource,
      cursor: activeCursor(db),
    };
  });
}

function activeCursor(db: DatabaseSync): string {
  const row = db.prepare(`SELECT sync.cursor FROM weixin_sync_state sync
    JOIN weixin_account_generations account ON account.generation_id = sync.generation_id
    WHERE account.active = 1`).get() as { cursor: string } | undefined;
  if (!row) throw new Error("active WeChat cursor is unavailable");
  return row.cursor;
}

function withProductionDatabase<T>(config: BotConfig, action: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(config.dataDir, "bot.sqlite3"), { readOnly: true });
  try { return action(db); }
  finally { db.close(); }
}

async function sendOutboundFixtures(
  api: WeixinApiClient,
  credentialHandle: WeixinCredentialHandle,
  credential: WeixinCredentialPublic,
  stores: DirectStores,
  root: string,
): Promise<void> {
  const attachments = new AttachmentStore(stores.db, join(root, "attachments"), {
    maxFileBytes: 2 * 1024 * 1024,
    maxStoreBytes: 8 * 1024 * 1024,
  });
  await attachments.initialize();
  const adapter = new WeixinDeliveryAdapter({
    api,
    outbound: new WeixinOutboundStore(stores.db),
    deliveries: stores.deliveries,
    accounts: stores.accounts,
    incidentSink: { transition: async () => undefined },
  });
  const worker = new DeliveryWorker(stores.deliveries, new ChatAdapterRegistry([{ delivery: adapter }]), attachments);
  const binding = {
    adapterId: "weixin",
    conversationKey: `weixin:${credential.accountGenerationId}:${credential.ownerUserId}`,
    destination: { generationId: credential.accountGenerationId, botId: credential.botId, ownerUserId: credential.ownerUserId },
  } as const;

  for (const bytes of [3_999, 4_000, 4_001]) {
    const delivery = stores.deliveries.prepare({
      id: `live-text-${bytes}`, kind: "acceptance", binding, body: "x".repeat(bytes), mandatory: true,
    });
    await worker.processOne(delivery.id);
    assert.equal(stores.deliveries.get(delivery.id)?.state === "confirmed", true, "live text delivery was not confirmed");
  }

  const fixtures = [
    { id: "image", displayName: "qiyan-live.png", mediaType: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]) },
    { id: "file", displayName: "qiyan-live.txt", mediaType: "text/plain", bytes: Buffer.from("QiYan live acceptance\n") },
  ] as const;
  for (const fixture of fixtures) {
    const scope = `live-${fixture.id}`;
    const stored = await attachments.ingest(scope, (async function* () { yield fixture.bytes; })(), {
      displayName: fixture.displayName, mediaType: fixture.mediaType, declaredSize: fixture.bytes.length,
    });
    const delivery = stores.deliveries.prepareAttachment({
      id: `live-${fixture.id}`, kind: "acceptance", binding, body: "", mandatory: true,
      attachmentId: stored.id, attachmentScopeId: scope,
    });
    await worker.processOne(delivery.id);
    assert.equal(stores.deliveries.get(delivery.id)?.state === "confirmed", true, "live attachment delivery was not confirmed");
  }
  await credentialHandle.withVerifiedCredential(async () => undefined);
}

async function countSecretLeaks(
  config: BotConfig,
  credential: WeixinCredentialHandle,
  direct: DirectStores,
  baseline: ProductionBaseline,
  capturedOutput: readonly string[],
  fixtureNeedles: readonly string[],
): Promise<number> {
  const needles: string[] = [...fixtureNeedles, "QiYan live acceptance\n", "qiyan-live.png", "qiyan-live.txt"];
  await credential.withVerifiedCredential(async (value) => {
    needles.push(
      value.botToken,
      value.botId,
      value.ownerUserId,
      value.accountGenerationId,
      value.credentialRevisionId,
    );
  });
  for (const row of direct.db.prepare("SELECT receipt_json FROM weixin_outbound_steps WHERE receipt_json IS NOT NULL").all() as Array<{ receipt_json: string }>) {
    const receipt = JSON.parse(row.receipt_json) as Record<string, unknown>;
    collectStrings(receipt, needles);
  }
  const inboundAttachments = withProductionDatabase(config, (db) => {
    for (const row of db.prepare("SELECT token FROM weixin_route_tokens").all() as Array<{ token: string }>) needles.push(row.token);
    for (const row of db.prepare(`SELECT normalized_json FROM weixin_inbox
      WHERE arrival_sequence > ?`).all(baseline.inboxArrival) as Array<{ normalized_json: string }>) {
      collectSensitiveNormalizedStrings(JSON.parse(row.normalized_json), needles);
    }
    for (const row of db.prepare(`SELECT raw_text FROM source_contexts
      WHERE source_class = 'chat' AND arrival_sequence > ?`).all(baseline.sourceArrival) as Array<{ raw_text: string }>) {
      if (row.raw_text.length > 0) needles.push(row.raw_text);
    }
    return db.prepare(`SELECT display_name, local_path FROM attachments
      WHERE created_at >= ?`).all(baseline.deliveryCreatedAt) as Array<{ display_name: string; local_path: string }>;
  });
  for (const attachment of inboundAttachments) {
    needles.push(attachment.display_name);
    const bytes = await readFile(attachment.local_path).catch(() => undefined);
    if (!bytes || bytes.length === 0 || bytes.length > 2 * 1024 * 1024) continue;
    needles.push(bytes.toString("base64"));
    try { needles.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { /* binary content is represented by its base64 needle */ }
  }
  const surfaces: string[] = [...capturedOutput];
  for (const path of [join(config.assistantWorkdir, "session-status.json"), join(config.assistantWorkdir, "assistant-context.json")]) {
    const value = await readFile(path, "utf8").catch(() => undefined);
    if (value !== undefined) surfaces.push(value);
  }
  withProductionDatabase(config, (db) => {
    surfaces.push(JSON.stringify(db.prepare(`SELECT kind, state, body FROM deliveries
      WHERE kind NOT IN ('assistant_final', 'chat', 'attachment')`).all()));
  });
  const valueLeaks = new Set(needles.filter((needle) => needle.length >= 16
    && surfaces.some((surface) => surface.includes(needle))));
  const secretFieldPattern = /(?:authorization\s*:\s*bearer|context[_-]?token|encrypt(?:ed)?(?:_query_param|QueryParameter)|verify[_-]?code|qrcode|qr[_-]?data|aes[_-]?key|attachment[_-]?content)/giu;
  const classLeaks = surfaces.reduce((count, surface) => count + [...surface.matchAll(secretFieldPattern)].length, 0);
  return valueLeaks.size + classLeaks;
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    if (value.length >= 4) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, output);
  }
}

function collectSensitiveNormalizedStrings(value: unknown, output: string[], field?: string): void {
  if (new Set(["kind", "source", "reason", "type", "ordinal"]).has(field ?? "")) return;
  if (typeof value === "string") {
    if (value.length >= 4) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveNormalizedStrings(item, output);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      collectSensitiveNormalizedStrings(item, output, key);
    }
  }
}

async function fileEquals(path: string, expected: string): Promise<boolean> {
  const value = await readFile(path, "utf8").catch(() => undefined);
  return value === expected;
}

function captureProcessOutput(captured: string[]): () => void {
  const stdoutWrite = stdout.write;
  const stderrWrite = process.stderr.write;
  let bytes = 0;
  const capture = (chunk: unknown): void => {
    if (bytes >= 1024 * 1024) return;
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    bytes += Buffer.byteLength(text);
    captured.push(text.slice(0, Math.max(0, 1024 * 1024 - bytes + Buffer.byteLength(text))));
  };
  stdout.write = ((chunk: unknown, ...args: unknown[]) => {
    capture(chunk);
    return (stdoutWrite as (...values: unknown[]) => boolean).call(stdout, chunk, ...args);
  }) as typeof stdout.write;
  process.stderr.write = ((chunk: unknown, ...args: unknown[]) => {
    capture(chunk);
    return (stderrWrite as (...values: unknown[]) => boolean).call(process.stderr, chunk, ...args);
  }) as typeof process.stderr.write;
  return () => {
    stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  };
}

async function requireConfirmation(
  terminal: ReturnType<typeof createInterface>,
  prompt: string,
  expected: string,
): Promise<void> {
  const answer = await terminal.question(prompt);
  if (answer.trim() !== expected) throw new Error("live acceptance confirmation did not match the requested fixed word");
}

function assertRedactedResult(result: RedactedWeixinAcceptanceResult): void {
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /(?:bearer|token|context[_-]?token|verification|qr[_-]?code|encrypted[_-]?query|signed[?=&]|owner[_-]?(?:user)?[_-]?id|bot[_-]?id|message[_-]?body|attachment[_-]?content)/iu);
  assert.equal(Object.values(result).some((value) => typeof value === "string"), false);
}

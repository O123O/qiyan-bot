import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import test from "node:test";
import type { FileHandleId, StoredAttachment } from "../../src/attachments/store.ts";
import { WorkerFileBridge } from "../../src/endpoints/worker-file-bridge.ts";
import type { EndpointWorkLease } from "../../src/endpoints/types.ts";
import { runOperationRecoveryTarget } from "../../src/production-app.ts";

const mapping = { endpoint: "devbox", thread_id: "thread-1", mapping_id: "mapping-1" };
const lease: EndpointWorkLease = { endpointId: "devbox", lifecycleGeneration: 1, endpointGeneration: 2, leaseId: "lease-1" };
const bytes = Buffer.from("remote attachment");
const sha256 = createHash("sha256").update(bytes).digest("hex");

function fixture() {
  let current = { ...mapping, project_dir: "/home/xin/project", lifecycle_state: "managed" as const };
  const uploaded: Buffer[] = [];
  const ingested: Array<{ scopeId: string; data: Buffer; requestedId?: FileHandleId }> = [];
  const discarded: FileHandleId[] = [];
  const attachments = {
    get: (_scopeId: string, id: FileHandleId) => id === "file_source"
      ? { id: "file_source" as const, displayName: "requirements.txt", mediaType: "text/plain", size: bytes.length, sha256 }
      : undefined,
    toUserInput: () => ({ type: "mention" as const, name: "requirements.txt", path: "/local/file" }),
    openForUpload: async () => ({ stream: Readable.from([bytes]), size: bytes.length, displayName: "requirements.txt", mediaType: "text/plain", close: async () => undefined }),
    ingest: async (scopeId: string, stream: AsyncIterable<Uint8Array | string>, _meta: unknown, requestedId?: FileHandleId): Promise<StoredAttachment> => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks);
      ingested.push({ scopeId, data, ...(requestedId ? { requestedId } : {}) });
      return { id: requestedId ?? "file_generated", displayName: "report.txt", mediaType: "application/octet-stream", size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
    },
    stage: async (scopeId: string, stream: AsyncIterable<Uint8Array | string>, meta: unknown, requestedId?: FileHandleId) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const data = Buffer.concat(chunks);
      return {
        attachment: { id: requestedId ?? "file_generated", displayName: "report.txt", mediaType: "application/octet-stream", size: data.length, sha256: createHash("sha256").update(data).digest("hex") },
        promote: async (beforeCommit?: () => void | Promise<void>) => {
          if (mutateDuringPromote) current = { ...current, mapping_id: "mapping-2" };
          await beforeCommit?.();
          return attachments.ingest(scopeId, Readable.from([data]), meta, requestedId);
        },
        discard: async () => undefined,
      };
    },
    discard: async (_scopeId: string, id: FileHandleId) => { discarded.push(id); },
  };
  let corruptDownload = false;
  let mutateAfterRead = false;
  let mutateDuringPromote = false;
  let rejectWorkspace = false;
  let remoteReads = 0;
  let activatingLeaseCalls = 0;
  let existingLeaseCalls = 0;
  let existingLeaseValid = true;
  const remote = {
    invokeTransfer: async <T>(operation: string, _args: readonly string[], options: { input?: AsyncIterable<Uint8Array | string> }) => {
      if (operation === "write-file") {
        for await (const chunk of options.input ?? []) uploaded.push(Buffer.from(chunk));
        return { path: `/tmp/qiyan-1000/0123456789abcdef01234567/files/${sha256}`, size: bytes.length, sha256 } as T;
      }
      if (operation === "read-file") {
        remoteReads += 1;
        if (mutateAfterRead) current = { ...current, mapping_id: "mapping-2" };
        return {
          device: "1", inode: "2", size: bytes.length, mtimeNs: "3",
          sha256: corruptDownload ? "0".repeat(64) : sha256,
          dataBase64: bytes.toString("base64"),
        } as T;
      }
      throw new Error(`unexpected transfer ${operation}`);
    },
  };
  const bridge = new WorkerFileBridge({
    attachments: attachments as never,
    registry: { getByIdentity: () => ({ nickname: "novel", session: { ...current } }) } as never,
    endpoints: {
      validateWorkLease: (candidate: EndpointWorkLease, endpointId: string) => candidate === lease && endpointId === "devbox",
      withWorkLease: async (_id: string, _kind: "file-transfer", run: (endpoint: unknown, value: EndpointWorkLease) => Promise<unknown>) => {
        activatingLeaseCalls += 1;
        return run({}, lease);
      },
      runWithWorkLease: async (_id: string, existing: EndpointWorkLease | undefined, run: (value: EndpointWorkLease | undefined) => Promise<unknown>) => {
        existingLeaseCalls += 1;
        return run(existingLeaseValid ? existing : undefined);
      },
    } as never,
    workspaces: {
      prepareExisting: async () => {
        if (rejectWorkspace) throw new Error("project workspace changed unexpectedly");
        return { path: "/home/xin/project", created: false, fallback: false, identity: { device: "1", inode: "2" } };
      },
      assertDispatchable: async () => { if (rejectWorkspace) throw new Error("project workspace changed unexpectedly"); },
    } as never,
    remote: () => ({ remote, helperPath: "/tmp/qiyan-1000/0123456789abcdef01234567/qiyan-ssh-helper.mjs", runtimeDir: "/tmp/qiyan-1000/0123456789abcdef01234567" }),
    maxFileBytes: 1024,
  });
  return {
    bridge, uploaded, ingested, discarded,
    corrupt: () => { corruptDownload = true; },
    mutateAfterRead: () => { mutateAfterRead = true; },
    mutateDuringPromote: () => { mutateDuringPromote = true; },
    replaceWorkspace: () => { rejectWorkspace = true; },
    remoteReads: () => remoteReads,
    leaseCalls: () => ({ activating: activatingLeaseCalls, existing: existingLeaseCalls }),
    invalidateExistingLease: () => { existingLeaseValid = false; },
  };
}

test("uploads only the selected attachment under the caller's endpoint lease", async () => {
  const value = fixture();
  const input = await value.bridge.toWorkerInput({ lease, mapping, projectRoot: "/home/xin/project", scopeId: "scope", attachmentId: "file_source" });
  assert.deepEqual(input, { type: "mention", name: "requirements.txt", path: `/tmp/qiyan-1000/0123456789abcdef01234567/files/${sha256}` });
  assert.deepEqual(Buffer.concat(value.uploaded), bytes);
});

test("downloads a selected remote project file and promotes it only for the same mapping", async () => {
  const value = fixture();
  const result = await value.bridge.prepareProjectFile({
    endpointId: "devbox", projectRoot: "/home/xin/project", mapping,
    scopeId: "scope", relativePath: "out/report.txt", requestedId: "file_result",
  });
  assert.equal(result.id, "file_result");
  assert.deepEqual(value.ingested[0]?.data, bytes);

  const raced = fixture();
  raced.mutateAfterRead();
  await assert.rejects(raced.bridge.prepareProjectFile({
    endpointId: "devbox", projectRoot: "/home/xin/project", mapping,
    scopeId: "scope", relativePath: "out/report.txt", requestedId: "file_raced",
  }), /mapping changed/u);
  assert.equal(raced.ingested.length, 0);
});

test("recovery reuses its exact ready lease without activating after endpoint loss", async () => {
  const value = fixture();
  let outerAcquisitions = 0;
  await runOperationRecoveryTarget({ policy: "ready_endpoint", endpointId: "devbox" }, {
    withReadyWorkLease: async (endpointId: string | undefined, run: (lease: EndpointWorkLease) => Promise<unknown>) => {
      outerAcquisitions += 1;
      assert.equal(endpointId, "devbox");
      return run(lease);
    },
  } as never, async (actual) => value.bridge.prepareProjectFile({
    endpointId: "devbox", projectRoot: "/home/xin/project", mapping, lease: actual!,
    scopeId: "scope", relativePath: "out/report.txt", requestedId: "file_recovery",
  }));
  assert.equal(outerAcquisitions, 1);
  assert.deepEqual(value.leaseCalls(), { activating: 0, existing: 1 });

  const lost = fixture();
  lost.invalidateExistingLease();
  await assert.rejects(lost.bridge.prepareProjectFile({
    endpointId: "devbox", projectRoot: "/home/xin/project", mapping, lease,
    scopeId: "scope", relativePath: "out/report.txt", requestedId: "file_lost",
  }), /lease|unavailable/u);
  assert.deepEqual(lost.leaseCalls(), { activating: 0, existing: 1 });
});

test("rejects a mapping change at the attachment database promotion fence", async () => {
  const value = fixture();
  value.mutateDuringPromote();

  await assert.rejects(value.bridge.prepareProjectFile({
    endpointId: "devbox", projectRoot: "/home/xin/project", mapping,
    scopeId: "scope", relativePath: "out/report.txt", requestedId: "file_promote_race",
  }), /mapping changed/u);
  assert.equal(value.ingested.length, 0);
});

test("rejects corrupt remote downloads without promoting attachment state", async () => {
  const value = fixture();
  value.corrupt();
  await assert.rejects(value.bridge.prepareProjectFile({
    endpointId: "devbox", projectRoot: "/home/xin/project", mapping,
    scopeId: "scope", relativePath: "report.txt", requestedId: "file_corrupt",
  }), /digest/u);
  assert.equal(value.ingested.length, 0);
  assert.deepEqual(value.discarded, []);
});

test("rejects a replaced project root before opening a remote file", async () => {
  const value = fixture();
  value.replaceWorkspace();
  await assert.rejects(value.bridge.prepareProjectFile({
    endpointId: "devbox", projectRoot: "/home/xin/project", mapping,
    scopeId: "scope", relativePath: "report.txt", requestedId: "file_replaced",
  }), /workspace changed/u);
  assert.equal(value.remoteReads(), 0);
});

test("a local Claude endpoint handles attachments in-process, never over the ssh transport", async () => {
  // Regression: the local Claude endpoint (CLAUDE_CODE_ENDPOINT_ID) is local but not the
  // Codex "local" id, so the bridge must route it through the in-process path — not the
  // ssh transport, which has no host for it ("SSH file transport is unavailable").
  let remoteConsulted = false;
  const bridge = new WorkerFileBridge({
    attachments: { toUserInput: () => ({ type: "localImage" as const, path: "/local/pic.png" }) } as never,
    registry: { getByIdentity: () => ({ nickname: "n", session: { endpoint: "claude-local", thread_id: "t", mapping_id: "m", project_dir: "/p", lifecycle_state: "managed" } }) } as never,
    endpoints: { validateWorkLease: () => true } as never,
    workspaces: {} as never,
    remote: () => { remoteConsulted = true; return undefined; },
    isLocal: (id) => id === "local" || id === "claude-local",
    maxFileBytes: 1024,
  });
  const out = await bridge.toWorkerInput({
    lease: {} as never,
    mapping: { endpoint: "claude-local", thread_id: "t", mapping_id: "m" } as never,
    projectRoot: "/p", scopeId: "s", attachmentId: "a" as never,
  });
  assert.deepEqual(out, { type: "localImage", path: "/local/pic.png" });
  assert.equal(remoteConsulted, false, "a local endpoint must not touch the ssh file transport");
});

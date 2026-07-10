import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  classifyWeixinOutboundMedia,
  decodeWeixinAesKey,
  decryptWeixinMedia,
  deterministicWeixinAttachmentId,
  encryptWeixinMedia,
  safeWeixinFileName,
  verifyWeixinMediaIntegrity,
} from "../../src/chat-apps/weixin/media.ts";

async function bytes(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("decodes only the three reviewed AES key forms", () => {
  const hex = "00112233445566778899aabbccddeeff";
  assert.equal(decodeWeixinAesKey(hex).toString("hex"), hex);
  assert.equal(decodeWeixinAesKey(Buffer.from(hex, "hex").toString("base64")).toString("hex"), hex);
  assert.equal(decodeWeixinAesKey(Buffer.from(hex).toString("base64")).toString("hex"), hex);
  for (const invalid of ["", "abc", Buffer.alloc(15).toString("base64"), `${Buffer.alloc(16).toString("base64")}x`]) {
    assert.throws(() => decodeWeixinAesKey(invalid), /AES key/u);
  }
  assert.throws(() => decodeWeixinAesKey(Buffer.alloc(32, 0xb0).toString("base64")), /AES key/u);
});

test("encrypts and decrypts bounded AES-128-ECB with strict padding", async () => {
  const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const plaintext = Buffer.from("hello encrypted media");
  const encrypted = await bytes(encryptWeixinMedia((async function* () { yield plaintext.subarray(0, 3); yield plaintext.subarray(3); })(), key, 100));
  assert.equal(encrypted.length % 16, 0);
  assert.deepEqual(await bytes(decryptWeixinMedia((async function* () { yield encrypted; })(), key, {
    maxCiphertextBytes: 100, maxPlaintextBytes: 100,
  })), plaintext);
  const tampered = Buffer.from(encrypted); tampered[tampered.length - 1] = 0;
  await assert.rejects(bytes(decryptWeixinMedia((async function* () { yield tampered; })(), key, {
    maxCiphertextBytes: 100, maxPlaintextBytes: 100,
  })), /padding/u);
  await assert.rejects(bytes(encryptWeixinMedia((async function* () { yield plaintext; })(), key, 2)), /exceeds limit/u);
  await assert.rejects(bytes(decryptWeixinMedia((async function* () { yield encrypted; })(), key, {
    maxCiphertextBytes: 2, maxPlaintextBytes: 100,
  })), /exceeds limit/u);
});

test("verifies digest, declared sizes, image signatures, names, and deterministic IDs", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const md5 = createHash("md5").update(png).digest("hex");
  verifyWeixinMediaIntegrity({ bytes: png, md5, plaintextSize: png.length, ciphertextSize: 16, kind: "image" });
  assert.throws(() => verifyWeixinMediaIntegrity({ bytes: png, md5: "0".repeat(32), kind: "image" }), /digest/u);
  assert.throws(() => verifyWeixinMediaIntegrity({ bytes: Buffer.from("not image"), kind: "image" }), /format/u);
  assert.throws(() => verifyWeixinMediaIntegrity({ bytes: png, plaintextSize: 1, kind: "file" }), /plaintext size/u);
  assert.equal(safeWeixinFileName("../bad\u0000name.txt"), "badname.txt");
  const id = deterministicWeixinAttachmentId("generation", { kind: "message", value: "7" }, 2);
  assert.match(id, /^file_weixin_[a-f0-9]{64}$/u);
  assert.equal(id, deterministicWeixinAttachmentId("generation", { kind: "message", value: "7" }, 2));
  assert.notEqual(id, deterministicWeixinAttachmentId("generation", { kind: "client", value: "7" }, 2));
});

test("classifies outbound media from validated bytes and rejects disguised audio or video", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  assert.equal(classifyWeixinOutboundMedia(png, "picture.png", "application/octet-stream"), "image");
  assert.equal(classifyWeixinOutboundMedia(png, "stale-name.MP3", "Video/MP4"), "image");
  assert.equal(classifyWeixinOutboundMedia(Buffer.from("notes"), "notes.txt", "APPLICATION/OCTET-STREAM"), "file");
  assert.throws(() => classifyWeixinOutboundMedia(Buffer.from("audio"), "recording.MP3", "application/octet-stream"), /unsupported/u);
  assert.throws(() => classifyWeixinOutboundMedia(Buffer.from("video"), "movie.bin", "Video/MP4; codecs=x"), /unsupported/u);
  assert.throws(() => classifyWeixinOutboundMedia(Buffer.from("invalid"), "picture.PNG", "application/octet-stream"), /image format/u);
});

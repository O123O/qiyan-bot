import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { basename } from "node:path";
import type { FileHandleId } from "../../attachments/store.ts";
import type { WeixinMessageIdentity } from "./protocol.ts";

export interface WeixinMediaLimits {
  maxCiphertextBytes: number;
  maxPlaintextBytes: number;
}

export function decodeWeixinAesKey(value: string): Buffer {
  if (/^[a-fA-F0-9]{32}$/u.test(value)) return Buffer.from(value, "hex");
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) throw new TypeError("WeChat media AES key is invalid");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new TypeError("WeChat media AES key is invalid");
  if (decoded.length === 16) return decoded;
  const asciiHex = decoded.length === 32 && decoded.every((byte) =>
    (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66));
  if (asciiHex) return Buffer.from(decoded.toString("ascii"), "hex");
  throw new TypeError("WeChat media AES key is invalid");
}

export async function* encryptWeixinMedia(
  source: AsyncIterable<Uint8Array | string>,
  key: Buffer,
  maxPlaintextBytes: number,
): AsyncIterable<Uint8Array> {
  validateKeyAndLimit(key, maxPlaintextBytes);
  const plaintext = await collect(source, maxPlaintextBytes, "plaintext");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  yield Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export async function* decryptWeixinMedia(
  source: AsyncIterable<Uint8Array | string>,
  key: Buffer,
  limits: WeixinMediaLimits,
): AsyncIterable<Uint8Array> {
  validateKeyAndLimit(key, limits.maxPlaintextBytes);
  validateLimit(limits.maxCiphertextBytes);
  const ciphertext = await collect(source, limits.maxCiphertextBytes, "ciphertext");
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) throw new TypeError("WeChat media ciphertext is invalid");
  try {
    const decipher = createDecipheriv("aes-128-ecb", key, null);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > limits.maxPlaintextBytes) throw new TypeError("WeChat media plaintext exceeds limit");
    yield plaintext;
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("exceeds limit")) throw error;
    throw new TypeError("WeChat media padding is invalid");
  }
}

export function verifyWeixinMediaIntegrity(input: {
  bytes: Uint8Array;
  md5?: string;
  plaintextSize?: number;
  ciphertextSize?: number;
  kind: "image" | "file";
}): void {
  const bytes = Buffer.from(input.bytes);
  if (input.plaintextSize !== undefined && input.plaintextSize !== bytes.length) throw new TypeError("WeChat media plaintext size is invalid");
  if (input.ciphertextSize !== undefined) {
    const padded = (Math.floor(bytes.length / 16) + 1) * 16;
    if (input.ciphertextSize !== padded) throw new TypeError("WeChat media ciphertext size is invalid");
  }
  if (input.md5 !== undefined) {
    if (!/^[a-f0-9]{32}$/u.test(input.md5) || createHash("md5").update(bytes).digest("hex") !== input.md5) {
      throw new TypeError("WeChat media digest is invalid");
    }
  }
  if (input.kind === "image" && !isSupportedImage(bytes)) throw new TypeError("WeChat image format is invalid");
}

export function deterministicWeixinAttachmentId(
  generationId: string,
  identity: WeixinMessageIdentity,
  itemOrdinal: number,
): FileHandleId {
  if (!Number.isSafeInteger(itemOrdinal) || itemOrdinal < 0) throw new TypeError("WeChat media item ordinal is invalid");
  const digest = createHash("sha256").update(JSON.stringify([generationId, identity.kind, identity.value, itemOrdinal])).digest("hex");
  return `file_weixin_${digest}`;
}

export function safeWeixinFileName(value: string | undefined): string {
  const clean = basename((value ?? "").replace(/[\u0000-\u001f\u007f]/gu, "")).trim().slice(0, 180);
  return clean || "attachment";
}

export function classifyWeixinOutboundMedia(
  bytes: Uint8Array,
  displayName: string,
  mediaType: string,
): "image" | "file" {
  const normalizedType = mediaType.trim().toLowerCase().split(";", 1)[0] ?? "";
  const extension = basename(displayName).toLowerCase().match(/\.[a-z0-9]+$/u)?.[0];
  if (isSupportedImage(Buffer.from(bytes))) return "image";
  if (normalizedType.startsWith("audio/") || normalizedType.startsWith("video/")
    || AUDIO_EXTENSIONS.has(extension ?? "") || VIDEO_EXTENSIONS.has(extension ?? "")) {
    throw new TypeError("WeChat audio and video delivery is unsupported");
  }
  if (normalizedType.startsWith("image/") || IMAGE_EXTENSIONS.has(extension ?? "")) {
    throw new TypeError("WeChat image format is invalid");
  }
  return "file";
}

async function collect(source: AsyncIterable<Uint8Array | string>, maxBytes: number, label: string): Promise<Buffer> {
  validateLimit(maxBytes);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of source) {
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) throw new TypeError(`WeChat media ${label} exceeds limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function validateKeyAndLimit(key: Buffer, maxBytes: number): void {
  if (key.length !== 16) throw new TypeError("WeChat media AES key is invalid");
  validateLimit(maxBytes);
}

function validateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("WeChat media size limit is invalid");
}

function isSupportedImage(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9)
    || bytes.subarray(0, 6).toString("ascii") === "GIF87a"
    || bytes.subarray(0, 6).toString("ascii") === "GIF89a"
    || (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP");
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const AUDIO_EXTENSIONS = new Set([".aac", ".amr", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"]);
const VIDEO_EXTENSIONS = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm"]);

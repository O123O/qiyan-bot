import { isLosslessNumber, parse as parseLosslessJson } from "lossless-json";

const MAX_API_JSON_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_MESSAGES = 100;
const MAX_ITEMS = 20;
const MAX_CURSOR_BYTES = 64 * 1024;
const MAX_CONTEXT_TOKEN_BYTES = 16 * 1024;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_FIELD_BYTES = 16 * 1024;
const MAX_IDENTITY_BYTES = 128;

export class WeixinProtocolError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = "WeixinProtocolError";
  }
}

export type WeixinMessageIdentity = { kind: "message" | "client"; value: string };

export type ParsedMessageItem =
  | { kind: "text"; text: string }
  | { kind: "image"; image: ParsedImageItem }
  | { kind: "voice"; transcription?: string }
  | { kind: "file"; file: ParsedFileItem }
  | { kind: "video"; video: ParsedVideoItem }
  | { kind: "unknown"; type: number };

export interface ParsedMediaReference {
  fullUrl?: string;
  encryptedQueryParameter?: string;
  aesKey?: string;
}

export interface ParsedImageItem {
  media?: ParsedMediaReference;
  aesKeyHex?: string;
  url?: string;
  mediumSize?: number;
  highDefinitionSize?: number;
}

export interface ParsedFileItem {
  media?: ParsedMediaReference;
  displayName?: string;
  md5?: string;
  length?: string;
}

export interface ParsedVideoItem {
  media?: ParsedMediaReference;
  size?: number;
  md5?: string;
}

export type ParsedMessageCandidate =
  | {
    status: "valid";
    ordinal: number;
    identity: WeixinMessageIdentity;
    fromUserId?: string;
    toUserId?: string;
    groupId?: string;
    messageType?: number;
    contextToken?: string;
    items: readonly ParsedMessageItem[];
  }
  | { status: "malformed"; ordinal: number; reason: "invalid_shape" | "missing_identity" | "invalid_identity" };

export interface ParsedUpdates {
  ret: 0;
  cursor?: string;
  timeoutMs?: number;
  messages: readonly ParsedMessageCandidate[];
}

class WeixinLimitError extends TypeError {}

export async function readBoundedJson(
  response: Response,
  limits: { maxBytes: number; maxDepth: number },
): Promise<string> {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1) throw new TypeError("WeChat response size limit is invalid");
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 1) throw new TypeError("WeChat response nesting limit is invalid");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limits.maxBytes)) {
    throw new WeixinLimitError("WeChat response size limit exceeded");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > limits.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new WeixinLimitError("WeChat response size limit exceeded");
        }
        chunks.push(result.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("WeChat response is not valid UTF-8 JSON");
  }
  assertJsonDepth(text, limits.maxDepth);
  return text;
}

export function parseUpdates(raw: string): ParsedUpdates {
  if (Buffer.byteLength(raw) > MAX_API_JSON_BYTES) throw new WeixinLimitError("WeChat response size limit exceeded");
  assertJsonDepth(raw, MAX_JSON_DEPTH);
  let value: unknown;
  try {
    value = parseLosslessJson(raw);
  } catch {
    throw new TypeError("WeChat response JSON is invalid");
  }
  const envelope = record(value);
  if (!envelope) throw new TypeError("WeChat response envelope is invalid");
  let ret: number;
  try {
    ret = boundedSafeInteger(envelope.ret, "response code", -2_147_483_648, 2_147_483_647);
  } catch {
    throw new TypeError("WeChat response envelope is invalid");
  }
  let errcode = 0;
  if (envelope.errcode !== undefined) {
    try { errcode = boundedSafeInteger(envelope.errcode, "error code", -2_147_483_648, 2_147_483_647); }
    catch { throw new TypeError("WeChat response envelope is invalid"); }
  }
  if (ret !== 0 || errcode !== 0) {
    const code = ret === -14 || errcode === -14 ? -14 : (errcode !== 0 ? errcode : ret);
    throw new WeixinProtocolError("WeChat API response was not successful", code);
  }

  const rawMessages = envelope.msgs === undefined ? [] : envelope.msgs;
  if (!Array.isArray(rawMessages)) throw new TypeError("WeChat response envelope is invalid");
  if (rawMessages.length > MAX_MESSAGES) throw new WeixinLimitError("WeChat message count limit exceeded");
  const cursor = optionalBoundedString(envelope.get_updates_buf, "cursor", MAX_CURSOR_BYTES, true);
  if (cursor !== undefined && !isBase64(cursor)) throw new TypeError("WeChat cursor is invalid");
  const timeoutMs = envelope.longpolling_timeout_ms === undefined
    ? undefined
    : boundedSafeInteger(envelope.longpolling_timeout_ms, "long-poll timeout", 1, 600_000);
  const messages = rawMessages.map((message, ordinal) => parseMessageCandidate(message, ordinal));
  return {
    ret: 0,
    ...(cursor ? { cursor } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    messages,
  };
}

export function canonicalUnsignedInteger(value: unknown, label: string): string {
  let text: string;
  if (isLosslessNumber(value)) text = value.value;
  else if (typeof value === "bigint") text = value.toString();
  else if (typeof value === "number" && Number.isSafeInteger(value)) text = String(value);
  else if (typeof value === "string") text = value;
  else throw new TypeError(`${label} is invalid`);
  if (!/^\d+$/u.test(text)) throw new TypeError(`${label} is invalid`);
  const canonical = text.replace(/^0+(?=\d)/u, "");
  if (Buffer.byteLength(canonical) > MAX_IDENTITY_BYTES) throw new WeixinLimitError(`WeChat ${label} limit exceeded`);
  return canonical;
}

export function boundedSafeInteger(value: unknown, label: string, min: number, max: number): number {
  const text = numericText(value);
  if (!/^-?(?:0|[1-9]\d*)$/u.test(text)) throw new TypeError(`${label} is invalid`);
  const number = Number(text);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${label} is invalid`);
  if (number < min || number > max) throw new TypeError(`${label} is out of range`);
  return number;
}

function parseMessageCandidate(value: unknown, ordinal: number): ParsedMessageCandidate {
  const message = record(value);
  if (!message) return { status: "malformed", ordinal, reason: "invalid_shape" };
  let identity: WeixinMessageIdentity;
  if (message.message_id !== undefined) {
    try { identity = { kind: "message", value: canonicalUnsignedInteger(message.message_id, "message identity") }; }
    catch (error) {
      if (error instanceof WeixinLimitError) throw error;
      return { status: "malformed", ordinal, reason: "invalid_identity" };
    }
  } else if (typeof message.client_id === "string" && message.client_id.length > 0) {
    identity = { kind: "client", value: boundedString(message.client_id, "client identity", MAX_IDENTITY_BYTES) };
  } else {
    return { status: "malformed", ordinal, reason: "missing_identity" };
  }

  try {
    const rawItems = message.item_list === undefined ? [] : message.item_list;
    if (!Array.isArray(rawItems)) return { status: "malformed", ordinal, reason: "invalid_shape" };
    if (rawItems.length > MAX_ITEMS) throw new WeixinLimitError("WeChat item count limit exceeded");
    const fromUserId = optionalBoundedString(message.from_user_id, "sender identity", MAX_FIELD_BYTES);
    const toUserId = optionalBoundedString(message.to_user_id, "recipient identity", MAX_FIELD_BYTES);
    const groupId = optionalBoundedString(message.group_id, "group identity", MAX_FIELD_BYTES);
    const contextToken = optionalBoundedString(message.context_token, "context token", MAX_CONTEXT_TOKEN_BYTES);
    const messageType = message.message_type === undefined
      ? undefined
      : boundedSafeInteger(message.message_type, "message type", 0, 100);
    const items = rawItems.map(parseMessageItem);
    const aggregateTextBytes = items.reduce((total, item) => total + (
      item.kind === "text" ? Buffer.byteLength(item.text)
        : item.kind === "voice" && item.transcription ? Buffer.byteLength(item.transcription)
          : 0
    ), 0);
    if (aggregateTextBytes > MAX_TEXT_BYTES) throw new WeixinLimitError("WeChat aggregate text limit exceeded");
    return {
      status: "valid",
      ordinal,
      identity,
      ...(fromUserId === undefined ? {} : { fromUserId }),
      ...(toUserId === undefined ? {} : { toUserId }),
      ...(groupId === undefined ? {} : { groupId }),
      ...(messageType === undefined ? {} : { messageType }),
      ...(contextToken === undefined ? {} : { contextToken }),
      items,
    };
  } catch (error) {
    if (error instanceof WeixinLimitError) throw error;
    return { status: "malformed", ordinal, reason: "invalid_shape" };
  }
}

function parseMessageItem(value: unknown): ParsedMessageItem {
  const item = record(value);
  if (!item) throw new TypeError("message item is invalid");
  const type = boundedSafeInteger(item.type, "message item type", 0, 100);
  if (type === 1) {
    const text = record(item.text_item)?.text;
    if (typeof text !== "string") throw new TypeError("text item is invalid");
    return { kind: "text", text: boundedString(text, "text", MAX_TEXT_BYTES) };
  }
  if (type === 2) {
    const image = record(item.image_item);
    if (!image) throw new TypeError("image item is invalid");
    const media = parseMediaReference(image.media);
    const aesKeyHex = optionalBoundedString(image.aeskey, "image AES key", 128);
    const url = optionalBoundedString(image.url, "image URL", MAX_FIELD_BYTES);
    const mediumSize = optionalSafeInteger(image.mid_size, "image size", 0, Number.MAX_SAFE_INTEGER);
    const highDefinitionSize = optionalSafeInteger(image.hd_size, "image size", 0, Number.MAX_SAFE_INTEGER);
    return { kind: "image", image: {
      ...(media === undefined ? {} : { media }),
      ...(aesKeyHex === undefined ? {} : { aesKeyHex }),
      ...(url === undefined ? {} : { url }),
      ...(mediumSize === undefined ? {} : { mediumSize }),
      ...(highDefinitionSize === undefined ? {} : { highDefinitionSize }),
    } };
  }
  if (type === 3) {
    const voice = record(item.voice_item);
    if (!voice) throw new TypeError("voice item is invalid");
    const transcription = optionalBoundedString(voice.text, "voice transcription", MAX_TEXT_BYTES);
    return { kind: "voice", ...(transcription === undefined ? {} : { transcription }) };
  }
  if (type === 4) {
    const file = record(item.file_item);
    if (!file) throw new TypeError("file item is invalid");
    const media = parseMediaReference(file.media);
    const displayName = optionalBoundedString(file.file_name, "file name", 1024);
    const md5 = optionalBoundedString(file.md5, "file digest", 128);
    const length = optionalBoundedString(file.len, "file length", 128);
    return { kind: "file", file: {
      ...(media === undefined ? {} : { media }),
      ...(displayName === undefined ? {} : { displayName }),
      ...(md5 === undefined ? {} : { md5 }),
      ...(length === undefined ? {} : { length }),
    } };
  }
  if (type === 5) {
    const video = record(item.video_item);
    if (!video) throw new TypeError("video item is invalid");
    const media = parseMediaReference(video.media);
    const size = optionalSafeInteger(video.video_size, "video size", 0, Number.MAX_SAFE_INTEGER);
    const md5 = optionalBoundedString(video.video_md5, "video digest", 128);
    return { kind: "video", video: {
      ...(media === undefined ? {} : { media }),
      ...(size === undefined ? {} : { size }),
      ...(md5 === undefined ? {} : { md5 }),
    } };
  }
  return { kind: "unknown", type };
}

function parseMediaReference(value: unknown): ParsedMediaReference | undefined {
  if (value === undefined) return undefined;
  const media = record(value);
  if (!media) throw new TypeError("media reference is invalid");
  const fullUrl = optionalBoundedString(media.full_url, "media URL", MAX_FIELD_BYTES);
  const encryptedQueryParameter = optionalBoundedString(media.encrypt_query_param, "media query", MAX_FIELD_BYTES);
  const aesKey = optionalBoundedString(media.aes_key, "media AES key", 1024);
  return {
    ...(fullUrl === undefined ? {} : { fullUrl }),
    ...(encryptedQueryParameter === undefined ? {} : { encryptedQueryParameter }),
    ...(aesKey === undefined ? {} : { aesKey }),
  };
}

function optionalSafeInteger(value: unknown, label: string, min: number, max: number): number | undefined {
  return value === undefined ? undefined : boundedSafeInteger(value, label, min, max);
}

function optionalBoundedString(value: unknown, label: string, maxBytes: number, allowEmpty = false): string | undefined {
  if (value === undefined || (allowEmpty && value === "")) return undefined;
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) throw new TypeError(`${label} is invalid`);
  return boundedString(value, label, maxBytes);
}

function boundedString(value: string, label: string, maxBytes: number): string {
  if (Buffer.byteLength(value) > maxBytes) throw new WeixinLimitError(`WeChat ${label} limit exceeded`);
  return value;
}

function numericText(value: unknown): string {
  if (isLosslessNumber(value)) return value.value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  throw new TypeError("numeric value is invalid");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function assertJsonDepth(value: string, maxDepth: number): void {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > maxDepth) throw new WeixinLimitError("WeChat response nesting limit exceeded");
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
}

import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { parse as parseLosslessJson } from "lossless-json";
import { APP_VERSION } from "../version.ts";
import type { WeixinCredential, WeixinCredentialHandle } from "./credential-store.ts";
import { resolveTencentRedirect, validateTencentUrl, type WeixinEndpointKind } from "./endpoint-policy.ts";
import { boundedSafeInteger, parseUpdates, readBoundedJson, WeixinProtocolError, type ParsedUpdates } from "./protocol.ts";

const API_JSON_LIMIT = 8 * 1024 * 1024;
const JSON_DEPTH_LIMIT = 64;
const FIELD_LIMIT = 16 * 1024;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_CDN_BASE = "https://novac2c.cdn.weixin.qq.com";

export type WeixinFailureCategory = "authorization" | "rate_limit" | "invalid_request" | "service" | "unknown";

export class WeixinApiError extends Error {
  constructor(
    readonly category: WeixinFailureCategory,
    message: string,
    readonly options: { status?: number; protocolCode?: number; uncertain?: boolean } = {},
  ) {
    super(message);
    this.name = "WeixinApiError";
  }

  get uncertain(): boolean { return this.options.uncertain ?? false; }
}

export interface WeixinHttpTransport {
  fetch(url: URL, init: RequestInit): Promise<Response>;
}

export interface WeixinUploadRequest {
  fileKey: string;
  mediaType: 1 | 3;
  ownerUserId: string;
  plaintextSize: number;
  plaintextMd5: string;
  ciphertextSize: number;
  aesKeyHex: string;
}

export interface WeixinUploadTarget {
  url: URL;
}

export interface WeixinSendMessageRequest {
  msg: Record<string, unknown>;
}

interface ClientOptions {
  nextUin?: () => number;
  apiTimeoutMs?: number;
  configTimeoutMs?: number;
  longPollTimeoutMs?: number;
}

const defaultTransport: WeixinHttpTransport = { fetch: (url, init) => fetch(url, init) };

export class WeixinApiClient {
  private readonly nextUin: () => number;
  private readonly apiTimeoutMs: number;
  private readonly configTimeoutMs: number;
  private readonly longPollTimeoutMs: number;
  private typingTicket: string | undefined;

  constructor(
    private readonly credential: WeixinCredentialHandle,
    private readonly transport: WeixinHttpTransport = defaultTransport,
    options: ClientOptions = {},
  ) {
    this.nextUin = options.nextUin ?? randomUint32;
    this.apiTimeoutMs = options.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    this.configTimeoutMs = options.configTimeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS;
    this.longPollTimeoutMs = options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  }

  getUpdates(cursor: string, signal: AbortSignal, serverTimeoutMs?: number): Promise<ParsedUpdates> {
    return this.authenticatedJson("get-updates", {
      get_updates_buf: cursor,
      base_info: baseInfo(),
    }, requestLongPollTimeout(this.longPollTimeoutMs, serverTimeoutMs), signal, (raw) => parseUpdates(raw));
  }

  async getConfig(signal?: AbortSignal): Promise<{ typingTicket?: string }> {
    const result = await this.authenticatedObject("get-config", (credential) => ({
      ilink_user_id: credential.ownerUserId,
      base_info: baseInfo(),
    }), this.configTimeoutMs, signal, "require-ret");
    const typingTicket = optionalBoundedString(result.typing_ticket, "typing ticket");
    this.typingTicket = typingTicket;
    return typingTicket === undefined ? {} : { typingTicket };
  }

  async sendMessage(request: WeixinSendMessageRequest, signal?: AbortSignal): Promise<{ messageId?: string }> {
    const result = await this.authenticatedObject("send-message", {
      ...request,
      base_info: baseInfo(),
    }, this.apiTimeoutMs, signal, "require-ret-uncertain");
    try {
      const messageId = optionalBoundedString(result.message_id, "message receipt");
      return messageId === undefined ? {} : { messageId };
    } catch (error) {
      throw asPostDispatchAmbiguity(error);
    }
  }

  async getUploadUrl(request: WeixinUploadRequest, signal?: AbortSignal): Promise<WeixinUploadTarget> {
    validateUploadRequest(request);
    const result = await this.authenticatedObject("get-upload-url", {
      filekey: request.fileKey,
      media_type: request.mediaType,
      to_user_id: request.ownerUserId,
      rawsize: request.plaintextSize,
      rawfilemd5: request.plaintextMd5,
      filesize: request.ciphertextSize,
      no_need_thumb: true,
      aeskey: request.aesKeyHex,
      base_info: baseInfo(),
    }, this.apiTimeoutMs, signal, "optional-ret");
    const full = optionalBoundedString(result.upload_full_url, "upload URL");
    const parameter = optionalBoundedString(result.upload_param, "upload parameter");
    if (full) return { url: validateTencentUrl(full, "cdn-upload") };
    if (!parameter) throw new WeixinApiError("invalid_request", "WeChat upload target is invalid");
    const url = new URL("/c2c/upload", DEFAULT_CDN_BASE);
    url.searchParams.set("encrypted_query_param", parameter);
    url.searchParams.set("filekey", request.fileKey);
    return { url: validateTencentUrl(url, "cdn-upload") };
  }

  upload(
    target: WeixinUploadTarget,
    body: AsyncIterable<Uint8Array | string>,
    signal?: AbortSignal,
  ): Promise<{ encryptedQueryParameter: string }> {
    const url = validateTencentUrl(target.url, "cdn-upload");
    return (async () => {
      const stream = Readable.from(body);
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: stream as unknown as BodyInit,
        duplex: "half",
      };
      const lease = await requestWithRedirects(
        this.transport,
        url,
        (dispatch) => this.credential.withVerifiedCredential(async () => dispatch(init)),
        "cdn-upload",
        signal,
        this.apiTimeoutMs,
        "reject-uncertain",
      );
      try {
        if (lease.response.status !== 200) throw httpError(lease.response.status);
        const receipt = lease.response.headers.get("x-encrypted-param");
        if (!receipt || Buffer.byteLength(receipt) > FIELD_LIMIT || /[\r\n]/u.test(receipt)) {
          throw new WeixinApiError("unknown", "WeChat CDN upload receipt is invalid", { uncertain: true });
        }
        return { encryptedQueryParameter: receipt };
      } finally {
        lease.release();
      }
    })();
  }

  download(url: URL, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const target = validateTencentUrl(url, "cdn-download");
    return (async () => {
      const lease = await requestWithRedirects(
        this.transport,
        target,
        (dispatch) => this.credential.withVerifiedCredential(async () => dispatch({ method: "GET", headers: {} })),
        "cdn-download",
        signal,
        this.apiTimeoutMs,
      );
      if (!lease.response.ok) {
        lease.release();
        throw httpError(lease.response.status);
      }
      if (!lease.response.body) {
        lease.release();
        throw new WeixinApiError("unknown", "WeChat CDN response has no body");
      }
      return leasedBody(lease.response.body, lease.signal, lease.release);
    })();
  }

  async sendTyping(state: "start" | "stop", signal?: AbortSignal): Promise<void> {
    await this.authenticatedObject("send-typing", (credential) => ({
      ilink_user_id: credential.ownerUserId,
      ...(this.typingTicket === undefined ? {} : { typing_ticket: this.typingTicket }),
      status: state === "start" ? 1 : 2,
      base_info: baseInfo(),
    }), this.configTimeoutMs, signal, "require-ret");
  }

  async notifyLifecycle(state: "start" | "stop", signal?: AbortSignal): Promise<void> {
    await this.authenticatedObject(state === "start" ? "notify-start" : "notify-stop", {
      base_info: baseInfo(),
    }, this.configTimeoutMs, signal, "require-ret");
  }

  private authenticatedObject(
    kind: Exclude<WeixinEndpointKind, "qr-create" | "qr-status" | "cdn-download" | "cdn-upload" | "get-updates">,
    body: Record<string, unknown> | ((credential: Readonly<WeixinCredential>) => Record<string, unknown>),
    timeoutMs: number,
    signal?: AbortSignal,
    responsePolicy: "require-ret" | "require-ret-uncertain" | "optional-ret" = "require-ret",
  ): Promise<Record<string, unknown>> {
    return this.authenticatedJson(kind, body, timeoutMs, signal, (raw) => {
      const result = parseObject(raw);
      assertProtocolSuccess(result, responsePolicy);
      return result;
    });
  }

  private authenticatedJson<T>(
    kind: Exclude<WeixinEndpointKind, "qr-create" | "qr-status" | "cdn-download" | "cdn-upload">,
    body: Record<string, unknown> | ((credential: Readonly<WeixinCredential>) => Record<string, unknown>),
    timeoutMs: number,
    signal: AbortSignal | undefined,
    decode: (raw: string) => T,
  ): Promise<T> {
    const publicCredential = this.credential.public;
    const url = validateTencentUrl(new URL(pathFor(kind), publicCredential.apiBaseUrl), kind);
    return (async () => {
      const lease = await requestWithRedirects(this.transport, url, (dispatch) => this.credential.withVerifiedCredential(async (credential) => dispatch({
        method: "POST",
        headers: authenticatedHeaders(credential.botToken, this.nextUin()),
        body: JSON.stringify(typeof body === "function" ? body(credential) : body),
      })), kind, signal, timeoutMs, kind === "send-message" ? "reject-uncertain" : "follow");
      try {
        if (!lease.response.ok) throw httpError(lease.response.status, kind === "send-message");
        const raw = await readBoundedJson(
          lease.response,
          { maxBytes: API_JSON_LIMIT, maxDepth: JSON_DEPTH_LIMIT },
          lease.signal,
        );
        try { return decode(raw); }
        catch (error) {
          if (error instanceof WeixinProtocolError) throw protocolError(error);
          throw error;
        }
      } catch (error) {
        if (kind === "send-message") throw asPostDispatchAmbiguity(error);
        throw error;
      } finally {
        lease.release();
      }
    })();
  }
}

function requestLongPollTimeout(defaultTimeoutMs: number, serverTimeoutMs: number | undefined): number {
  if (serverTimeoutMs === undefined) return defaultTimeoutMs;
  if (!Number.isSafeInteger(serverTimeoutMs) || serverTimeoutMs < 1 || serverTimeoutMs > 600_000) {
    throw new TypeError("WeChat long-poll timeout is invalid");
  }
  return Math.min(605_000, serverTimeoutMs + 5_000);
}

export function commonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": String(packedClientVersion(APP_VERSION)),
  };
}

export function authenticatedHeaders(token: string, uin: number): Record<string, string> {
  return {
    ...commonHeaders(),
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": encodeUin(uin),
    Authorization: `Bearer ${token}`,
  };
}

export function encodeUin(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new TypeError("WeChat UIN is invalid");
  return Buffer.from(String(value)).toString("base64");
}

export async function requestWithRedirects(
  transport: WeixinHttpTransport,
  initialUrl: URL,
  request: RequestInit | ((dispatch: (init: RequestInit) => Promise<Response>) => Promise<Response>),
  kind: WeixinEndpointKind,
  externalSignal?: AbortSignal,
  timeoutMs?: number,
  redirectPolicy: "follow" | "reject-uncertain" = "follow",
): Promise<{ response: Response; signal: AbortSignal | undefined; release(): void }> {
  const { signal, cleanup } = combinedSignal(externalSignal, timeoutMs);
  let url = validateTencentUrl(initialUrl, kind);
  let released = false;
  let dispatched = false;
  const release = () => {
    if (released) return;
    released = true;
    cleanup();
  };
  try {
    for (let hop = 0; hop <= 3; hop += 1) {
      let dispatchedInit: RequestInit | undefined;
      const dispatch = async (init: RequestInit): Promise<Response> => {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        dispatchedInit = init;
        try {
          dispatched = true;
          return await transport.fetch(url, { ...init, redirect: "manual", ...(signal ? { signal } : {}) });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          throw new WeixinApiError("unknown", "WeChat network request failed", redirectPolicy === "reject-uncertain" ? { uncertain: true } : {});
        }
      };
      const response = typeof request === "function" ? await request(dispatch) : await dispatch(request);
      const init = dispatchedInit;
      if (!init) throw new TypeError("WeChat request was not dispatched");
      if (response.status < 300 || response.status > 399) return { response, signal, release };
      const location = response.headers.get("location");
      if (!location) throw new WeixinApiError("unknown", "WeChat redirect is invalid");
      if (hop === 3) throw new WeixinApiError("unknown", "WeChat redirect limit exceeded");
      const next = resolveTencentRedirect(url, location, kind, hop + 1);
      await response.body?.cancel().catch(() => undefined);
      if (redirectPolicy === "reject-uncertain") {
        throw new WeixinApiError("unknown", "WeChat post-dispatch redirect is uncertain", { uncertain: true });
      }
      const method = (init.method ?? "GET").toUpperCase();
      if (![301, 302, 303, 307, 308].includes(response.status)
        || ((method !== "GET" && method !== "HEAD") && response.status !== 307 && response.status !== 308)) {
        throw new WeixinApiError("unknown", "WeChat redirect status is unsupported");
      }
      url = next;
    }
    throw new WeixinApiError("unknown", "WeChat redirect limit exceeded");
  } catch (error) {
    release();
    if (redirectPolicy === "reject-uncertain" && dispatched) throw asPostDispatchAmbiguity(error);
    throw error;
  }
}

function parseObject(raw: string): Record<string, unknown> {
  let value: unknown;
  try { value = parseLosslessJson(raw); }
  catch { throw new WeixinApiError("unknown", "WeChat response JSON is invalid"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new WeixinApiError("unknown", "WeChat response envelope is invalid");
  return value as Record<string, unknown>;
}

function assertProtocolSuccess(
  value: Record<string, unknown>,
  policy: "require-ret" | "require-ret-uncertain" | "optional-ret",
): void {
  const ret = optionalCode(value.ret);
  const errcode = optionalCode(value.errcode);
  if (ret === -14 || errcode === -14) throw new WeixinApiError("authorization", "WeChat authorization is no longer valid", { protocolCode: -14 });
  const code = errcode && errcode !== 0 ? errcode : ret;
  if (code !== undefined && code !== 0) throw new WeixinApiError("invalid_request", "WeChat request was rejected", { protocolCode: code });
  if (policy !== "optional-ret" && ret !== 0) {
    throw new WeixinApiError("unknown", "WeChat response envelope is invalid", { uncertain: policy === "require-ret-uncertain" });
  }
}

function optionalCode(value: unknown): number | undefined {
  return value === undefined ? undefined : boundedSafeInteger(value, "response code", -2_147_483_648, 2_147_483_647);
}

function protocolError(error: WeixinProtocolError): WeixinApiError {
  return error.code === -14
    ? new WeixinApiError("authorization", "WeChat authorization is no longer valid", { protocolCode: -14 })
    : new WeixinApiError("invalid_request", "WeChat request was rejected", error.code === undefined ? {} : { protocolCode: error.code });
}

function asPostDispatchAmbiguity(error: unknown): WeixinApiError {
  if (error instanceof WeixinApiError) {
    if (error.uncertain || error.options.protocolCode !== undefined) return error;
  }
  return new WeixinApiError("unknown", "WeChat post-dispatch result is uncertain", { uncertain: true });
}

function httpError(status: number, uncertain = false): WeixinApiError {
  const category: WeixinFailureCategory = status === 401 || status === 403 ? "authorization"
    : status === 429 ? "rate_limit"
      : status >= 400 && status < 500 ? "invalid_request"
        : status >= 500 ? "service"
          : "unknown";
  return new WeixinApiError(category, "WeChat HTTP request failed", { status, ...(uncertain ? { uncertain: true } : {}) });
}

function validateUploadRequest(value: WeixinUploadRequest): void {
  if (!/^[a-f0-9]{32}$/u.test(value.fileKey)) throw new TypeError("WeChat file key is invalid");
  if (!/^[a-f0-9]{32}$/u.test(value.plaintextMd5)) throw new TypeError("WeChat file digest is invalid");
  if (!/^[a-f0-9]{32}$/u.test(value.aesKeyHex)) throw new TypeError("WeChat AES key is invalid");
  if (!value.ownerUserId || Buffer.byteLength(value.ownerUserId) > 1024) throw new TypeError("WeChat owner identity is invalid");
  for (const number of [value.plaintextSize, value.ciphertextSize]) {
    if (!Number.isSafeInteger(number) || number < 0) throw new TypeError("WeChat upload size is invalid");
  }
}

function optionalBoundedString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > FIELD_LIMIT) {
    throw new WeixinApiError("unknown", `WeChat ${label} is invalid`);
  }
  return value;
}

function pathFor(kind: Exclude<WeixinEndpointKind, "qr-create" | "qr-status" | "cdn-download" | "cdn-upload">): string {
  switch (kind) {
    case "get-updates": return "/ilink/bot/getupdates";
    case "get-upload-url": return "/ilink/bot/getuploadurl";
    case "send-message": return "/ilink/bot/sendmessage";
    case "get-config": return "/ilink/bot/getconfig";
    case "send-typing": return "/ilink/bot/sendtyping";
    case "notify-start": return "/ilink/bot/msg/notifystart";
    case "notify-stop": return "/ilink/bot/msg/notifystop";
  }
}

function baseInfo(): { channel_version: string; bot_agent: string } {
  return { channel_version: APP_VERSION, bot_agent: `QiYan/${APP_VERSION}` };
}

function packedClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((value) => Number.parseInt(value, 10));
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function randomUint32(): number { return randomBytes(4).readUInt32BE(0); }

function combinedSignal(external: AbortSignal | undefined, timeoutMs: number | undefined): { signal?: AbortSignal; cleanup(): void } {
  if (timeoutMs === undefined && external === undefined) return { cleanup: () => undefined };
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (external?.aborted) controller.abort();
  else external?.addEventListener("abort", abort, { once: true });
  const timer = timeoutMs === undefined ? undefined : setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    },
  };
}

function leasedBody(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  release: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* a cancelled pending read releases its lock when settled */ }
    release();
  };
  const onAbort = () => {
    controller?.error(new DOMException("aborted", "AbortError"));
    void reader.cancel().catch(() => undefined).finally(finish);
  };
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(value) {
      try {
        const result = await reader.read();
        if (result.done) {
          value.close();
          finish();
        } else {
          value.enqueue(result.value);
        }
      } catch (error) {
        value.error(error);
        finish();
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { finish(); }
    },
  });
}

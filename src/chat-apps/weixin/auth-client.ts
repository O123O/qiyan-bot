import { parse as parseLosslessJson } from "lossless-json";
import {
  commonHeaders,
  encodeUin,
  requestWithRedirects,
  WeixinApiClient,
  type WeixinHttpTransport,
} from "./api-client.ts";
import type { WeixinCredentialHandle } from "./credential-store.ts";
import { validateTencentUrl } from "./endpoint-policy.ts";
import { readBoundedJson } from "./protocol.ts";

const FIXED_QR_BASE = "https://ilinkai.weixin.qq.com";
const AUTH_JSON_LIMIT = 256 * 1024;
const JSON_DEPTH_LIMIT = 64;
const FIELD_LIMIT = 16 * 1024;
const QR_TIMEOUT_MS = 35_000;

export interface WeixinQrChallenge {
  token: string;
  payload: string;
  baseUrl: string;
}

export type WeixinQrState =
  | { status: "wait" | "scaned" | "need_verifycode" | "verify_code_blocked" | "binded_redirect" | "expired" }
  | { status: "scaned_but_redirect"; redirectBaseUrl: string }
  | {
    status: "confirmed";
    botToken?: string;
    botId?: string;
    ownerUserId?: string;
    apiBaseUrl?: string;
  };

interface AuthClientOptions {
  nextUin?: () => number;
  timeoutMs?: number;
}

export class WeixinAuthClient {
  private readonly nextUin: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly transport: WeixinHttpTransport, options: AuthClientOptions = {}) {
    this.nextUin = options.nextUin ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]!);
    this.timeoutMs = options.timeoutMs ?? QR_TIMEOUT_MS;
  }

  async probeCredential(credential: WeixinCredentialHandle, signal?: AbortSignal): Promise<void> {
    await new WeixinApiClient(credential, this.transport).getConfig(signal);
  }

  async createQr(localToken?: string, signal?: AbortSignal): Promise<WeixinQrChallenge> {
    if (localToken !== undefined && (!localToken || Buffer.byteLength(localToken) > FIELD_LIMIT)) {
      throw new TypeError("WeChat prior token is invalid");
    }
    const url = validateTencentUrl(`${FIXED_QR_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, "qr-create");
    const lease = await requestWithRedirects(this.transport, url, (dispatch) => dispatch({
      method: "POST",
      headers: {
        ...commonHeaders(),
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": encodeUin(this.nextUin()),
      },
      body: JSON.stringify({ local_token_list: localToken === undefined ? [] : [localToken] }),
    }), "qr-create", signal, this.timeoutMs);
    try {
      if (!lease.response.ok) throw new TypeError("WeChat QR request failed");
      const value = await readAuthObject(lease.response, lease.signal);
      const token = requiredString(value.qrcode, "QR response");
      const payload = requiredString(value.qrcode_img_content, "QR response");
      return { token, payload, baseUrl: FIXED_QR_BASE };
    } finally {
      lease.release();
    }
  }

  async pollQr(challenge: WeixinQrChallenge, verificationCode?: string, signal?: AbortSignal): Promise<WeixinQrState> {
    if (!challenge.token || Buffer.byteLength(challenge.token) > FIELD_LIMIT) throw new TypeError("WeChat QR challenge is invalid");
    if (verificationCode !== undefined && !/^\d{4,12}$/u.test(verificationCode)) throw new TypeError("WeChat verification code is invalid");
    const url = new URL("/ilink/bot/get_qrcode_status", validateQrBase(challenge.baseUrl));
    url.searchParams.set("qrcode", challenge.token);
    if (verificationCode !== undefined) url.searchParams.set("verify_code", verificationCode);
    const lease = await requestWithRedirects(this.transport, validateTencentUrl(url, "qr-status"), (dispatch) => dispatch({
      method: "GET",
      headers: commonHeaders(),
    }), "qr-status", signal, this.timeoutMs);
    try {
      if (!lease.response.ok) throw new TypeError("WeChat QR request failed");
      const value = await readAuthObject(lease.response, lease.signal);
      const status = requiredString(value.status, "QR response");
      if (status === "wait" || status === "scaned" || status === "need_verifycode" || status === "verify_code_blocked" || status === "binded_redirect" || status === "expired") {
        return { status };
      }
      if (status === "scaned_but_redirect") {
        const redirectHost = requiredString(value.redirect_host, "QR response");
        const redirectBaseUrl = validateRedirectBase(redirectHost, challenge.token, verificationCode);
        return { status, redirectBaseUrl };
      }
      if (status === "confirmed") {
        return {
          status,
          ...(value.bot_token === undefined ? {} : { botToken: requiredString(value.bot_token, "QR response") }),
          ...(value.ilink_bot_id === undefined ? {} : { botId: requiredString(value.ilink_bot_id, "QR response") }),
          ...(value.ilink_user_id === undefined ? {} : { ownerUserId: requiredString(value.ilink_user_id, "QR response") }),
          ...(value.baseurl === undefined ? {} : { apiBaseUrl: validateApiBase(requiredString(value.baseurl, "QR response")) }),
        };
      }
      throw new TypeError("WeChat QR response is invalid");
    } finally {
      lease.release();
    }
  }
}

async function readAuthObject(response: Response, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const raw = await readBoundedJson(response, { maxBytes: AUTH_JSON_LIMIT, maxDepth: JSON_DEPTH_LIMIT }, signal);
  let value: unknown;
  try { value = parseLosslessJson(raw); }
  catch { throw new TypeError("WeChat QR response is invalid"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("WeChat QR response is invalid");
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > FIELD_LIMIT) throw new TypeError(`WeChat ${label} is invalid`);
  return value;
}

function validateQrBase(value: string): URL {
  let base: URL;
  try { base = new URL(value); }
  catch { throw new TypeError("WeChat endpoint is not trusted"); }
  if (base.pathname !== "/" || base.search || base.hash) throw new TypeError("WeChat endpoint is not trusted");
  const probe = new URL("/ilink/bot/get_qrcode_status?qrcode=probe", base);
  validateTencentUrl(probe, "qr-status");
  return new URL(base.origin);
}

function validateRedirectBase(value: string, token: string, verificationCode?: string): string {
  const candidate = value.includes("://") ? value : `https://${value}`;
  const base = validateQrBase(candidate);
  const probe = new URL("/ilink/bot/get_qrcode_status", base);
  probe.searchParams.set("qrcode", token);
  if (verificationCode !== undefined) probe.searchParams.set("verify_code", verificationCode);
  validateTencentUrl(probe, "qr-status");
  return base.origin;
}

function validateApiBase(value: string): string {
  let base: URL;
  try { base = new URL(value); }
  catch { throw new TypeError("WeChat endpoint is not trusted"); }
  if (base.pathname !== "/" || base.search || base.hash) throw new TypeError("WeChat endpoint is not trusted");
  validateTencentUrl(new URL("/ilink/bot/getconfig", base), "get-config");
  return base.origin;
}

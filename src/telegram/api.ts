import { Readable } from "node:stream";
import type { TelegramUpdate } from "./types.ts";

export class TelegramApiError extends Error {
  constructor(readonly status: number, message: string, readonly response?: unknown) { super(message); this.name = "TelegramApiError"; }
  get deterministic(): boolean { return this.status >= 400 && this.status < 500 && this.status !== 429; }
}

interface ApiEnvelope<T> { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }

export function splitTelegramText(text: string, limit = 4096): string[] {
  if (text.length === 0) return [""];
  const parts: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + limit, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf("\n", end - 1);
      if (newline >= offset) end = newline + 1;
    }
    parts.push(text.slice(offset, end));
    offset = end;
  }
  return parts;
}

export class TelegramApi {
  private readonly fetch: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;

  constructor(token: string, options: { fetch?: typeof globalThis.fetch; sleep?: (ms: number) => Promise<void>; baseUrl?: string } = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.baseUrl = options.baseUrl ?? `https://api.telegram.org/bot${token}`;
  }

  getUpdates(offset: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.json<TelegramUpdate[]>("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] }, signal);
  }

  async sendMessage(chatId: number | string, text: string): Promise<{ message_id: number }> {
    let result: { message_id: number } | undefined;
    for (const part of splitTelegramText(text)) result = await this.json("sendMessage", { chat_id: chatId, text: part });
    return result as { message_id: number };
  }

  async downloadFile(fileId: string): Promise<{ stream: Readable; size?: number }> {
    const info = await this.json<{ file_path: string; file_size?: number }>("getFile", { file_id: fileId });
    const response = await this.fetch(`${this.baseUrl.replace(/\/bot[^/]+$/u, "")}/file${new URL(this.baseUrl).pathname}/${info.file_path}`);
    if (!response.ok || !response.body) throw new TelegramApiError(response.status, "Telegram file download failed");
    return { stream: Readable.from(response.body as unknown as AsyncIterable<Uint8Array>), ...(info.file_size === undefined ? {} : { size: info.file_size }) };
  }

  async sendDocument(chatId: number | string, file: { stream: AsyncIterable<Uint8Array | string>; size: number; displayName: string; mediaType: string }): Promise<{ message_id: number }> {
    const boundary = `codexbot-${crypto.randomUUID()}`;
    const safeName = file.displayName.replace(/["\r\n]/gu, "_");
    const preamble = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${safeName}"\r\nContent-Type: ${file.mediaType}\r\n\r\n`,
    );
    const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Readable.from((async function* () { yield preamble; for await (const chunk of file.stream) yield chunk; yield ending; })());
    const response = await this.fetch(`${this.baseUrl}/sendDocument`, {
      method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(preamble.length + file.size + ending.length) },
      body: body as unknown as BodyInit, duplex: "half",
    } as RequestInit & { duplex: "half" });
    return this.parse<{ message_id: number }>(response);
  }

  private async json<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetch(`${this.baseUrl}/${method}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
      });
      const payload = await response.clone().json().catch(() => undefined) as ApiEnvelope<T> | undefined;
      if (response.status === 429 && attempt < 3) {
        const seconds = payload?.parameters?.retry_after ?? 1;
        await this.sleep(seconds * 1_000);
        continue;
      }
      return this.parse<T>(response, payload);
    }
  }

  private async parse<T>(response: Response, known?: ApiEnvelope<T>): Promise<T> {
    const payload = known ?? await response.json().catch(() => undefined) as ApiEnvelope<T> | undefined;
    if (!response.ok || !payload?.ok || payload.result === undefined) {
      throw new TelegramApiError(response.status, payload?.description ?? `Telegram API failed with ${response.status}`, payload);
    }
    return payload.result;
  }
}


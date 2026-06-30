import assert from "node:assert/strict";
import test from "node:test";
import { TelegramApi, splitTelegramText } from "../../src/telegram/api.ts";

test("Bot API retries 429 using retry_after and returns the result", async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    calls.push(String(input));
    if (calls.length === 1) return new Response(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 2 } }), { status: 429 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
  };
  const api = new TelegramApi("token", { fetch, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal((await api.sendMessage(1, "hello")).message_id, 7);
  assert.deepEqual(sleeps, [2_000]);
});

test("long polling is abortable and file downloads expose a stream", async () => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("getUpdates")) {
      assert.ok(init?.signal);
      throw init?.signal?.reason ?? new Error("aborted");
    }
    if (url.includes("getFile")) return new Response(JSON.stringify({ ok: true, result: { file_path: "docs/a.txt" } }));
    return new Response("abc");
  };
  const api = new TelegramApi("token", { fetch });
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(api.getUpdates(3, controller.signal));
  const download = await api.downloadFile("file-1");
  const chunks: Buffer[] = [];
  for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "abc");
});

test("text splitting preserves every character within Telegram limits", () => {
  const input = `${"a".repeat(4090)}\n${"b".repeat(20)}`;
  const parts = splitTelegramText(input, 4096);
  assert.ok(parts.every((part) => part.length <= 4096));
  assert.equal(parts.join(""), input);
});

test("document upload streams multipart bytes and includes the safe display name", async () => {
  let body = "";
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    assert.match(String((init?.headers as Record<string, string>)["content-type"]), /^multipart\/form-data; boundary=/);
    for await (const chunk of init?.body as AsyncIterable<Uint8Array>) body += Buffer.from(chunk).toString();
    return new Response(JSON.stringify({ ok: true, result: { message_id: 8 } }));
  };
  const api = new TelegramApi("token", { fetch });
  await api.sendDocument(9, { stream: (async function* () { yield Buffer.from("payload"); })(), size: 7, displayName: "report.txt", mediaType: "text/plain" });
  assert.match(body, /name="chat_id"/);
  assert.match(body, /filename="report.txt"/);
  assert.match(body, /payload/);
});


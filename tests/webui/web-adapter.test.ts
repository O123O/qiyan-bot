import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebBus } from "../../src/webui/web-bus.ts";
import { createWebAdapter } from "../../src/webui/web-adapter.ts";

const fakeSocket = (sink: unknown[]) => ({ readyState: 1, send: (s: string) => sink.push(JSON.parse(s)) });

test("sendDocument stores the file in the web store and broadcasts its path", async () => {
  const bus = new WebBus();
  const events: Array<{ type: string; body: string }> = [];
  bus.add(fakeSocket(events) as never);
  const dir = await mkdtemp(join(tmpdir(), "qiyan-out-"));
  const annotations: Array<{ id: string; text: string }> = [];
  const adapter = createWebAdapter(bus, { dir, maxBytes: 1024, ttlMs: 1e9 }, (id, text) => annotations.push({ id, text }));
  async function* stream() { yield Buffer.from("report bytes"); }
  const result = await adapter.delivery.sendDocument!({ surface: "web" }, { stream: stream(), size: 12, displayName: "report.txt", mediaType: "text/plain", deliveryId: "d1", caption: "here you go" });

  assert.equal((result as { delivered: boolean }).delivered, true);
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /report\.txt$/); // sanitized, unique-prefixed
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "message");
  assert.match(events[0]!.body, /here you go/);       // caption preserved
  assert.ok(events[0]!.body.includes(join(dir, files[0]!))); // clickable stored path
  // path persisted into the durable delivery body (survives reload), keyed by deliveryId
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0]!.id, "d1");
  assert.ok(annotations[0]!.text.includes(join(dir, files[0]!)));
});

test("sendDocument rejects a stream exceeding the size limit", async () => {
  const bus = new WebBus();
  const dir = await mkdtemp(join(tmpdir(), "qiyan-out-"));
  const adapter = createWebAdapter(bus, { dir, maxBytes: 4, ttlMs: 1e9 });
  async function* big() { yield Buffer.from("toolong"); }
  await assert.rejects(adapter.delivery.sendDocument!({ surface: "web" }, { stream: big(), size: 7, displayName: "x.txt", mediaType: "text/plain", deliveryId: "d" }));
});

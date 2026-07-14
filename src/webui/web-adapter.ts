import { AppError } from "../core/errors.ts";
import type { ChatAdapter } from "../chat-apps/shared/contracts.ts";
import type { ConversationBinding } from "../chat-apps/shared/binding.ts";
import type { JsonValue } from "../chat-apps/shared/binding.ts";
import type { WebBus } from "./web-bus.ts";
import { storeUpload, type WebUploadsConfig } from "./web-uploads.ts";

export const WEB_ADAPTER_ID = "web";
// A stable single-owner conversation for the browser surface. Web input is routed through this
// binding so the assistant treats the browser as one conversation (co-tenant of the owner route).
export const WEB_BINDING: ConversationBinding = {
  adapterId: WEB_ADAPTER_ID,
  conversationKey: "web:owner",
  destination: { surface: "web" },
};

// The `web` ChatAdapter. Inbound (browser → assistant) is driven by the HTTP server calling
// `acceptChat` with a WEB_BINDING source (not this object). Outbound (assistant reply → browser)
// arrives here via the DeliveryWorker → `sendMessage`/`sendDocument`, fanned out to connected sockets.
export function createWebAdapter(bus: WebBus, uploads: WebUploadsConfig): ChatAdapter {
  return {
    primaryBinding: WEB_BINDING,
    delivery: {
      id: WEB_ADAPTER_ID,
      sendMessage: async (_destination: JsonValue, body: string): Promise<JsonValue> => {
        bus.broadcast({ type: "message", body, at: Date.now() });
        return { delivered: true };
      },
      // The browser has no native file delivery. A file QiYan sends is persisted into the SAME backend
      // file store used for inbound sends, and its path is broadcast in the message body (the client
      // linkifies it → clickable preview). No download surface.
      sendDocument: async (_destination, file): Promise<JsonValue> => {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of file.stream) {
          const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
          size += buf.length;
          if (size > uploads.maxBytes) throw new AppError("ATTACHMENT_INVALID", "file exceeds the web store size limit");
          chunks.push(buf);
        }
        const stored = await storeUpload(uploads, file.displayName, Buffer.concat(chunks), Date.now());
        if ("error" in stored) throw new AppError("ATTACHMENT_INVALID", stored.error);
        bus.broadcast({ type: "message", body: `${file.caption ? file.caption + "\n\n" : ""}📎 ${stored.path}`, at: Date.now() });
        return { delivered: true, path: stored.path };
      },
      isSafeToRetry: () => false, // storing to disk is deterministic; don't re-copy on failure
    },
    async initialize() {},
    start() {},
    async stop() {},
    async close() {},
  };
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, extname, join, normalize } from "node:path";
import { WebSocketServer } from "ws";
import type { OperationalEvent } from "../core/operational-log.ts";
import type { WebBus } from "./web-bus.ts";
import { assistantTranscript, listSessions, transcript, type WebReadsDeps } from "./web-reads.ts";
import { browse, confine, type WebFilesDeps } from "./web-files.ts";
import { cleanupUploads, previewUpload, storeUpload, type WebUploadsConfig } from "./web-uploads.ts";

const AUTH_COOKIE = "qiyan_web_token";
const POLL_MS = 1_000;
// Browser-native types are streamed raw (Content-Type set) so a new tab renders them; everything
// else is served as JSON text via the preview endpoints. Unknown types download as octet-stream.
const RAW_CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf", ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".svg": "image/svg+xml", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8", ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".csv": "text/csv; charset=utf-8",
};

// Stream a file confined to `root` with a best-effort Content-Type so the browser can render it inline.
async function serveRaw(response: ServerResponse, root: string, relPath: string): Promise<void> {
  const target = await confine(root, relPath === "" ? "." : relPath);
  const info = target ? await stat(target).catch(() => undefined) : undefined;
  if (!target || !info?.isFile()) { response.writeHead(404, { "content-type": "text/plain" }); response.end("not found"); return; }
  const contentType = RAW_CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string> = {
    "content-type": contentType, "content-length": String(info.size),
    "content-disposition": "inline", "x-content-type-options": "nosniff",
  };
  // Neuter scripts/callbacks in previewed HTML (it renders as a unique, isolated origin).
  if (contentType.startsWith("text/html")) headers["content-security-policy"] = "sandbox";
  response.writeHead(200, headers);
  createReadStream(target).pipe(response);
}
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png",
};

export interface WebServerOptions {
  host: string;
  port: number;
  allowLan: boolean;
  token: string;
  staticDir: string;
  bus: WebBus;
  reads: WebReadsDeps;
  files: WebFilesDeps;
  uploads?: WebUploadsConfig;
  submitInput(text: string, target: string | undefined): Promise<{ ok: boolean; error?: string }>;
  report(event: OperationalEvent): void;
}

export interface WebServer {
  start(): Promise<{ url: string }>;
  stop(): Promise<void>;
}

// Parse ?limit= (1..50, default 20) and an optional ?before= millis cursor for scroll-up paging.
function pageParams(url: URL): { limit: number; before: number | undefined } {
  const rawLimit = Number(url.searchParams.get("limit") ?? "20");
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(50, Math.trunc(rawLimit))) : 20;
  const rawBefore = url.searchParams.get("before");
  const before = rawBefore !== null && Number.isFinite(Number(rawBefore)) ? Number(rawBefore) : undefined;
  return { limit, before };
}

function tokenValid(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenFromRequest(request: IncomingMessage, url: URL): string | undefined {
  const query = url.searchParams.get("token");
  if (query) return query;
  const cookie = request.headers.cookie;
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === AUTH_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function createWebServer(options: WebServerOptions): WebServer {
  const host = options.allowLan ? options.host : "127.0.0.1";
  const wss = new WebSocketServer({ noServer: true });
  let server: Server | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let uploadSweep: ReturnType<typeof setInterval> | undefined;
  let lastSessions = "";

  const json = (response: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    response.end(payload);
  };

  const serveStatic = async (response: ServerResponse, pathname: string): Promise<void> => {
    // Confine to the static dir; a normalized path that escapes it falls back to index.html (SPA).
    const relative = normalize(pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
    const candidate = relative.startsWith("..") ? "index.html" : relative;
    // Only fall back to the SPA for route-like paths (no file extension). A path with an extension that
    // isn't a real static asset 404s rather than returning index.html — otherwise a stray navigation to
    // e.g. /home/…/notes.md would render the chat page in a new tab.
    const candidates = extname(candidate) ? [candidate] : [candidate, "index.html"];
    for (const file of candidates) {
      const full = join(options.staticDir, file);
      try {
        if (!(await stat(full)).isFile()) continue;
        const body = await readFile(full);
        response.writeHead(200, { "content-type": CONTENT_TYPES[extname(full)] ?? "application/octet-stream" });
        response.end(body);
        return;
      } catch { /* try the SPA fallback */ }
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const token = tokenFromRequest(request, url);
    if (!tokenValid(options.token, token)) {
      // A correct ?token= sets the cookie so later same-origin requests (and the WS) authenticate.
      response.writeHead(401, { "content-type": "text/plain" });
      response.end("unauthorized");
      return;
    }
    if (url.searchParams.has("token")) {
      response.setHeader("set-cookie", `${AUTH_COOKIE}=${encodeURIComponent(options.token)}; HttpOnly; SameSite=Lax; Path=/`);
    }

    if (request.method === "GET" && url.pathname === "/api/sessions") { json(response, 200, { sessions: listSessions(options.reads) }); return; }
    if (request.method === "GET" && url.pathname === "/api/assistant/messages") {
      const { limit, before } = pageParams(url);
      json(response, 200, assistantTranscript(options.reads, limit, before));
      return;
    }
    const messages = /^\/api\/sessions\/([a-z0-9][a-z0-9_-]{0,63})\/messages$/u.exec(url.pathname);
    if (request.method === "GET" && messages) {
      const { limit, before } = pageParams(url);
      const result = transcript(options.reads, messages[1]!, limit, before);
      if (!result) { json(response, 404, { error: "unknown session" }); return; }
      json(response, 200, result);
      return;
    }
    // Local file browsing, confined to the named session's project directory (web-files.ts).
    const files = /^\/api\/files\/([a-z0-9][a-z0-9_-]{0,63})$/u.exec(url.pathname);
    if (request.method === "GET" && files) {
      const result = await browse(options.files, files[1]!, url.searchParams.get("path") ?? "");
      json(response, "error" in result ? 400 : 200, result);
      return;
    }
    // Send-file: store the uploaded bytes in the backend upload dir; the client appends the returned
    // path to its message so the assistant/worker reads the file by path.
    if (request.method === "POST" && url.pathname === "/api/upload") {
      if (!options.uploads) { json(response, 501, { error: "uploads are disabled" }); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > options.uploads.maxBytes) { json(response, 413, { error: "file exceeds the size limit" }); return; } chunks.push(chunk as Buffer); }
      const result = await storeUpload(options.uploads, url.searchParams.get("name") ?? "file", Buffer.concat(chunks), Date.now());
      json(response, "error" in result ? 400 : 200, result);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/upload/preview") {
      if (!options.uploads) { json(response, 501, { error: "uploads are disabled" }); return; }
      const result = await previewUpload(options.uploads, url.searchParams.get("path") ?? "");
      json(response, "error" in result ? 400 : 200, result);
      return;
    }
    // Raw streaming for browser-native types (pdf/html/image → open in a new tab).
    if (request.method === "GET" && url.pathname === "/api/upload/raw") {
      if (!options.uploads) { json(response, 501, { error: "uploads are disabled" }); return; }
      await serveRaw(response, options.uploads.dir, basename(url.searchParams.get("path") ?? ""));
      return;
    }
    const rawFile = /^\/api\/files\/([a-z0-9][a-z0-9_-]{0,63})\/raw$/u.exec(url.pathname);
    if (request.method === "GET" && rawFile) {
      const root = options.files.projectDir(rawFile[1]!);
      if (!root) { json(response, 404, { error: "unknown session" }); return; }
      await serveRaw(response, root, url.searchParams.get("path") ?? "");
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/input") {
      let raw = "";
      for await (const chunk of request) { raw += chunk; if (raw.length > 256 * 1024) { json(response, 413, { error: "too large" }); return; } }
      let parsed: { text?: unknown; target?: unknown };
      try { parsed = JSON.parse(raw || "{}"); } catch { json(response, 400, { error: "invalid json" }); return; }
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      const target = typeof parsed.target === "string" && parsed.target ? parsed.target : undefined;
      if (!text) { json(response, 400, { error: "text is required" }); return; }
      const result = await options.submitInput(text, target);
      json(response, result.ok ? 200 : 400, result);
      return;
    }
    if (request.method === "GET") { await serveStatic(response, url.pathname); return; }
    response.writeHead(405, { "content-type": "text/plain" });
    response.end("method not allowed");
  };

  return {
    async start() {
      server = createServer((request, response) => { void handle(request, response).catch(() => { try { response.writeHead(500); response.end("error"); } catch { /* already sent */ } }); });
      server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
        if (url.pathname !== "/ws" || !tokenValid(options.token, tokenFromRequest(request, url))) { socket.destroy(); return; }
        wss.handleUpgrade(request, socket, head, (ws) => {
          options.bus.add(ws);
          ws.on("close", () => options.bus.remove(ws));
          ws.on("error", () => options.bus.remove(ws));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(options.port, host, () => { server!.off("error", reject); resolve(); });
      });
      // Poll the dashboard/registry and push a `sessions` event when the summary changes.
      poll = setInterval(() => {
        try {
          const snapshot = JSON.stringify(listSessions(options.reads));
          if (snapshot !== lastSessions) { lastSessions = snapshot; options.bus.broadcast({ type: "sessions", sessions: JSON.parse(snapshot), at: Date.now() }); }
        } catch (error) { options.report({ level: "warn", code: "background_task_failed", component: "web_ui", reason: error instanceof Error ? error.message : String(error) }); }
      }, POLL_MS);
      poll.unref?.();
      // Expire uploaded files past their TTL: once now, then periodically.
      if (options.uploads) {
        const sweep = () => void cleanupUploads(options.uploads!, Date.now()).catch(() => {});
        sweep();
        uploadSweep = setInterval(sweep, 6 * 60 * 60 * 1000);
        uploadSweep.unref?.();
      }
      const address = server!.address();
      const boundPort = typeof address === "object" && address ? address.port : options.port;
      // Loud warning: a non-loopback bind exposes a danger-full-access surface on the LAN over
      // plain HTTP — the access token travels in cleartext (URL + cookie) and grants a full shell.
      if (host !== "127.0.0.1") {
        options.report({ level: "warn", code: "web_ui_lan_exposure", component: "web_ui", reason: `bound ${host}:${boundPort} — full-access UI reachable on the LAN over plain HTTP` });
        process.stderr.write(`\n*** SECURITY WARNING: QiYan web UI is bound to ${host}:${boundPort} (NOT loopback). This is a danger-full-access surface over plain HTTP; the access token is sniffable on the network. Prefer WEB_HOST=127.0.0.1 + an SSH tunnel. ***\n\n`);
      }
      return { url: `http://${host}:${boundPort}/?token=${options.token}` };
    },
    async stop() {
      if (poll) clearInterval(poll);
      if (uploadSweep) clearInterval(uploadSweep);
      for (const ws of wss.clients) { try { ws.close(); } catch { /* closing */ } }
      wss.close();
      await new Promise<void>((resolve) => { if (!server) { resolve(); return; } server.close(() => resolve()); });
    },
  };
}

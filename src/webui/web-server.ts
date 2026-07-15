import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { WebSocketServer } from "ws";
import type { OperationalEvent } from "../core/operational-log.ts";
import type { WebBus } from "./web-bus.ts";
import { assistantTranscript, listSessions, transcript, type WebReadsDeps } from "./web-reads.ts";
import { browse, confine, createEntry, resolvePath, type FileTarget, type WebFilesDeps } from "./web-files.ts";
import { cleanupUploads, storeUpload, type WebUploadsConfig } from "./web-uploads.ts";
import { runCommand } from "./web-exec.ts";
import { discoverRepos, gitCommit, gitDiff, gitStage, gitStatus, gitUnstage } from "./web-git.ts";
import { remoteBrowse, remoteDiscover, remoteGitCommit, remoteGitDiff, remoteGitStage, remoteGitStatus, remoteGitUnstage, remoteReadStream, type RemoteDeps } from "./web-remote.ts";

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

// Stream a resolved file with a best-effort Content-Type so the browser can render/read it inline
// (or download it, when `download` is set).
async function serveRaw(response: ServerResponse, target: string | undefined, download = false): Promise<void> {
  const info = target ? await stat(target).catch(() => undefined) : undefined;
  if (!target || !info?.isFile()) { response.writeHead(404, { "content-type": "text/plain" }); response.end("not found"); return; }
  const contentType = RAW_CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
  // Strip CR/LF (header injection) as well as quotes/backslash — a preview may now open any path, so a
  // file whose name contains a newline must not reach writeHead (Node throws ERR_INVALID_CHAR). Matches
  // serveRemoteRaw's sanitizer.
  const disposition = download ? `attachment; filename="${(target.split("/").pop() || "download").replace(/[\r\n"\\]/g, "_")}"` : "inline";
  const headers: Record<string, string> = {
    "content-type": contentType, "content-length": String(info.size),
    "content-disposition": disposition, "x-content-type-options": "nosniff",
  };
  // Neuter scripts/callbacks in previewed HTML/SVG opened as a document (unique, isolated origin).
  if (contentType.startsWith("text/html") || contentType === "image/svg+xml") headers["content-security-policy"] = "sandbox";
  response.writeHead(200, headers);
  createReadStream(target).pipe(response);
}

const MAX_REMOTE_STREAM = 64 * 1024 * 1024;
// Stream a remote file (ssh) to the HTTP response with backpressure; kill the ssh child on client
// disconnect (which SIGPIPEs the remote `cat`), cap the bytes, and 404 if the confinement guard fails.
// All response writes happen inside child/stream event listeners, so they're guarded (headersSent +
// try/catch) — an uncaught throw here would crash the whole process (handle().catch can't reach it).
async function serveRemoteRaw(response: ServerResponse, remote: RemoteDeps, host: string, root: string, path: string, download: boolean): Promise<void> {
  const child = await remoteReadStream(remote, host, root, path);
  const contentType = RAW_CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  let started = false, finished = false, size = 0;
  const killChild = (): void => { try { child.kill("SIGKILL"); } catch { /* gone */ } };
  const safeHead = (status: number, headers: Record<string, string>): boolean => {
    if (response.headersSent) return false;
    try { response.writeHead(status, headers); return true; } catch { return false; }
  };
  const finish = (body?: string): void => { if (finished) return; finished = true; try { response.end(body); } catch { /* already ended */ } };
  response.on("close", killChild);
  child.stdout.on("data", (chunk: Buffer) => {
    if (finished) return;
    if (!started) {
      started = true;
      // Sanitize the download filename — strip CR/LF (header injection) and quotes/backslash.
      const name = (path.split("/").pop() || "download").replace(/[\r\n"\\]/g, "_");
      const headers: Record<string, string> = { "content-type": contentType, "content-disposition": download ? `attachment; filename="${name}"` : "inline", "x-content-type-options": "nosniff" };
      if (contentType.startsWith("text/html") || contentType === "image/svg+xml") headers["content-security-policy"] = "sandbox";
      if (!safeHead(200, headers)) { killChild(); finish(); return; }
    }
    size += chunk.length;
    if (size > MAX_REMOTE_STREAM) { killChild(); finish(); return; }
    if (!response.write(chunk)) { child.stdout.pause(); response.once("drain", () => child.stdout.resume()); }
  });
  child.on("close", (code) => {
    if (finished || started) { finish(); return; }
    if (code === 0) { safeHead(200, { "content-type": contentType }); finish(); }        // empty file
    else { finish(safeHead(404, { "content-type": "text/plain" }) ? "not found" : undefined); } // guard fail / ssh down
  });
  child.on("error", () => { if (finished) return; if (!started) safeHead(502, { "content-type": "text/plain" }); finish(); });
}
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png",
};

export interface WebServerOptions {
  host: string;
  port: number;
  token: string;
  staticDir: string;
  bus: WebBus;
  reads: WebReadsDeps;
  files: WebFilesDeps;
  uploads?: WebUploadsConfig;
  // ssh access for remote-worker files (reuses the user's ControlMaster). A PROVIDER, not a value: the
  // ssh runtime root is only known after startup, so it must be resolved per request, not at wiring time.
  remote?: () => RemoteDeps | undefined;
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

// Read a small JSON request body (capped); undefined on invalid JSON or overflow.
async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let raw = "";
  for await (const chunk of request) { raw += chunk; if (raw.length > 256 * 1024) return undefined; }
  try { return raw ? JSON.parse(raw) : {}; } catch { return undefined; }
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
  const host = options.host; // WEB_HOST/--host directly; a non-loopback bind prints the warning below
  // Recreated on each start() (and closed+cleared on stop()) so the handle is re-startable for the
  // manual web-UI toggle — a closed ws.Server rejects later handleUpgrade calls.
  let wss: WebSocketServer | undefined;
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
    const remote = options.remote?.(); // resolved per request (available after startup)

    if (request.method === "GET" && url.pathname === "/api/sessions") { json(response, 200, { sessions: listSessions(options.reads) }); return; }
    if (request.method === "GET" && url.pathname === "/api/assistant/messages") {
      const { limit, before } = pageParams(url);
      json(response, 200, assistantTranscript(options.reads, limit, before));
      return;
    }
    const messages = /^\/api\/sessions\/([a-z0-9][a-z0-9_-]{0,63})\/messages$/u.exec(url.pathname);
    if (request.method === "GET" && messages) {
      const { limit, before } = pageParams(url);
      const result = await transcript(options.reads, messages[1]!, limit, before);
      if (!result) { json(response, 404, { error: "unknown session" }); return; }
      json(response, 200, result);
      return;
    }
    // File tree, confined to the session's project — local via fs, remote via ssh.
    const files = /^\/api\/files\/([a-z0-9][a-z0-9_-]{0,63})$/u.exec(url.pathname);
    if (request.method === "GET" && files) {
      const target = options.files.fileTarget(files[1]!);
      const path = url.searchParams.get("path") ?? "";
      if (!target) { json(response, 404, { error: "unknown session" }); return; }
      const result = target.transport === "remote" && target.host && remote
        ? await remoteBrowse(remote, target.host, target.projectDir, path)
        : await browse(options.files, files[1]!, path);
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
    // Unified streaming for any mentioned/browsed file. This owner-only preview opens ANY file the user
    // can read (a worker legitimately references files outside its project dir); an absolute path is
    // used as-is, a relative one resolves under ?session=’s project — local via fs, remote via ssh. The
    // client streams text into the panel, uses it as an <img> src, or opens pdf/html in a new tab.
    if (request.method === "GET" && url.pathname === "/api/raw") {
      const session = url.searchParams.get("session") || undefined;
      const path = url.searchParams.get("path") ?? "";
      const download = url.searchParams.get("download") === "1";
      const target = session ? options.files.fileTarget(session) : undefined;
      if (target?.transport === "remote" && target.host && remote) {
        await serveRemoteRaw(response, remote, target.host, target.projectDir, path, download);
        return;
      }
      const local = resolvePath(session ? options.files.projectDir(session) : undefined, path);
      await serveRaw(response, local, download);
      return;
    }
    // Create a file/folder in a session's project (tree write ops).
    if (request.method === "POST" && url.pathname === "/api/fs") {
      const body = await readJson(request);
      if (!body) { json(response, 400, { error: "invalid json" }); return; }
      const { op, session, path } = body as { op?: string; session?: string; path?: string };
      if ((op !== "mkfile" && op !== "mkdir") || typeof session !== "string" || typeof path !== "string" || !path) { json(response, 400, { error: "op, session, path required" }); return; }
      json(response, 200, await createEntry(options.files, session, path, op === "mkdir" ? "dir" : "file"));
      return;
    }
    // Run a one-shot shell command in a LOCAL session's project dir (the `!` command).
    if (request.method === "POST" && url.pathname === "/api/exec") {
      const body = await readJson(request);
      if (!body) { json(response, 400, { error: "invalid json" }); return; }
      const { session, command } = body as { session?: string; command?: string };
      const cwd = typeof session === "string" ? options.files.projectDir(session) : undefined;
      if (!cwd) { json(response, 400, { error: "not a local session" }); return; }
      if (typeof command !== "string" || !command.trim()) { json(response, 400, { error: "command required" }); return; }
      json(response, 200, await runCommand(cwd, command, { maxBytes: 256 * 1024, timeoutMs: 30_000 }));
      return;
    }
    // Git source control. Repos are tracked MANUALLY by the client (a worker's cwd may not be a repo,
    // or may hold several in subdirs), so ops take a `repo` sub-path confined to the session's project.
    // Local: git in a `confine()`d dir. Remote: git over ssh, confined on the remote (web-remote.ts).
    const gitTarget = (session: unknown): FileTarget | undefined => (typeof session === "string" ? options.files.fileTarget(session) : undefined);
    const withLocalRepo = async <T>(t: FileTarget, repo: string, fn: (dir: string) => Promise<T>): Promise<T | { error: string }> => {
      const dir = await confine(t.projectDir, repo || ".");
      return dir ? fn(dir) : { error: "repo not found" };
    };
    if (request.method === "GET" && url.pathname === "/api/git/discover") {
      const t = gitTarget(url.searchParams.get("session"));
      const repos = !t ? [] : t.transport === "remote" && t.host && remote ? await remoteDiscover(remote, t.host, t.projectDir) : await discoverRepos(t.projectDir);
      json(response, 200, { repos });
      return;
    }
    if (request.method === "GET" && (url.pathname === "/api/git/status" || url.pathname === "/api/git/diff")) {
      const t = gitTarget(url.searchParams.get("session"));
      if (!t) { json(response, 400, { error: "repo not found" }); return; }
      const repo = url.searchParams.get("repo") ?? "";
      const gitRemote = t.transport === "remote" && t.host && remote ? remote : undefined;
      if (url.pathname === "/api/git/status") {
        const result = gitRemote ? await remoteGitStatus(gitRemote, t.host!, t.projectDir, repo) : await withLocalRepo(t, repo, (dir) => gitStatus(dir));
        json(response, "error" in result ? 400 : 200, result);
        return;
      }
      const path = url.searchParams.get("path") ?? "", staged = url.searchParams.get("staged") === "1";
      const result = gitRemote ? await remoteGitDiff(gitRemote, t.host!, t.projectDir, repo, path, staged) : await withLocalRepo(t, repo, (dir) => gitDiff(dir, path, staged));
      json(response, "error" in result ? 400 : 200, result);
      return;
    }
    const gitOp = /^\/api\/git\/(stage|unstage|commit)$/u.exec(url.pathname);
    if (request.method === "POST" && gitOp) {
      const body = await readJson(request);
      if (!body) { json(response, 400, { error: "invalid json" }); return; }
      const t = gitTarget(body.session);
      if (!t) { json(response, 400, { error: "repo not found" }); return; }
      const repo = typeof body.repo === "string" ? body.repo : "";
      const gitRemote = t.transport === "remote" && t.host && remote ? remote : undefined;
      const op = gitOp[1];
      const path = typeof body.path === "string" ? body.path : "";
      const message = typeof body.message === "string" ? body.message : "";
      const result = op === "commit"
        ? (gitRemote ? await remoteGitCommit(gitRemote, t.host!, t.projectDir, repo, message) : await withLocalRepo(t, repo, (dir) => gitCommit(dir, message)))
        : !path ? { error: "path required" }
          : gitRemote ? await (op === "stage" ? remoteGitStage : remoteGitUnstage)(gitRemote, t.host!, t.projectDir, repo, path)
            : await withLocalRepo(t, repo, (dir) => (op === "stage" ? gitStage : gitUnstage)(dir, path));
      json(response, "error" in result ? 400 : 200, result);
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
      wss = new WebSocketServer({ noServer: true });
      lastSessions = ""; // re-broadcast the first poll after a restart
      server = createServer((request, response) => { void handle(request, response).catch(() => { try { response.writeHead(500); response.end("error"); } catch { /* already sent */ } }); });
      server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
        if (url.pathname !== "/ws" || !wss || !tokenValid(options.token, tokenFromRequest(request, url))) { socket.destroy(); return; }
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
      if (wss) { for (const ws of wss.clients) { try { ws.close(); } catch { /* closing */ } } wss.close(); wss = undefined; }
      await new Promise<void>((resolve) => {
        if (!server) { resolve(); return; }
        server.close(() => resolve());
        // Force-close lingering HTTP keep-alive sockets (a polling browser) so a `web-ui start --port`
        // rebind or shutdown completes promptly instead of waiting out keepAliveTimeout.
        server.closeAllConnections?.();
      });
    },
  };
}

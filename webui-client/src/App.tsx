import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { STYLES } from "./styles";

const TOKEN = new URLSearchParams(location.search).get("token") ?? "";
const TOKEN_Q = TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : "";
const IMG_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i; // shown inline in the preview panel
const TAB_EXT = /\.(pdf|html?)$/i;                     // opened in a new tab as a streaming file
// Preserve our internal file-mention scheme (react-markdown strips unknown protocols by default).
const urlTransform = (u: string) => (u.startsWith("qy-file:") ? u : defaultUrlTransform(u));
const ASSIST = " assistant"; // log key for the QiYan tab (selected === null)
const PAGE = 20;             // messages fetched per page
const RENDER_CAP = 30;       // messages rendered initially per tab
const REVEAL_STEP = 20;      // reveal step when scrolling into in-memory history
const TOP_PX = 120, BOTTOM_PX = 80;

interface Session { nickname: string; endpoint: string; provider: string; projectDir: string; lifecycleState: string; nativeStatus: string | null; activeTurnId: string | null; model: string | null; goal: { objective: string; status: string } | null; }
interface Msg { id?: string; body: string; completedAt?: number; terminalStatus?: string; role?: "you" | "assistant"; at?: number; }
type FileResult = { kind: "dir"; path: string; entries: Array<{ name: string; type: "dir" | "file" | "other" }> } | { kind: "file"; path: string; content: string; truncated: boolean; encoding: string } | { error: string };

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  // Always carry the token (don't rely on the cookie, which can be stale) and tolerate non-JSON error
  // bodies like "unauthorized" so a 401 surfaces a readable message instead of a JSON parse crash.
  const url = TOKEN ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(TOKEN)}` : path;
  const r = await fetch(url, { credentials: "same-origin", ...opts });
  const text = await r.text();
  let body: unknown = {};
  try { if (text) body = JSON.parse(text); } catch { if (!r.ok) throw { error: text || r.statusText }; }
  if (!r.ok) throw body;
  return body as T;
}

// LLM output often uses \[..\] / \(..\) for math; remark-math only knows $..$. Convert them to
// $$..$$ / $..$, leaving fenced and inline code untouched.
function normalizeMath(src: string): string {
  return src.split(/(```[\s\S]*?```|`[^`]*`)/g).map((seg, i) => i % 2 === 1 ? seg
    : seg.replace(/\\\[([\s\S]*?)\\\]/g, (_m, x) => `$$${x}$$`).replace(/\\\(([\s\S]*?)\\\)/g, (_m, x) => `$${x}$`)).join("");
}

// Linkify file-path-like tokens in message text so they open a preview. Paths need a slash or a known
// extension; code/links are skipped. Href scheme "qy-file:<encoded>" is intercepted by the <a> renderer.
// Bounded quantifiers ({1,64} segments, {1,16} depth) keep this linear — an unbounded `+` here
// backtracks O(n²) on long unbroken tokens (base64/hashes) and can freeze the tab.
const PATH_RE = /((?:\.{0,2}\/)?(?:[A-Za-z0-9._-]{1,64}\/){1,16}[A-Za-z0-9._-]{1,64}(?:\.[A-Za-z0-9]{1,8})?|[A-Za-z0-9._-]{1,64}\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|py|rs|go|c|h|cc|cpp|hpp|css|scss|html|yaml|yml|toml|ini|cfg|sh|sql|log|env|pdf|png|jpg|jpeg|gif|csv|zip|docx|xlsx))(:\d+(?::\d+)?)?/g;
const SKIP = new Set(["code", "inlineCode", "link", "linkReference", "image"]);
const MAX_LINKIFY = 20_000; // don't scan very long text nodes for paths (belt-and-suspenders vs ReDoS)
function remarkFilePaths() {
  const walk = (node: any) => {
    if (!node.children) return;
    const out: any[] = [];
    for (const child of node.children) {
      if (child.type === "text" && !SKIP.has(node.type) && child.value.length <= MAX_LINKIFY) {
        let last = 0; let m: RegExpExecArray | null; PATH_RE.lastIndex = 0;
        while ((m = PATH_RE.exec(child.value))) {
          if (m.index > last) out.push({ type: "text", value: child.value.slice(last, m.index) });
          out.push({ type: "link", url: "qy-file:" + encodeURIComponent(m[0]), children: [{ type: "text", value: m[0] }] });
          last = m.index + m[0].length;
        }
        if (last === 0) { out.push(child); } else { if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) }); }
      } else { walk(child); out.push(child); }
    }
    node.children = out;
  };
  return (tree: any) => walk(tree);
}

const when = (m: Msg) => m.completedAt ?? m.at ?? 0;
const STATUS_CLASS = (s: Session | null) => (!s ? "other" : s.nativeStatus === "idle" ? "idle" : s.nativeStatus ? "busy" : "other");

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // null = QiYan
  const [theme, setTheme] = useState<"dark" | "light">(() => (localStorage.getItem("qiyan-theme") as "dark" | "light") || "dark");
  const [log, setLog] = useState<Record<string, Msg[]>>({}); // your sent echoes + live replies, keyed by tab
  const [history, setHistory] = useState<Msg[]>([]); // QiYan's loaded conversation page(s), oldest→newest
  const [finals, setFinals] = useState<Msg[]>([]);   // the selected worker's loaded page(s)
  const [hasOlder, setHasOlder] = useState<Record<string, boolean>>({});
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [visible, setVisible] = useState(RENDER_CAP);
  const [live, setLive] = useState(false);
  const [text, setText] = useState("");
  const [filePath, setFilePath] = useState("");
  const [file, setFile] = useState<FileResult | null>(null);
  const [image, setImage] = useState<{ url: string; name: string } | null>(null);
  const [tree, setTree] = useState<FileResult | null>(null);
  const [suggest, setSuggest] = useState<string[]>([]);
  const [sugIdx, setSugIdx] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const preserveRef = useRef<number | null>(null); // scrollHeight snapshot to keep position on prepend
  const stickRef = useRef(true);                   // whether to stay pinned to the bottom
  const key = selected ?? ASSIST;
  const selectedRef = useRef(selected); selectedRef.current = selected; // for the WS handler's stale closure
  const push = (k: string, m: Msg) => setLog((prev) => ({ ...prev, [k]: [...(prev[k] ?? []), m] }));

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("qiyan-theme", theme); }, [theme]);

  const loadSessions = useCallback(async () => { try { setSessions((await api<{ sessions: Session[] }>("/api/sessions")).sessions); } catch { /* transient */ } }, []);
  const loadHistory = useCallback(async () => {
    try { const p = await api<{ messages: Msg[]; hasOlder: boolean }>(`/api/assistant/messages?limit=${PAGE}`); setHistory(p.messages); setHasOlder((h) => ({ ...h, [ASSIST]: p.hasOlder })); }
    catch { /* transient */ }
  }, []);
  const loadFinals = useCallback(async (nickname: string) => {
    try { const p = await api<{ messages: Msg[]; hasOlder: boolean }>(`/api/sessions/${nickname}/messages?limit=${PAGE}`); setFinals(p.messages); setHasOlder((h) => ({ ...h, [nickname]: p.hasOlder })); }
    catch (e) { setFinals([{ body: `Error: ${(e as { error?: string }).error ?? e}`, completedAt: 0 }]); }
  }, []);
  const loadTree = useCallback(async (nickname: string, path: string) => {
    try { setTree(await api<FileResult>(`/api/files/${nickname}?path=${encodeURIComponent(path)}`)); }
    catch (e) { setTree({ error: (e as { error?: string }).error ?? "unavailable" }); }
  }, []);

  useEffect(() => { void loadSessions(); }, [loadSessions]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);
  useEffect(() => { // WebSocket live updates
    let ws: WebSocket, stop = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
      ws.onopen = () => setLive(true);
      ws.onclose = () => { setLive(false); if (!stop) setTimeout(connect, 2000); };
      ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "sessions") setSessions(m.sessions);
        else if (m.type === "message") { push(ASSIST, { role: "assistant", body: m.body, at: m.at }); if (selectedRef.current === null && !stickRef.current) setVisible((v) => v + 1); } }; // grow the window (only while viewing QiYan) so a live append while scrolled up doesn't slide/jump
    };
    connect();
    return () => { stop = true; try { ws.close(); } catch { /* closing */ } };
  }, []);

  // On tab switch: reset the render window, pin to bottom, and lazily load that tab's latest page.
  useEffect(() => { setVisible(RENDER_CAP); stickRef.current = true; preserveRef.current = null; if (selected) { setFinals([]); void loadFinals(selected); setFilePath(""); } }, [selected, loadFinals]);
  useEffect(() => { if (selected) void loadTree(selected, filePath); }, [selected, filePath, loadTree]);
  // When a worker turn completes and you're pinned to the bottom, refresh to the latest page.
  useEffect(() => { const s = sessions.find((x) => x.nickname === selected); if (s && !s.activeTurnId && selected && stickRef.current) void loadFinals(selected); }, [sessions]); // eslint-disable-line

  // The visible conversation: QiYan = loaded history + session activity; worker = its finals + your
  // echoes. Blank bodies are hidden here (kept in the loaded pages so the `before` cursor stays valid).
  const shown: Msg[] = useMemo(() => {
    const base = selected === null ? [...history, ...(log[ASSIST] ?? [])] : [...finals, ...(log[selected] ?? [])].sort((a, b) => when(a) - when(b));
    return base.filter((m) => m.body.trim());
  }, [selected, finals, log, history]);
  const rendered = shown.slice(Math.max(0, shown.length - visible));

  // Keep scroll position when prepending older messages; otherwise stay pinned to the bottom.
  useLayoutEffect(() => {
    const el = logRef.current; if (!el) return;
    if (preserveRef.current !== null) { el.scrollTop += el.scrollHeight - preserveRef.current; preserveRef.current = null; }
    else if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [rendered.length, selected]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder) return;
    const el = logRef.current;
    const cursor = selected === null ? history[0]?.at : finals[0]?.completedAt;
    if (cursor === undefined) return;
    setLoadingOlder(true);
    if (el) preserveRef.current = el.scrollHeight;
    try {
      const path = selected === null ? `/api/assistant/messages?limit=${PAGE}&before=${cursor}` : `/api/sessions/${selected}/messages?limit=${PAGE}&before=${cursor}`;
      const p = await api<{ messages: Msg[]; hasOlder: boolean }>(path);
      // The `before` cursor is INCLUSIVE, so dedup the boundary rows we already have (by id).
      const existing = new Set((selected === null ? history : finals).map((m) => m.id).filter(Boolean));
      const fresh = p.messages.filter((m) => !m.id || !existing.has(m.id));
      if (fresh.length) {
        if (selected === null) setHistory((cur) => [...fresh, ...cur]); else setFinals((cur) => [...fresh, ...cur]);
        setVisible((v) => v + fresh.length);
      } else preserveRef.current = null;
      // Stop paging if the server has no more OR this fetch made no progress (avoids re-fetching the
      // same boundary page forever when >limit rows share one millisecond).
      setHasOlder((h) => ({ ...h, [key]: p.hasOlder && fresh.length > 0 }));
    } catch { preserveRef.current = null; } finally { setLoadingOlder(false); }
  }, [loadingOlder, selected, history, finals, key]);

  const onScroll = () => {
    const el = logRef.current; if (!el) return;
    stickRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_PX;
    if (el.scrollTop <= TOP_PX) {
      if (visible < shown.length) { preserveRef.current = el.scrollHeight; setVisible((v) => Math.min(v + REVEAL_STEP, shown.length)); }
      else if (hasOlder[key] && !loadingOlder) void loadOlder();
    }
  };

  const onText = (v: string) => {
    setText(v); setSugIdx(0);
    const at = /(?:^|\s)@([a-z0-9_-]*)$/i.exec(v);
    setSuggest(at ? sessions.map((s) => s.nickname).filter((n) => n.startsWith(at[1].toLowerCase())).slice(0, 6) : []);
  };
  const pickSuggest = (nick: string) => { setText((t) => t.replace(/@[a-z0-9_-]*$/i, `@${nick} `)); setSuggest([]); };

  const send = async () => {
    const t = text.trim(); if (!t) return;
    const m = /^@([a-z0-9][a-z0-9_-]*)\s+([\s\S]+)$/.exec(t);
    const redirect = m && sessions.some((s) => s.nickname === m[1]) ? m[1] : null;
    const target = redirect ?? selected ?? undefined;
    const body = redirect ? m![2] : t;
    setText(""); setSuggest([]); stickRef.current = true;
    push(key, { role: "you", body: redirect && redirect !== selected ? `→ @${redirect}  ${body}` : body, at: Date.now() });
    try { const r = await api<{ ok: boolean; error?: string }>("/api/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: body, target }) });
      if (!r.ok) push(key, { role: "assistant", body: `[send failed: ${r.error ?? ""}]`, at: Date.now() }); }
    catch (e) { push(key, { role: "assistant", body: `[send error: ${(e as { error?: string }).error ?? e}]`, at: Date.now() }); }
    if (target) setTimeout(() => { if (selected === target) void loadFinals(target); }, 900);
  };

  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  // Send a file: the backend stores it and returns its path, which we append to the composer so the
  // assistant/worker reads it by path (no download needed — the path is clickable to preview).
  const uploadFile = async (f: File) => {
    setUploading(true);
    try {
      const r = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}${TOKEN_Q}`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: f });
      const b = await r.json();
      if (r.ok && b.path) setText((t) => (t ? t.replace(/\s*$/, " ") : "") + b.path + " ");
      else push(key, { role: "assistant", body: `[upload failed: ${b.error ?? r.status}]`, at: Date.now() });
    } catch { push(key, { role: "assistant", body: "[upload error]", at: Date.now() }); } finally { setUploading(false); }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (suggest.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSugIdx((i) => (i + 1) % suggest.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSugIdx((i) => (i - 1 + suggest.length) % suggest.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickSuggest(suggest[sugIdx]); return; }
      if (e.key === "Escape") { e.preventDefault(); setSuggest([]); return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
  };

  const selSession = useMemo(() => sessions.find((s) => s.nickname === selected) ?? null, [sessions, selected]);
  const crumbs = filePath ? filePath.split("/") : [];
  const openFileAt = (nickname: string, relPath: string) =>
    void api<FileResult>(`/api/files/${nickname}?path=${encodeURIComponent(relPath)}`).then(setFile).catch(() => setFile({ error: "unavailable" }));

  const openUpload = (absPath: string) =>
    void api<FileResult>(`/api/upload/preview?path=${encodeURIComponent(absPath)}`).then(setFile).catch(() => setFile({ error: "unavailable" }));

  const closePreview = () => { setFile(null); setImage(null); };

  // Open a mentioned path (like Codex-Web-UI): images show inline in the popup panel, pdf/html stream
  // in a new tab, and text opens in the panel. Absolute paths under the worker's project resolve
  // there; other absolute paths from the upload store; relative paths from the selected worker.
  const openMentioned = (mention: string) => {
    const decoded = decodeURIComponent(mention.replace(/^qy-file:/, "")).replace(/:\d+(?::\d+)?$/, "").replace(/^\.\//, "");
    const proj = selSession?.projectDir;
    const inProject = Boolean(selected && proj && decoded.startsWith(proj + "/"));
    const isUpload = decoded.startsWith("/") && !inProject;
    const rel = inProject ? decoded.slice(proj!.length + 1) : decoded;
    if (!isUpload && !selected) return; // a relative/project path needs a worker
    const rawUrl = isUpload
      ? `/api/upload/raw?path=${encodeURIComponent(decoded)}${TOKEN_Q}`
      : `/api/files/${selected}/raw?path=${encodeURIComponent(rel)}${TOKEN_Q}`;
    if (IMG_EXT.test(decoded)) { setImage({ url: rawUrl, name: decoded.split("/").pop() || decoded }); return; }
    if (TAB_EXT.test(decoded)) { window.open(rawUrl, "_blank", "noopener"); return; }
    if (isUpload) openUpload(decoded); else openFileAt(selected!, rel);
  };

  const remark = [remarkGfm, remarkMath, remarkFilePaths];
  const mdComponents = { a: (props: any) => typeof props.href === "string" && props.href.startsWith("qy-file:")
    ? <button className="file-link" onClick={() => openMentioned(props.href)}>{props.children}</button>
    : <a {...props} target="_blank" rel="noreferrer" /> };

  return (
    <div className="app">
      <style>{STYLES}</style>
      <header className="topbar">
        <div className="brand">QiYan</div>
        <nav className="tabs">
          <button className={`tab ${selected === null ? "on" : ""}`} onClick={() => setSelected(null)}><span className="dot other" />QiYan</button>
          {sessions.map((s) => (
            <button key={s.nickname} className={`tab ${selected === s.nickname ? "on" : ""}`} onClick={() => setSelected(s.nickname)} title={`${s.provider} · ${s.nativeStatus ?? "?"}${s.goal ? " · goal:" + s.goal.status : ""}`}>
              <span className={`dot ${STATUS_CLASS(s)}`} />{s.nickname}
            </button>
          ))}
        </nav>
        <div className="right">
          <span className={`live ${live ? "on" : ""}`}>{live ? "live" : "offline"}</span>
          <button className="ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "☀" : "☾"}</button>
        </div>
      </header>

      <div className="body">
        <aside className="files">
          <div className="files-head"><span>{selected ? `Files · ${selected}` : "Files"}</span>
            {selected && <button className="ghost sm" title="Refresh (no live watcher)" onClick={() => { void loadTree(selected, filePath); void loadSessions(); }}>⟳</button>}
          </div>
          {selected === null ? <div className="hint">Select a worker to browse its project files.</div> : (
            <div className="tree">
              <div className="crumbs">
                <a onClick={() => setFilePath("")}>{selSession?.projectDir?.split("/").pop() || selected}</a>
                {crumbs.map((p, i) => <span key={i}> / <a onClick={() => setFilePath(crumbs.slice(0, i + 1).join("/"))}>{p}</a></span>)}
              </div>
              {tree && "error" in tree && <div className="hint">{tree.error === "unknown session" ? "Not browsable — a remote worker's files live on another host (deferred)." : tree.error}</div>}
              {tree && "kind" in tree && tree.kind === "dir" && (tree.entries.length ? tree.entries.map((e) => (
                <div key={e.name} className={`frow ${e.type}`} onClick={() => e.type === "dir" ? setFilePath((filePath ? filePath + "/" : "") + e.name) : e.type === "file" ? openFileAt(selected, (filePath ? filePath + "/" : "") + e.name) : undefined}>
                  {e.type === "dir" ? "📁" : e.type === "file" ? "📄" : "🔗"} {e.name}
                </div>
              )) : <div className="hint">empty</div>)}
            </div>
          )}
        </aside>

        <main className="chat">
          <div className="log" ref={logRef} onScroll={onScroll}>
            {(hasOlder[key] || visible < shown.length) && <div className="older">{loadingOlder ? "loading…" : "scroll up for older messages"}</div>}
            {shown.length === 0 && <div className="empty">{selected === null ? "Message QiYan — replies appear here." : `Message ${selected} — its replies appear here.`}</div>}
            {rendered.map((m, i) => (
              <div key={m.id ?? `${m.at ?? m.completedAt}-${i}`} className={`msg ${m.role === "you" ? "you" : ""}`}>
                <div className="when">{m.role === "you" ? "you" : m.role === "assistant" ? "QiYan" : `${m.completedAt ? new Date(m.completedAt).toLocaleString() : ""} · ${m.terminalStatus ?? ""}`}</div>
                <div className="md"><Markdown remarkPlugins={remark} rehypePlugins={[rehypeHighlight, rehypeKatex]} components={mdComponents} urlTransform={urlTransform}>{normalizeMath(m.body)}</Markdown></div>
              </div>
            ))}
          </div>
          <div className="composer">
            {suggest.length > 0 && <div className="suggest">{suggest.map((n, i) => <div key={n} className={`srow ${i === sugIdx ? "on" : ""}`} onMouseDown={(e) => { e.preventDefault(); pickSuggest(n); }}>@{n}</div>)}</div>}
            <input ref={fileInput} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = ""; }} />
            <button className="ghost" title="Send a file (its path is appended)" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? "…" : "📎"}</button>
            <textarea value={text} onChange={(e) => onText(e.target.value)} onKeyDown={onKey} rows={2}
              placeholder={selected === null ? "Message QiYan… (@worker to direct-message a worker)" : `Message ${selected}…`} />
            <button onClick={() => void send()}>Send</button>
          </div>
        </main>
      </div>

      {(file || image) && (
        <div className="modal" onClick={closePreview}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head"><span>{image?.name ?? (file && "kind" in file && file.kind === "file" ? file.path : "file")}</span><button className="ghost" onClick={closePreview}>✕</button></div>
            <div className="sheet-body">
              {image ? <img className="preview-img" src={image.url} alt={image.name} />
                : file && "error" in file ? <div className="hint">{file.error}</div>
                : file && file.encoding === "base64" ? <div className="hint">[binary file{file.truncated ? ", truncated" : ""} — not shown]</div>
                : file ? <pre>{file.content}{file.truncated ? "\n… [truncated]" : ""}</pre> : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

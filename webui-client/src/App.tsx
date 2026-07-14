import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import hljs from "highlight.js/lib/common";
import "katex/dist/katex.min.css";
import { STYLES } from "./styles";

const TOKEN = new URLSearchParams(location.search).get("token") ?? "";
const TOKEN_Q = TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : "";
const IMG_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i; // shown inline in the preview panel
const TAB_EXT = /\.(pdf|html?)$/i;                     // opened in a new tab as a streaming file
const MENTION = "#qyfile:"; // a fragment scheme: react-markdown never strips it and it never navigates
// A plain markdown-link href that points at a local file (relative or absolute, no URL scheme) — we
// route these through the preview too, or a bare path would navigate to the SPA fallback (chat page).
const isLocalHref = (h: string) => h.length > 0 && !/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith("//") && !h.startsWith("#") && /[./]/.test(h);
const ASSIST = " assistant"; // log key for the QiYan tab (selected === null)
const PAGE = 20;             // messages fetched per page
const RENDER_CAP = 30;       // messages rendered initially per tab
const REVEAL_STEP = 20;      // reveal step when scrolling into in-memory history
const TOP_PX = 120, BOTTOM_PX = 80;

interface Session { nickname: string; endpoint: string; provider: string; projectDir: string; lifecycleState: string; nativeStatus: string | null; activeTurnId: string | null; model: string | null; goal: { objective: string; status: string } | null; }
interface Msg { id?: string; body: string; completedAt?: number; terminalStatus?: string; role?: "you" | "assistant"; at?: number; }
type FileResult = { kind: "dir"; path: string; entries: Array<{ name: string; type: "dir" | "file" | "other" }> } | { kind: "file"; path: string; content: string; truncated: boolean; encoding: string } | { error: string };
interface GitStatus { branch: string; ahead: number; behind: number; staged: string[]; changes: string[]; untracked: string[] }
type Preview =
  | { kind: "loading"; title: string }
  | { kind: "text"; title: string; text: string; truncated: boolean; lang?: string }
  | { kind: "image"; title: string; url: string }
  | { kind: "error"; title: string; error: string };

// One streaming endpoint resolves any path (absolute → any root; relative → the session's project).
const rawUrl = (path: string, session: string | null) => `/api/raw?path=${encodeURIComponent(path)}&session=${encodeURIComponent(session ?? "")}${TOKEN_Q}`;

// Stream a text file into the panel (capped), instead of preloading it — matches Codex-Web-UI.
async function readTextStream(url: string, cap = 5_000_000): Promise<{ text: string; truncated: boolean }> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw { error: (await r.text().catch(() => "")) || `HTTP ${r.status}` };
  const reader = r.body?.getReader();
  if (!reader) return { text: await r.text(), truncated: false };
  const decoder = new TextDecoder();
  let text = "", size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > cap) { text += decoder.decode(value.subarray(0, cap - size)); void reader.cancel(); return { text, truncated: true }; }
    size += value.length; text += decoder.decode(value, { stream: true });
  }
  return { text, truncated: false };
}

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
// extension; code/links are skipped. The "#qyfile:<encoded>" href is intercepted by the <a> renderer.
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
          out.push({ type: "link", url: MENTION + encodeURIComponent(m[0]), children: [{ type: "text", value: m[0] }] });
          last = m.index + m[0].length;
        }
        if (last === 0) { out.push(child); } else { if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) }); }
      } else { walk(child); out.push(child); }
    }
    node.children = out;
  };
  return (tree: any) => walk(tree);
}

// A code/text file preview: syntax-highlighted (highlight.js) when the extension maps to a known
// language, otherwise plain text. Same highlighter the chat's fenced code blocks use.
function CodeView({ text, title, lang: forced }: { text: string; title: string; lang?: string }) {
  const parts = title.split(".");
  const ext = parts.length > 1 ? parts.pop()!.toLowerCase() : "";
  const lang = forced && hljs.getLanguage(forced) ? forced : ext && hljs.getLanguage(ext) ? ext : "";
  // Uniform structure: <code class="hljs"> gets the theme's block styling either way; hljs escapes source.
  return (
    <pre className="code-view">
      {lang ? <code className="hljs" dangerouslySetInnerHTML={{ __html: hljs.highlight(text, { language: lang, ignoreIllegal: true }).value }} />
        : <code className="hljs">{text}</code>}
    </pre>
  );
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
  const [preview, setPreview] = useState<Preview | null>(null);
  const [srcMode, setSrcMode] = useState(false); // for markdown previews: rendered (false) vs raw source
  const [dirs, setDirs] = useState<Record<string, Array<{ name: string; type: string }> | { error: string }>>({}); // tree: entries by dir path ("" = root)
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filesWidth, setFilesWidth] = useState<number>(() => Number(localStorage.getItem("qiyan-files-w")) || 300);
  const [sidebarTab, setSidebarTab] = useState<"files" | "git">("files");
  const [trackedRepos, setTrackedRepos] = useState<string[]>([]);            // repos tracked for this worker (localStorage)
  const [repoStatus, setRepoStatus] = useState<Record<string, GitStatus | { error: string } | "loading">>({});
  const [discovered, setDiscovered] = useState<string[] | null>(null);       // add-repo picker (null = closed)
  const [commitMsg, setCommitMsg] = useState<Record<string, string>>({});    // per-repo commit message
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
  const loadDir = useCallback(async (nickname: string, path: string) => {
    try { const r = await api<FileResult>(`/api/files/${nickname}?path=${encodeURIComponent(path)}`);
      setDirs((d) => ({ ...d, [path]: "kind" in r && r.kind === "dir" ? r.entries : { error: "not a directory" } })); }
    catch (e) { setDirs((d) => ({ ...d, [path]: { error: (e as { error?: string }).error ?? "unavailable" } })); }
  }, []);
  const toggleDir = (nickname: string, path: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else { next.add(path); if (!dirs[path]) void loadDir(nickname, path); }
    return next;
  });

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

  // On tab switch: reset the render window, pin to bottom, and lazily load the transcript + file root.
  useEffect(() => { setVisible(RENDER_CAP); stickRef.current = true; preserveRef.current = null; if (selected) { setFinals([]); void loadFinals(selected); setDirs({}); setExpanded(new Set()); void loadDir(selected, ""); } }, [selected, loadFinals, loadDir]);
  useEffect(() => {
    if (selected && sidebarTab === "git") {
      const saved = JSON.parse(localStorage.getItem(`qiyan-git:${selected}`) || "[]") as string[];
      setTrackedRepos(saved); setDiscovered(null);
      saved.forEach((r) => loadRepoStatus(selected, r));
    }
  }, [selected, sidebarTab]); // eslint-disable-line  // When a worker turn completes and you're pinned to the bottom, refresh to the latest page.
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
    const at = /(?:^|\s)@([a-z0-9_-]*)$/i.exec(v); // @-autocomplete of worker nicknames
    setSuggest(at ? sessions.map((s) => s.nickname).filter((n) => n.startsWith(at[1].toLowerCase())).slice(0, 6) : []);
  };
  const pickSuggest = (nick: string) => { setText((t) => t.replace(/@[a-z0-9_-]*$/i, `@${nick} `)); setSuggest([]); };

  // `!cmd` in a worker tab runs a one-shot shell command in that worker's project dir; the output is an
  // ephemeral card (not persisted). Only local workers have a cwd.
  const runExec = async (cmd: string) => {
    if (!cmd || !selected) return;
    stickRef.current = true;
    push(selected, { role: "you", body: "$ " + cmd, at: Date.now() });
    try {
      const r = await api<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean; error?: string }>("/api/exec", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: selected, command: cmd }) });
      const out = [r.stdout, r.stderr].filter(Boolean).join("\n") || "(no output)";
      const status = r.error ? `error: ${r.error}` : r.timedOut ? "timed out" : `exit ${r.exitCode}`;
      push(selected, { role: "assistant", body: "```\n" + out + (r.truncated ? "\n… [truncated]" : "") + "\n```\n`" + status + "`", at: Date.now() });
    } catch (e) { push(selected, { role: "assistant", body: `[exec failed: ${(e as { error?: string })?.error ?? e}]`, at: Date.now() }); }
  };

  const send = async () => {
    const t = text.trim(); if (!t) return;
    if (selected && t.startsWith("!")) { setText(""); setSuggest([]); void runExec(t.slice(1).trim()); return; }
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

  // Tree write ops (backend-agnostic quick wins).
  const newEntry = (op: "mkfile" | "mkdir", parent: string) => {
    const name = window.prompt(op === "mkdir" ? "New folder name" : "New file name")?.trim();
    if (!name || !selected) return;
    void api("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, session: selected, path: parent ? `${parent}/${name}` : name }) })
      .then(() => { setExpanded((s) => new Set(s).add(parent)); void loadDir(selected, parent); })
      .catch((e) => alert((e as { error?: string })?.error ?? "create failed"));
  };
  const download = (path: string) => window.open(`${rawUrl(path, selected)}&download=1`, "_blank");
  const insertPath = (path: string) => { const proj = sessions.find((s) => s.nickname === selected)?.projectDir; setText((t) => `${t ? t.replace(/\s*$/, " ") : ""}${proj ? `${proj}/${path}` : path} `); };

  // Recursive file tree: folders expand in place (lazy-loaded); files open the preview popup; hover
  // reveals per-row actions (new file/folder in a dir; download / insert-path for a file).
  const renderDir = (path: string, depth: number): React.ReactNode => {
    const node = dirs[path];
    if (!node) return null;
    if ("error" in node) return <div className="hint" style={{ paddingLeft: 8 + depth * 14 }}>{node.error === "unknown session" ? "Not browsable — a remote worker's files live on another host (deferred)." : node.error}</div>;
    if (!node.length) return <div className="hint" style={{ paddingLeft: 8 + depth * 14 }}>empty</div>;
    return node.map((e) => {
      const full = path ? `${path}/${e.name}` : e.name;
      if (e.type === "dir") {
        const open = expanded.has(full);
        return <div key={full}>
          <div className="frow dir" style={{ paddingLeft: 6 + depth * 14 }} onClick={() => toggleDir(selected!, full)}>
            <span className="tw">{open ? "▾" : "▸"}</span>📁 <span className="fname">{e.name}</span>
            <span className="actions" onClick={(ev) => ev.stopPropagation()}>
              <button title="New file" onClick={() => newEntry("mkfile", full)}>＋📄</button>
              <button title="New folder" onClick={() => newEntry("mkdir", full)}>＋📁</button>
            </span>
          </div>
          {open && renderDir(full, depth + 1)}
        </div>;
      }
      return <div key={full} className={`frow ${e.type}`} style={{ paddingLeft: 24 + depth * 14 }} onClick={() => e.type === "file" ? openPreview(full, selected) : undefined}>
        {e.type === "file" ? "📄" : "🔗"} <span className="fname">{e.name}</span>
        {e.type === "file" && <span className="actions" onClick={(ev) => ev.stopPropagation()}>
          <button title="Download" onClick={() => download(full)}>⬇</button>
          <button title="Insert path into message" onClick={() => insertPath(full)}>↳</button>
        </span>}
      </div>;
    });
  };

  // Drag the divider to resize the file panel (persisted).
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    let w = filesWidth;
    const onMove = (ev: MouseEvent) => { w = Math.max(180, Math.min(720, ev.clientX)); setFilesWidth(w); };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); localStorage.setItem("qiyan-files-w", String(w)); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Git: repos are tracked MANUALLY (added from discovery / persisted per worker), refreshed manually.
  const loadRepoStatus = (session: string, repo: string) => {
    setRepoStatus((s) => ({ ...s, [repo]: "loading" }));
    void api<GitStatus | { error: string }>(`/api/git/status?session=${session}&repo=${encodeURIComponent(repo)}`)
      .then((r) => setRepoStatus((s) => ({ ...s, [repo]: r })))
      .catch((e) => setRepoStatus((s) => ({ ...s, [repo]: { error: (e as { error?: string })?.error ?? "unavailable" } })));
  };
  const saveRepos = (session: string, list: string[]) => { setTrackedRepos(list); localStorage.setItem(`qiyan-git:${session}`, JSON.stringify(list)); };
  const addRepo = (repo: string) => { if (!selected || trackedRepos.includes(repo)) return; saveRepos(selected, [...trackedRepos, repo]); loadRepoStatus(selected, repo); setDiscovered(null); };
  const removeRepo = (repo: string) => { if (!selected) return; saveRepos(selected, trackedRepos.filter((r) => r !== repo)); setRepoStatus((s) => { const n = { ...s }; delete n[repo]; return n; }); };
  const openDiscover = () => { if (!selected) return; void api<{ repos: string[] }>(`/api/git/discover?session=${selected}`).then((r) => setDiscovered(r.repos)).catch(() => setDiscovered([])); };
  const gitAct = async (op: "stage" | "unstage", repo: string, path: string) => {
    if (!selected) return;
    try { await api(`/api/git/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: selected, repo, path }) }); loadRepoStatus(selected, repo); }
    catch (e) { alert((e as { error?: string })?.error ?? "failed"); }
  };
  const commitRepo = async (repo: string) => {
    const msg = commitMsg[repo];
    if (!selected || !msg?.trim()) return;
    try { await api("/api/git/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: selected, repo, message: msg }) }); setCommitMsg((m) => ({ ...m, [repo]: "" })); loadRepoStatus(selected, repo); }
    catch (e) { alert((e as { error?: string })?.error ?? "commit failed"); }
  };
  const openDiff = (repo: string, path: string, staged: boolean) => {
    if (!selected) return;
    setPreview({ kind: "loading", title: `diff · ${path}` });
    void api<{ diff: string }>(`/api/git/diff?session=${selected}&repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}&staged=${staged ? "1" : "0"}`)
      .then((r) => setPreview({ kind: "text", title: `${staged ? "staged " : ""}diff · ${path}`, text: r.diff, truncated: false, lang: "diff" }))
      .catch((e) => setPreview({ kind: "error", title: path, error: (e as { error?: string })?.error ?? "diff failed" }));
  };
  const renderRepo = (repo: string): React.ReactNode => {
    const st = repoStatus[repo];
    const label = repo === "" ? "(workspace root)" : repo;
    const section = (title: string, files: string[], staged: boolean) => files.length ? (
      <div className="gsec" key={title}><div className="gsec-h">{title} · {files.length}</div>
        {files.map((f) => <div key={title + f} className="frow"><span className="fname" title="View diff" onClick={() => openDiff(repo, f, staged)}>{f}</span>
          <span className="actions">{staged ? <button title="Unstage" onClick={() => void gitAct("unstage", repo, f)}>−</button> : <button title="Stage" onClick={() => void gitAct("stage", repo, f)}>＋</button>}</span></div>)}
      </div>) : null;
    const branch = st && typeof st === "object" && "branch" in st ? ` · ${st.branch}${st.ahead ? ` ↑${st.ahead}` : ""}${st.behind ? ` ↓${st.behind}` : ""}` : "";
    return <div className="grepo" key={repo}>
      <div className="grepo-h">
        <span className="fname" title={label}>⎇ {label}{branch}</span>
        <span className="actions"><button title="Refresh" onClick={() => loadRepoStatus(selected!, repo)}>⟳</button><button title="Untrack" onClick={() => removeRepo(repo)}>✕</button></span>
      </div>
      {st === "loading" || st === undefined ? <div className="hint">loading…</div>
        : "error" in st ? <div className="hint">{st.error}</div>
        : <>
          {section("Staged", st.staged, true)}{section("Changes", st.changes, false)}{section("Untracked", st.untracked, false)}
          {!st.staged.length && !st.changes.length && !st.untracked.length && <div className="hint">clean</div>}
          <div className="commit">
            <textarea value={commitMsg[repo] ?? ""} onChange={(e) => setCommitMsg((m) => ({ ...m, [repo]: e.target.value }))} rows={2} placeholder="Commit message (staged)" />
            <button disabled={!st.staged.length || !(commitMsg[repo] ?? "").trim()} onClick={() => void commitRepo(repo)}>Commit · {st.staged.length}</button>
          </div>
        </>}
    </div>;
  };
  const renderGit = (): React.ReactNode => (
    <div className="tree">
      <div className="git-toolbar">
        <button className="ghost sm" onClick={openDiscover}>＋ Add repo</button>
        {trackedRepos.length > 0 && <button className="ghost sm" title="Refresh all" onClick={() => trackedRepos.forEach((r) => loadRepoStatus(selected!, r))}>⟳</button>}
      </div>
      {discovered !== null && <div className="discover">
        {discovered.filter((r) => !trackedRepos.includes(r)).length === 0 ? <div className="hint">{discovered.length ? "all discovered repos are tracked" : "no git repos found under this project"}</div>
          : discovered.filter((r) => !trackedRepos.includes(r)).map((r) => <div key={r} className="frow" onClick={() => addRepo(r)}>＋ {r === "" ? "(workspace root)" : r}</div>)}
        <div className="frow" onClick={() => setDiscovered(null)}>✕ close</div>
      </div>}
      {trackedRepos.length === 0 && discovered === null && <div className="hint">No repos tracked. Use “＋ Add repo” to track a git repo under this worker's project.</div>}
      {trackedRepos.map((r) => renderRepo(r))}
    </div>
  );

  // Open a file in the popup. Text is STREAMED into the panel (not preloaded); images render inline;
  // pdf/html open in a new tab. The server resolves the path (any root for absolute, ?session=’s
  // project for relative), so the client never guesses which root a path lives in.
  const openPreview = (path: string, session: string | null) => {
    setSrcMode(false); // default markdown to the rendered view
    const url = rawUrl(path, session);
    if (IMG_EXT.test(path)) { setPreview({ kind: "image", title: path, url }); return; }
    if (TAB_EXT.test(path)) { window.open(url, "_blank", "noopener"); return; }
    setPreview({ kind: "loading", title: path });
    void readTextStream(url).then(({ text, truncated }) => setPreview({ kind: "text", title: path, text, truncated }))
      .catch((e) => setPreview({ kind: "error", title: path, error: (e as { error?: string })?.error ?? "unavailable" }));
  };
  const openMentioned = (mention: string) =>
    openPreview(decodeURIComponent(mention.replace(MENTION, "")).replace(/:\d+(?::\d+)?$/, "").replace(/^\.\//, ""), selected);

  const remark = [remarkGfm, remarkMath, remarkFilePaths];
  const mdComponents = { a: (props: any) => {
    const href = typeof props.href === "string" ? props.href : "";
    if (href.startsWith(MENTION)) return <button className="file-link" onClick={() => openMentioned(href)}>{props.children}</button>;
    // A plain markdown link to a local file → open the preview, not navigate to the SPA fallback.
    if (isLocalHref(href)) return <button className="file-link" onClick={() => openMentioned(MENTION + encodeURIComponent(href))}>{props.children}</button>;
    return <a {...props} target="_blank" rel="noreferrer" />;
  } };

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
        <aside className="files" style={{ width: filesWidth }}>
          <div className="files-head">
            <span className="tabs2">
              <button className={sidebarTab === "files" ? "on" : ""} onClick={() => setSidebarTab("files")}>Files</button>
              <button className={sidebarTab === "git" ? "on" : ""} onClick={() => setSidebarTab("git")}>Git</button>
            </span>
            {selected && sidebarTab === "files" && <span className="head-actions">
              <button className="ghost sm" title="New file at root" onClick={() => newEntry("mkfile", "")}>＋📄</button>
              <button className="ghost sm" title="New folder at root" onClick={() => newEntry("mkdir", "")}>＋📁</button>
              <button className="ghost sm" title="Refresh (no live watcher)" onClick={() => { [...new Set(["", ...Object.keys(dirs)])].forEach((p) => void loadDir(selected, p)); void loadSessions(); }}>⟳</button>
            </span>}
          </div>
          {selected === null ? <div className="hint">Select a worker to browse its files / git.</div> : sidebarTab === "files" ? <div className="tree">{renderDir("", 0)}</div> : renderGit()}
        </aside>
        <div className="resizer" onMouseDown={startResize} title="Drag to resize" />

        <main className="chat">
          <div className="log" ref={logRef} onScroll={onScroll}>
            {(hasOlder[key] || visible < shown.length) && <div className="older">{loadingOlder ? "loading…" : "scroll up for older messages"}</div>}
            {shown.length === 0 && <div className="empty">{selected === null ? "Message QiYan — replies appear here." : `Message ${selected} — its replies appear here.`}</div>}
            {rendered.map((m, i) => (
              <div key={m.id ?? `${m.at ?? m.completedAt}-${i}`} className={`msg ${m.role === "you" ? "you" : ""}`}>
                <div className="when">{m.role === "you" ? "you" : m.role === "assistant" ? "QiYan" : `${m.completedAt ? new Date(m.completedAt).toLocaleString() : ""} · ${m.terminalStatus ?? ""}`}</div>
                <div className="md"><Markdown remarkPlugins={remark} rehypePlugins={[rehypeHighlight, rehypeKatex]} components={mdComponents}>{normalizeMath(m.body)}</Markdown></div>
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

      {preview && (() => {
        const isMd = preview.kind === "text" && /\.(md|markdown|mdx)$/i.test(preview.title);
        return (
          <div className="modal" onClick={() => setPreview(null)}>
            <div className="sheet" onClick={(e) => e.stopPropagation()}>
              <div className="sheet-head"><span>{preview.title}</span>
                <div className="head-actions">
                  {isMd && <button className="ghost sm" onClick={() => setSrcMode((s) => !s)}>{srcMode ? "Preview" : "Source"}</button>}
                  <button className="ghost" onClick={() => setPreview(null)}>✕</button>
                </div>
              </div>
              <div className="sheet-body">
                {preview.kind === "image" ? <img className="preview-img" src={preview.url} alt={preview.title} />
                  : preview.kind === "loading" ? <div className="hint">loading…</div>
                  : preview.kind === "error" ? <div className="hint">{preview.error}</div>
                  : isMd && !srcMode ? <div className="md"><Markdown remarkPlugins={remark} rehypePlugins={[rehypeHighlight, rehypeKatex]} components={mdComponents}>{normalizeMath(preview.text)}</Markdown>{preview.truncated ? <div className="hint">… [truncated]</div> : null}</div>
                  : <><CodeView text={preview.text} title={preview.title} lang={preview.lang} />{preview.truncated ? <div className="hint">… [truncated]</div> : null}</>}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import hljs from "highlight.js/lib/common";
import "katex/dist/katex.min.css";
import { formatGoalStatus, selectedWorkerGoal, type WorkerGoal } from "./goal-presentation";
import { STYLES } from "./styles";
import { workerStatus } from "./worker-status";
import {
  acknowledgeWorkerSubscription,
  addOptimisticWorkerMessage,
  applyWorkerSnapshot,
  beginWorkerHistory,
  beginWorkerSubscription,
  dequeueWorkerRecovery,
  drainWorkerRecoveryAfterAttempt,
  failWorkerHistory,
  finishWorkerHistory,
  receiveWorkerEvent,
  requeueWorkerRecovery,
  type WorkerEventEnvelope,
  type WorkerSnapshot,
  type WorkerStreamState,
} from "./worker-chat-stream";

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
const RECOVERY_RETRY_MS = [500, 1_500, 4_000] as const;

interface Session { nickname: string; endpoint: string; provider: string; projectDir: string; lifecycleState: string; nativeStatus: string | null; activeTurnId: string | null; model: string | null; goal: WorkerGoal | null; }
interface Msg { id?: string; body: string; completedAt?: number; terminalStatus?: string; role?: "you" | "assistant" | "worker"; at?: number; origin?: string; phase?: string; streaming?: boolean; turnOrder?: number; itemOrder?: number; }
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
      {lang ? <code className="hljs" dangerouslySetInnerHTML={{ __html: hljs.highlight(text, { language: lang, ignoreIllegals: true }).value }} />
        : <code className="hljs">{text}</code>}
    </pre>
  );
}

const when = (m: Msg) => m.completedAt ?? m.at ?? 0;

export function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selected, setSelected] = useState<string | null>(null); // null = QiYan
  const [theme, setTheme] = useState<"dark" | "light">(() => (localStorage.getItem("qiyan-theme") as "dark" | "light") || "dark");
  const [log, setLog] = useState<Record<string, Msg[]>>({}); // your sent echoes + live replies, keyed by tab
  const [history, setHistory] = useState<Msg[]>([]); // QiYan's loaded conversation page(s), oldest→newest
  const [workerChat, setWorkerChat] = useState<WorkerStreamState | null>(null); // foreground worker only
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
  const goal = selectedWorkerGoal(sessions, selected);
  const selectedRef = useRef(selected); selectedRef.current = selected; // for the WS handler's stale closure
  const sessionsRef = useRef(sessions); sessionsRef.current = sessions;
  const workerRef = useRef<WorkerStreamState | null>(workerChat); workerRef.current = workerChat;
  const wsRef = useRef<WebSocket | null>(null);
  const workerPageLoaderRef = useRef<((nickname: string, subscriptionId: string, snapshotPending: boolean, before?: string, recoveredTurnId?: string) => Promise<void>) | null>(null);
  const recoveryRetriesRef = useRef(new Map<string, { attempt: number; timer: number }>());
  const push = (k: string, m: Msg) => setLog((prev) => ({ ...prev, [k]: [...(prev[k] ?? []), m] }));
  const replaceWorker = useCallback((next: WorkerStreamState | null) => { workerRef.current = next; setWorkerChat(next); }, []);
  const clearRecoveryRetries = useCallback(() => {
    for (const retry of recoveryRetriesRef.current.values()) window.clearTimeout(retry.timer);
    recoveryRetriesRef.current.clear();
  }, []);
  const scheduleRecoveryRetry = useCallback((nickname: string, subscriptionId: string, turnId: string): boolean => {
    const key = `${subscriptionId}:${turnId}`;
    const previous = recoveryRetriesRef.current.get(key);
    const attempt = previous?.attempt ?? 0;
    if (attempt >= RECOVERY_RETRY_MS.length) {
      recoveryRetriesRef.current.delete(key);
      return false;
    }
    if (previous) window.clearTimeout(previous.timer);
    const timer = window.setTimeout(() => {
      const current = workerRef.current;
      if (!current || current.nickname !== nickname || current.subscriptionId !== subscriptionId
        || current.historyInFlight || !current.pendingRecoveryTurnIds.includes(turnId)) return;
      replaceWorker({ ...current, pendingRecoveryTurnIds: current.pendingRecoveryTurnIds.filter((id) => id !== turnId) });
      void workerPageLoaderRef.current?.(nickname, subscriptionId, true, undefined, turnId);
    }, RECOVERY_RETRY_MS[attempt]);
    recoveryRetriesRef.current.set(key, { attempt: attempt + 1, timer });
    return true;
  }, [replaceWorker]);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("qiyan-theme", theme); }, [theme]);

  const loadSessions = useCallback(async () => { try { setSessions((await api<{ sessions: Session[] }>("/api/sessions")).sessions); } catch { /* transient */ } }, []);
  const loadHistory = useCallback(async () => {
    try { const p = await api<{ messages: Msg[]; hasOlder: boolean }>(`/api/assistant/messages?limit=${PAGE}`); setHistory(p.messages); setHasOlder((h) => ({ ...h, [ASSIST]: p.hasOlder })); }
    catch { /* transient */ }
  }, []);
  const loadWorkerPage = useCallback(async (nickname: string, subscriptionId: string, snapshotPending: boolean, before?: string, recoveredTurnId?: string) => {
    const current = workerRef.current;
    if (!current || current.nickname !== nickname || current.subscriptionId !== subscriptionId) return;
    const started = beginWorkerHistory(current, snapshotPending);
    if (!started.started) return;
    replaceWorker(started.state);
    try {
      const cursor = before === undefined ? "" : `&before=${encodeURIComponent(before)}`;
      const page = await api<WorkerSnapshot>(`/api/sessions/${nickname}/messages?limit=${PAGE}${cursor}&subscriptionId=${encodeURIComponent(subscriptionId)}`);
      const latest = workerRef.current;
      if (!latest || latest.nickname !== nickname || latest.subscriptionId !== subscriptionId) return;
      const merged = applyWorkerSnapshot(latest, page, recoveredTurnId);
      replaceWorker(merged);
      setHasOlder((value) => ({ ...value, [nickname]: merged.hasOlder }));
      if (recoveredTurnId && merged.recoveredTurnIds.includes(recoveredTurnId)) {
        const key = `${subscriptionId}:${recoveredTurnId}`;
        const retry = recoveryRetriesRef.current.get(key);
        if (retry) window.clearTimeout(retry.timer);
        recoveryRetriesRef.current.delete(key);
      }
    } catch (error) {
      const latest = workerRef.current;
      if (latest?.nickname === nickname && latest.subscriptionId === subscriptionId) {
        let failed = latest.snapshotPending ? failWorkerHistory(latest) : finishWorkerHistory(latest);
        if (recoveredTurnId) failed = requeueWorkerRecovery(failed, recoveredTurnId);
        replaceWorker(failed);
        push(nickname, { role: "assistant", body: `Error: ${(error as { error?: string }).error ?? error}`, at: Date.now() });
      }
    } finally {
      const latest = workerRef.current;
      if (!latest || latest.nickname !== nickname || latest.subscriptionId !== subscriptionId) return;
      const retryScheduled = recoveredTurnId !== undefined && latest.pendingRecoveryTurnIds.includes(recoveredTurnId)
        ? scheduleRecoveryRetry(nickname, subscriptionId, recoveredTurnId)
        : false;
      const queued = drainWorkerRecoveryAfterAttempt(latest, recoveredTurnId, retryScheduled);
      if (queued.state !== latest) replaceWorker(queued.state);
      if (queued.turnId) {
        queueMicrotask(() => { void workerPageLoaderRef.current?.(nickname, subscriptionId, true, undefined, queued.turnId); });
      }
    }
  }, [replaceWorker, scheduleRecoveryRetry]);
  workerPageLoaderRef.current = loadWorkerPage;
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

  const subscribeWorker = useCallback((socket: WebSocket | null, nickname: string | null) => {
    clearRecoveryRetries();
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (!nickname) {
      replaceWorker(null);
      socket.send(JSON.stringify({ type: "worker/unsubscribe", requestId: crypto.randomUUID() }));
      return;
    }
    const session = sessionsRef.current.find((candidate) => candidate.nickname === nickname);
    const requestId = crypto.randomUUID();
    const previous = workerRef.current;
    const next = beginWorkerSubscription(nickname, session?.provider ?? "codex", requestId);
    replaceWorker(previous?.nickname === nickname ? { ...next, messages: previous.messages.filter((message) => message.optimistic) } : next);
    socket.send(JSON.stringify({ type: "worker/subscribe", nickname, requestId }));
  }, [clearRecoveryRetries, replaceWorker]);

  useEffect(() => () => clearRecoveryRetries(), [clearRecoveryRetries]);
  useEffect(() => { void loadSessions(); }, [loadSessions]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);
  useEffect(() => { // WebSocket live updates
    let ws: WebSocket, stop = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
      wsRef.current = ws;
      ws.onopen = () => { setLive(true); subscribeWorker(ws, selectedRef.current); };
      ws.onclose = () => { if (wsRef.current === ws) wsRef.current = null; setLive(false); if (!stop) setTimeout(connect, 2000); };
      ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "sessions") setSessions(m.sessions);
        else if (m.type === "message") { push(ASSIST, { role: "assistant", body: m.body, at: m.at }); if (selectedRef.current === null && !stickRef.current) setVisible((v) => v + 1); }
        else if (m.type === "worker/subscribed") {
          const current = workerRef.current;
          if (!current || current.nickname !== m.nickname || current.requestId !== m.requestId || typeof m.subscriptionId !== "string") return;
          const acknowledged = acknowledgeWorkerSubscription(current, m.subscriptionId);
          replaceWorker(acknowledged);
          void workerPageLoaderRef.current?.(m.nickname, m.subscriptionId, true);
        } else if (m.type === "worker/event") {
          const current = workerRef.current;
          if (!current) return;
          const next = receiveWorkerEvent(current, m as WorkerEventEnvelope);
          if (next === current) return;
          replaceWorker(next);
          if (next.overflow) { try { ws.close(1013, "worker stream buffer exceeded"); } catch { /* reconnect repairs */ } return; }
          if (!stickRef.current) setVisible((value) => value + 1);
          const queued = dequeueWorkerRecovery(next);
          if (queued.turnId && queued.state.subscriptionId) {
            replaceWorker(queued.state);
            void workerPageLoaderRef.current?.(queued.state.nickname, queued.state.subscriptionId, true, undefined, queued.turnId);
          }
        } else if (m.type === "worker/subscription-error") {
          const current = workerRef.current;
          if (current && current.requestId === m.requestId) push(current.nickname, { role: "assistant", body: `[worker stream unavailable: ${m.code ?? "error"}]`, at: Date.now() });
        } }; // grow the window while scrolled up so a live append doesn't slide/jump
    };
    connect();
    return () => { stop = true; try { ws.close(); } catch { /* closing */ } };
  }, [replaceWorker, subscribeWorker]);

  // On tab switch: reset the render window, pin to bottom, and lazily load the transcript + file root.
  useEffect(() => {
    setVisible(RENDER_CAP); stickRef.current = true; preserveRef.current = null;
    subscribeWorker(wsRef.current, selected);
    if (selected) { setDirs({}); setExpanded(new Set()); void loadDir(selected, ""); }
  }, [selected, subscribeWorker, loadDir]);
  useEffect(() => {
    if (selected && sidebarTab === "git") {
      const saved = JSON.parse(localStorage.getItem(`qiyan-git:${selected}`) || "[]") as string[];
      setTrackedRepos(saved); setDiscovered(null);
      saved.forEach((r) => loadRepoStatus(selected, r));
    }
  }, [selected, sidebarTab]); // eslint-disable-line

  // The visible conversation: QiYan uses its durable owner history; the worker uses only the
  // foreground subscription's Codex snapshot/live reducer plus ephemeral exec/error cards.
  const shown: Msg[] = useMemo(() => {
    const workerMessages: Msg[] = workerChat?.nickname === selected ? workerChat.messages : [];
    const base = selected === null ? [...history, ...(log[ASSIST] ?? [])] : [...workerMessages, ...(log[selected] ?? [])].sort((a, b) => when(a) - when(b)
      || (a.turnOrder ?? Number.MAX_SAFE_INTEGER) - (b.turnOrder ?? Number.MAX_SAFE_INTEGER)
      || (a.itemOrder ?? Number.MAX_SAFE_INTEGER) - (b.itemOrder ?? Number.MAX_SAFE_INTEGER));
    return base.filter((m) => m.body.trim());
  }, [selected, workerChat, log, history]);
  const rendered = shown.slice(Math.max(0, shown.length - visible));

  // Keep scroll position when prepending older messages; otherwise stay pinned to the bottom.
  useLayoutEffect(() => {
    const el = logRef.current; if (!el) return;
    if (preserveRef.current !== null) { el.scrollTop += el.scrollHeight - preserveRef.current; preserveRef.current = null; }
    else if (stickRef.current) el.scrollTop = el.scrollHeight;
  }, [rendered.length, selected, goal?.objective, goal?.status]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder) return;
    const el = logRef.current;
    const assistantCursor = selected === null ? history[0]?.at : undefined;
    const workerCursor = selected !== null && workerChat?.nickname === selected ? workerChat.olderCursor : undefined;
    if (assistantCursor === undefined && workerCursor === undefined) return;
    setLoadingOlder(true);
    if (el) preserveRef.current = el.scrollHeight;
    try {
      if (selected !== null) {
        const active = workerRef.current;
        if (active?.nickname === selected && active.subscriptionId && workerCursor !== undefined) {
          await loadWorkerPage(selected, active.subscriptionId, false, workerCursor);
          setVisible((value) => value + PAGE);
        }
        return;
      }
      const path = `/api/assistant/messages?limit=${PAGE}&before=${assistantCursor}`;
      const p = await api<{ messages: Msg[]; hasOlder: boolean }>(path);
      // The `before` cursor is INCLUSIVE, so dedup the boundary rows we already have (by id).
      const existing = new Set(history.map((m) => m.id).filter(Boolean));
      const fresh = p.messages.filter((m) => !m.id || !existing.has(m.id));
      if (fresh.length) {
        setHistory((cur) => [...fresh, ...cur]);
        setVisible((v) => v + fresh.length);
      } else preserveRef.current = null;
      // Stop paging if the server has no more OR this fetch made no progress (avoids re-fetching the
      // same boundary page forever when >limit rows share one millisecond).
      setHasOlder((h) => ({ ...h, [key]: p.hasOlder && fresh.length > 0 }));
    } catch { preserveRef.current = null; } finally { setLoadingOlder(false); }
  }, [loadingOlder, selected, history, workerChat, key, loadWorkerPage]);

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
    const clientInputId = target ? crypto.randomUUID() : undefined;
    const active = workerRef.current;
    if (target && target === selected && clientInputId) {
      const session = sessions.find((candidate) => candidate.nickname === target);
      const timeline = active?.nickname === target ? active : beginWorkerSubscription(target, session?.provider ?? "codex", crypto.randomUUID());
      replaceWorker(addOptimisticWorkerMessage(timeline, `to:web:${clientInputId}`, body, Date.now()));
    } else {
      push(key, { role: "you", body: redirect && redirect !== selected ? `→ @${redirect}  ${body}` : body, at: Date.now() });
    }
    try { const r = await api<{ ok: boolean; error?: string; clientUserMessageId?: string }>("/api/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: body, target, ...(clientInputId ? { clientInputId } : {}) }) });
      if (!r.ok) push(key, { role: "assistant", body: `[send failed: ${r.error ?? ""}]`, at: Date.now() }); }
    catch (e) { push(key, { role: "assistant", body: `[send error: ${(e as { error?: string }).error ?? e}]`, at: Date.now() }); }
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
    if ("error" in node) return <div className="hint" style={{ paddingLeft: 8 + depth * 14 }}>{node.error}</div>;
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
  // `session` decides which host a path resolves against: the current worker tab, or (in the QiYan tab)
  // the relayed message's origin worker — so a REMOTE worker's path streams from its host.
  const openMentioned = (mention: string, session: string | null) =>
    openPreview(decodeURIComponent(mention.replace(MENTION, "")).replace(/:\d+(?::\d+)?$/, "").replace(/^\.\//, ""), session);

  const remark = [remarkGfm, remarkMath, remarkFilePaths];
  const mdComponentsFor = (session: string | null) => ({ a: (props: any) => {
    const href = typeof props.href === "string" ? props.href : "";
    if (href.startsWith(MENTION)) return <button className="file-link" onClick={() => openMentioned(href, session)}>{props.children}</button>;
    // A plain markdown link to a local file → open the preview, not navigate to the SPA fallback.
    if (isLocalHref(href)) return <button className="file-link" onClick={() => openMentioned(MENTION + encodeURIComponent(href), session)}>{props.children}</button>;
    return <a {...props} target="_blank" rel="noreferrer" />;
  } });

  return (
    <div className="app">
      <style>{STYLES}</style>
      <header className="topbar">
        <div className="brand">QiYan</div>
        <nav className="tabs" onWheel={(e) => { if (e.deltaY !== 0) e.currentTarget.scrollLeft += e.deltaY; }}>
          <button className={`tab ${selected === null ? "on" : ""}`} onClick={() => setSelected(null)}><span className="dot other" />QiYan</button>
          {sessions.map((s) => {
            const status = workerStatus(s);
            return <button key={s.nickname} className={`tab ${selected === s.nickname ? "on" : ""}`} onClick={() => setSelected(s.nickname)} title={`${s.provider} · ${status.label}${s.goal ? " · goal:" + s.goal.status : ""}`}>
              <span className={`dot ${status.tone}`} />
              <span className="tab-copy"><span className="tab-name">{s.nickname}</span><span className="tab-status">{status.label}</span></span>
            </button>;
          })}
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
                <div className="md"><Markdown remarkPlugins={remark} rehypePlugins={[rehypeHighlight, rehypeKatex]} components={mdComponentsFor(selected ?? m.origin ?? null)}>{normalizeMath(m.body)}</Markdown></div>
              </div>
            ))}
          </div>
          {goal && <div className="goal-row" aria-label={`${selected} goal`} aria-live="polite">
            <div className="goal-meta"><span className="goal-label">Goal</span><span className="goal-status" data-status={goal.status}>{formatGoalStatus(goal.status)}</span></div>
            <div className="goal-objective">{goal.objective}</div>
          </div>}
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
                  : isMd && !srcMode ? <div className="md"><Markdown remarkPlugins={remark} rehypePlugins={[rehypeHighlight, rehypeKatex]} components={mdComponentsFor(selected)}>{normalizeMath(preview.text)}</Markdown>{preview.truncated ? <div className="hint">… [truncated]</div> : null}</div>
                  : <><CodeView text={preview.text} title={preview.title} lang={preview.lang} />{preview.truncated ? <div className="hint">… [truncated]</div> : null}</>}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

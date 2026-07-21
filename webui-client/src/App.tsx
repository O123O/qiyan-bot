import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import hljs from "highlight.js/lib/common";
import "katex/dist/katex.min.css";
import { formatGoalStatus, selectedWorkerGoal, type WorkerGoal } from "./goal-presentation";
import { createBrowserUuid } from "./browser-uuid";
import { assistantMessagePresentation } from "./chat-provenance";
import { joinFilesystemPath, parentFilesystemPath } from "./filesystem-path";
import { mergeAssistantConversation } from "./assistant-chat-stream";
import { ASSISTANT_COMMAND_SUGGESTIONS, filterCommandSuggestions, type CommandSuggestion } from "./command-suggestions";
import { STYLES } from "./styles";
import { parseWorkerCommand, WORKER_COMMAND_SUGGESTIONS, WORKER_GOAL_HELP, type WorkerCommand } from "./worker-commands";
import {
  advanceWorkerScrollPreservation,
  nextWorkerHistoryAutoFill,
  releaseWorkerHistoryAutoFill,
  sameWorkerSubscriptionTarget,
  settleWorkerScrollPreservation,
  shouldFollowWorkerTail,
  workerViewportRevision,
  type WorkerHistoryAutoFillState,
  type WorkerScrollPreservation,
  type WorkerSubscriptionTarget,
} from "./worker-chat-policy";
import { workerStatus } from "./worker-status";
import {
  acknowledgeWorkerSubscription,
  addOptimisticWorkerMessage,
  applyWorkerSnapshot,
  beginWorkerHistory,
  beginWorkerReconnect,
  beginWorkerSubscription,
  dequeueWorkerRecovery,
  drainWorkerRecoveryAfterAttempt,
  failWorkerHistory,
  finishWorkerHistory,
  receiveWorkerEvent,
  removeOptimisticWorkerMessage,
  requeueWorkerRecovery,
  retainWorkerDraftMessages,
  storeWorkerDraftMessages,
  takeWorkerDraftMessages,
  type WorkerDraftCache,
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
const ASSIST_STREAM = "assistant";
const PAGE = 20;             // messages fetched per page
const RENDER_CAP = 30;       // messages rendered initially per tab
const REVEAL_STEP = 20;      // reveal step when scrolling into in-memory history
const TOP_PX = 120, BOTTOM_PX = 80;
const RECOVERY_RETRY_MS = [500, 1_500, 3_000] as const;

interface Session { nickname: string; mappingId: string; endpoint: string; provider: string; projectDir: string; lifecycleState: string; nativeStatus: string | null; activeTurnId: string | null; model: string | null; effort: string | null; host: string; goal: WorkerGoal | null; }
interface Msg { id?: string; body: string; completedAt?: number; terminalStatus?: string; role?: "you" | "assistant" | "worker"; at?: number; worker?: string; origin?: string; phase?: string; streaming?: boolean; turnOrder?: number; itemOrder?: number; }
type FileResult = { kind: "dir"; path: string; entries: Array<{ name: string; type: "dir" | "file" | "other" }> } | { kind: "file"; path: string; content: string; truncated: boolean; encoding: string } | { error: string };
interface GitStatus { branch: string; ahead: number; behind: number; staged: string[]; changes: string[]; untracked: string[] }
type Preview = { path?: string; session?: string | null } & (
  | { kind: "loading"; title: string }
  | { kind: "text"; title: string; text: string; truncated: boolean; lang?: string }
  | { kind: "image"; title: string; url: string }
  | { kind: "error"; title: string; error: string }
);

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
  const [assistantSession, setAssistantSession] = useState<Session | null>(null);
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
  const [filesystemRoot, setFilesystemRoot] = useState("~");
  const [filesystemPath, setFilesystemPath] = useState("~");
  const [filesWidth, setFilesWidth] = useState<number>(() => Number(localStorage.getItem("qiyan-files-w")) || 300);
  const [sidebarTab, setSidebarTab] = useState<"files" | "git">("files");
  const [trackedRepos, setTrackedRepos] = useState<string[]>([]);            // repos tracked for this worker (localStorage)
  const [repoStatus, setRepoStatus] = useState<Record<string, GitStatus | { error: string } | "loading">>({});
  const [discovered, setDiscovered] = useState<string[] | null>(null);       // add-repo picker (null = closed)
  const [commitMsg, setCommitMsg] = useState<Record<string, string>>({});    // per-repo commit message
  const [mentionSuggestions, setMentionSuggestions] = useState<string[]>([]);
  const [slashSuggestionsOpen, setSlashSuggestionsOpen] = useState(true);
  const [sugIdx, setSugIdx] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const preserveRef = useRef<WorkerScrollPreservation | null>(null); // scroll-height baseline across a prepend read
  const stickRef = useRef(true);                   // whether to stay pinned to the bottom
  const key = selected ?? ASSIST;
  const goal = selectedWorkerGoal(sessions, selected);
  const selectedSession = selected === null ? assistantSession : sessions.find((session) => session.nickname === selected) ?? null;
  const slashSuggestions = slashSuggestionsOpen
    ? filterCommandSuggestions(text, selected === null ? ASSISTANT_COMMAND_SUGGESTIONS : WORKER_COMMAND_SUGGESTIONS)
    : [];
  const suggestionCount = slashSuggestions.length || mentionSuggestions.length;
  const selectedMappingId = selectedSession?.mappingId ?? null;
  const selectedRef = useRef(selected); selectedRef.current = selected; // for the WS handler's stale closure
  const sessionsRef = useRef(sessions); sessionsRef.current = sessions;
  const assistantSessionRef = useRef(assistantSession); assistantSessionRef.current = assistantSession;
  const workerRef = useRef<WorkerStreamState | null>(workerChat); workerRef.current = workerChat;
  const workerDraftsRef = useRef<WorkerDraftCache>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const workerSubscriptionTargetRef = useRef<WorkerSubscriptionTarget | null>(null);
  const workerPageLoaderRef = useRef<((nickname: string, subscriptionId: string, snapshotPending: boolean, before?: string, recoveredTurnId?: string, reconcileLatest?: boolean) => Promise<boolean>) | null>(null);
  const workerHistoryAbortRef = useRef<AbortController | null>(null);
  const recoveryRetriesRef = useRef(new Map<string, { attempt: number; timer: number }>());
  const completionReloadsRef = useRef(new Map<string, number[]>());
  const reconciliationRetryRef = useRef<{ subscriptionId: string; attempt: number; timer: number } | null>(null);
  const workerHistoryAutoFillsRef = useRef(new Map<string, WorkerHistoryAutoFillState>());
  const workerTailRevisionRef = useRef("");
  const workerTailScrollFrameRef = useRef<number | null>(null);
  const push = (k: string, m: Msg) => setLog((prev) => ({ ...prev, [k]: [...(prev[k] ?? []), m] }));
  const replaceWorker = useCallback((next: WorkerStreamState | null) => { workerRef.current = next; setWorkerChat(next); }, []);
  const clearRecoveryRetries = useCallback(() => {
    for (const retry of recoveryRetriesRef.current.values()) window.clearTimeout(retry.timer);
    recoveryRetriesRef.current.clear();
    for (const timers of completionReloadsRef.current.values()) for (const timer of timers) window.clearTimeout(timer);
    completionReloadsRef.current.clear();
    if (reconciliationRetryRef.current) window.clearTimeout(reconciliationRetryRef.current.timer);
    reconciliationRetryRef.current = null;
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
  const scheduleCompletionReloads = useCallback((nickname: string, subscriptionId: string, turnId: string): void => {
    const key = `${subscriptionId}:${turnId}`;
    for (const timer of completionReloadsRef.current.get(key) ?? []) window.clearTimeout(timer);
    const timers = RECOVERY_RETRY_MS.map((delay, index) => window.setTimeout(() => {
      const current = workerRef.current;
      if (current?.nickname === nickname && current.subscriptionId === subscriptionId) {
        void workerPageLoaderRef.current?.(nickname, subscriptionId, false).then((started) => {
          const latest = workerRef.current;
          if (!started && latest?.nickname === nickname && latest.subscriptionId === subscriptionId && latest.historyInFlight) {
            replaceWorker({ ...latest, reconcilePending: true });
          }
        });
      }
      if (index === RECOVERY_RETRY_MS.length - 1) completionReloadsRef.current.delete(key);
    }, delay));
    completionReloadsRef.current.set(key, timers);
  }, [replaceWorker]);
  const scheduleReconciliationRetry = useCallback((nickname: string, subscriptionId: string): boolean => {
    const previous = reconciliationRetryRef.current?.subscriptionId === subscriptionId
      ? reconciliationRetryRef.current
      : null;
    const attempt = previous?.attempt ?? 0;
    if (attempt >= RECOVERY_RETRY_MS.length) {
      reconciliationRetryRef.current = null;
      return false;
    }
    if (previous) window.clearTimeout(previous.timer);
    const timer = window.setTimeout(() => {
      const current = workerRef.current;
      if (!current || current.nickname !== nickname || current.subscriptionId !== subscriptionId
        || current.historyInFlight || !current.reconcilePending) return;
      replaceWorker({ ...current, reconcilePending: false });
      void workerPageLoaderRef.current?.(nickname, subscriptionId, true, undefined, undefined, true);
    }, RECOVERY_RETRY_MS[attempt]);
    reconciliationRetryRef.current = { subscriptionId, attempt: attempt + 1, timer };
    return true;
  }, [replaceWorker]);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("qiyan-theme", theme); }, [theme]);

  const loadSessions = useCallback(async () => {
    try {
      const snapshot = await api<{ sessions: Session[]; assistant: Session }>("/api/sessions");
      setSessions(snapshot.sessions); setAssistantSession(snapshot.assistant);
    } catch { /* transient */ }
  }, []);
  const loadHistory = useCallback(async () => {
    try { const p = await api<{ messages: Msg[]; hasOlder: boolean }>(`/api/assistant/messages?limit=${PAGE}`); setHistory(p.messages); setHasOlder((h) => ({ ...h, [ASSIST]: p.hasOlder })); }
    catch { /* transient */ }
  }, []);
  const loadWorkerPage = useCallback(async (nickname: string, subscriptionId: string, snapshotPending: boolean, before?: string, recoveredTurnId?: string, reconcileLatest = false): Promise<boolean> => {
    const current = workerRef.current;
    if (!current || current.nickname !== nickname || current.subscriptionId !== subscriptionId) return false;
    const started = beginWorkerHistory(current, snapshotPending);
    if (!started.started) return false;
    replaceWorker(started.state);
    const abort = new AbortController();
    workerHistoryAbortRef.current = abort;
    try {
      const cursor = before === undefined ? "" : `&before=${encodeURIComponent(before)}`;
      const page = await api<WorkerSnapshot>(`/api/sessions/${nickname}/messages?limit=${PAGE}${cursor}&subscriptionId=${encodeURIComponent(subscriptionId)}`, { signal: abort.signal });
      const latest = workerRef.current;
      if (!latest || latest.nickname !== nickname || latest.subscriptionId !== subscriptionId) return true;
      const merged = applyWorkerSnapshot(latest, page, recoveredTurnId, before === undefined && latest.historyLoaded);
      replaceWorker(merged);
      if (reconcileLatest && reconciliationRetryRef.current?.subscriptionId === subscriptionId) {
        window.clearTimeout(reconciliationRetryRef.current.timer);
        reconciliationRetryRef.current = null;
      }
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
        let failed = latest.initialHistoryPending ? failWorkerHistory(latest) : finishWorkerHistory(latest);
        if (recoveredTurnId) failed = requeueWorkerRecovery(failed, recoveredTurnId);
        if (reconcileLatest) failed = { ...failed, reconcilePending: true };
        replaceWorker(failed);
        push(nickname, { role: "assistant", body: `Error: ${(error as { error?: string }).error ?? error}`, at: Date.now() });
      }
    } finally {
      if (workerHistoryAbortRef.current === abort) workerHistoryAbortRef.current = null;
      const latest = workerRef.current;
      if (latest && latest.nickname === nickname && latest.subscriptionId === subscriptionId) {
        const reconcileRetryScheduled = reconcileLatest && latest.reconcilePending
          ? scheduleReconciliationRetry(nickname, subscriptionId)
          : false;
        const retryScheduled = recoveredTurnId !== undefined && latest.pendingRecoveryTurnIds.includes(recoveredTurnId)
          ? scheduleRecoveryRetry(nickname, subscriptionId, recoveredTurnId)
          : false;
        const retryState = reconcileLatest && latest.reconcilePending && !reconcileRetryScheduled
          ? { ...latest, reconcilePending: false }
          : latest;
        const queued = reconcileRetryScheduled
          ? { state: retryState }
          : drainWorkerRecoveryAfterAttempt(retryState, recoveredTurnId, retryScheduled);
        if (queued.state !== latest) replaceWorker(queued.state);
        if (queued.reconcileLatest) {
          queueMicrotask(() => { void workerPageLoaderRef.current?.(nickname, subscriptionId, true, undefined, undefined, true); });
        } else if (queued.turnId) {
          queueMicrotask(() => { void workerPageLoaderRef.current?.(nickname, subscriptionId, true, undefined, queued.turnId); });
        }
      }
    }
    return true;
  }, [replaceWorker, scheduleReconciliationRetry, scheduleRecoveryRetry]);
  workerPageLoaderRef.current = loadWorkerPage;
  const openPreview = useCallback((path: string, session: string | null) => {
    setSrcMode(false);
    const url = rawUrl(path, session);
    if (IMG_EXT.test(path)) { setPreview({ kind: "image", title: path, path, session, url }); return; }
    if (TAB_EXT.test(path)) { window.open(url, "_blank", "noopener"); return; }
    setPreview({ kind: "loading", title: path, path, session });
    void readTextStream(url).then(({ text, truncated }) => setPreview({ kind: "text", title: path, path, session, text, truncated }))
      .catch((e) => setPreview({ kind: "error", title: path, path, session, error: (e as { error?: string }).error ?? "unavailable" }));
  }, []);
  const loadDir = useCallback(async (nickname: string | null, path: string, replaceRoot = false) => {
    const route = nickname === null
      ? `/api/filesystem?path=${encodeURIComponent(path)}`
      : `/api/files/${nickname}?path=${encodeURIComponent(path)}`;
    try {
      const r = await api<FileResult>(route);
      if ("kind" in r && r.kind === "dir") {
        const key = nickname === null && replaceRoot ? r.path : path;
        if (nickname === null && replaceRoot) {
          setFilesystemRoot(r.path); setFilesystemPath(r.path); setExpanded(new Set()); setDirs({ [key]: r.entries });
        } else setDirs((d) => ({ ...d, [key]: r.entries }));
      } else if (nickname === null && replaceRoot && "kind" in r && r.kind === "file") {
        setFilesystemPath(r.path); openPreview(r.path, null);
      } else setDirs((d) => ({ ...d, [path]: { error: "not a directory" } }));
    } catch (e) {
      const error = { error: (e as { error?: string }).error ?? "unavailable" };
      if (nickname === null && replaceRoot) { setFilesystemRoot(path); setDirs({ [path]: error }); }
      else setDirs((d) => ({ ...d, [path]: error }));
    }
  }, [openPreview]);
  const toggleDir = (nickname: string | null, path: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else { next.add(path); if (!dirs[path]) void loadDir(nickname, path); }
    return next;
  });

  const subscribeWorker = useCallback((socket: WebSocket | null, nickname: string | null) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const previous = workerRef.current;
    const streamNickname = nickname ?? ASSIST_STREAM;
    const session = nickname
      ? sessionsRef.current.find((candidate) => candidate.nickname === nickname)
      : assistantSessionRef.current ?? undefined;
    const mappingId = session?.mappingId ?? "";
    const target = session ? { socket, nickname: streamNickname, mappingId } : null;
    if (target && sameWorkerSubscriptionTarget(workerSubscriptionTargetRef.current, target)
      && previous?.nickname === streamNickname && previous.mappingId === mappingId) return;
    workerHistoryAbortRef.current?.abort();
    workerHistoryAbortRef.current = null;
    clearRecoveryRetries();
    workerHistoryAutoFillsRef.current.clear();
    const sameWorker = previous?.nickname === streamNickname && previous.mappingId === mappingId;
    if (previous && !sameWorker) {
      storeWorkerDraftMessages(workerDraftsRef.current, previous);
    }
    if (!session) {
      workerSubscriptionTargetRef.current = null;
      replaceWorker(null);
      socket.send(JSON.stringify({ type: "worker/unsubscribe", requestId: createBrowserUuid() }));
      return;
    }
    workerSubscriptionTargetRef.current = target;
    const requestId = createBrowserUuid();
    const resume = sameWorker && previous?.subscriptionId
      ? { subscriptionId: previous.subscriptionId, afterSeq: previous.lastSeq }
      : undefined;
    const retained = sameWorker && previous
      ? retainWorkerDraftMessages(previous)
      : takeWorkerDraftMessages(workerDraftsRef.current, streamNickname, mappingId);
    const next = resume && previous
      ? beginWorkerReconnect(previous, requestId)
      : beginWorkerSubscription(streamNickname, session.provider ?? "codex", requestId, retained, mappingId);
    replaceWorker(next);
    socket.send(JSON.stringify({ type: "worker/subscribe", nickname: streamNickname, requestId,
      ...(resume ? { resumeSubscriptionId: resume.subscriptionId, afterSeq: resume.afterSeq } : {}) }));
  }, [clearRecoveryRetries, replaceWorker]);

  useEffect(() => () => clearRecoveryRetries(), [clearRecoveryRetries]);
  useEffect(() => () => workerHistoryAbortRef.current?.abort(), []);
  useEffect(() => () => {
    if (workerTailScrollFrameRef.current !== null) window.cancelAnimationFrame(workerTailScrollFrameRef.current);
  }, []);
  useEffect(() => { void loadSessions(); }, [loadSessions]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);
  useEffect(() => { // WebSocket live updates
    let ws: WebSocket, stop = false;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?token=${encodeURIComponent(TOKEN)}`);
      wsRef.current = ws;
      ws.onopen = () => { setLive(true); subscribeWorker(ws, selectedRef.current); };
      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (workerSubscriptionTargetRef.current?.socket === ws) workerSubscriptionTargetRef.current = null;
        setLive(false); if (!stop) setTimeout(connect, 2000);
      };
      ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === "sessions") {
          sessionsRef.current = m.sessions;
          assistantSessionRef.current = m.assistant;
          setSessions(m.sessions); setAssistantSession(m.assistant);
          subscribeWorker(ws, selectedRef.current);
        }
        else if (m.type === "message") { push(ASSIST, { ...(typeof m.id === "string" ? { id: m.id } : {}), role: "assistant", body: m.body, at: m.at, ...(typeof m.worker === "string" ? { worker: m.worker } : {}), ...(typeof m.origin === "string" ? { origin: m.origin } : {}) }); if (selectedRef.current === null && !stickRef.current) setVisible((v) => v + 1); }
        else if (m.type === "worker/subscribed") {
          const current = workerRef.current;
          if (!current || current.nickname !== m.nickname || current.requestId !== m.requestId || typeof m.subscriptionId !== "string") return;
          const acknowledged = acknowledgeWorkerSubscription(current, m.subscriptionId, typeof m.mappingId === "string" ? m.mappingId : "", {
            resumed: m.resumed === true, replayGap: m.replayGap === true,
            latestSeq: Number.isSafeInteger(m.latestSeq) ? m.latestSeq : undefined,
          });
          replaceWorker(acknowledged);
          if (m.resumed !== true || m.replayGap === true) {
            void workerPageLoaderRef.current?.(m.nickname, m.subscriptionId, true, undefined, undefined, true);
          }
        } else if (m.type === "worker/event") {
          const current = workerRef.current;
          if (!current) return;
          const next = receiveWorkerEvent(current, m as WorkerEventEnvelope);
          if (next === current) return;
          replaceWorker(next);
          if (m.event?.kind === "turn-completed") scheduleCompletionReloads(next.nickname, next.subscriptionId!, m.event.turnId);
          if (!stickRef.current) setVisible((value) => value + 1);
          const queued = dequeueWorkerRecovery(next);
          if ((queued.reconcileLatest || queued.turnId) && queued.state.subscriptionId) {
            replaceWorker(queued.state);
            void workerPageLoaderRef.current?.(
              queued.state.nickname, queued.state.subscriptionId, true, undefined, queued.turnId, queued.reconcileLatest,
            );
          }
        } else if (m.type === "worker/subscription-error") {
          const current = workerRef.current;
          if (current && current.requestId === m.requestId) {
            workerSubscriptionTargetRef.current = null;
            push(current.nickname, { role: "assistant", body: `[worker stream unavailable: ${m.code ?? "error"}]`, at: Date.now() });
          }
        } }; // grow the window while scrolled up so a live append doesn't slide/jump
    };
    connect();
    return () => { stop = true; try { ws.close(); } catch { /* closing */ } };
  }, [replaceWorker, scheduleCompletionReloads, subscribeWorker]);

  // On tab switch: reset the render window, pin to bottom, and lazily load the transcript + file root.
  useEffect(() => {
    setVisible(RENDER_CAP); stickRef.current = true; preserveRef.current = null;
    subscribeWorker(wsRef.current, selected);
    setDirs({}); setExpanded(new Set());
    if (selected) void loadDir(selected, "");
    else { setSidebarTab("files"); void loadDir(null, "~", true); }
  }, [selected, selectedMappingId, subscribeWorker, loadDir]);
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
    const streamNickname = selected ?? ASSIST_STREAM;
    const workerMessages: Msg[] = workerChat?.nickname === streamNickname ? workerChat.messages : [];
    const assistantLive = selected === null ? workerMessages.filter((message) => message.role !== "you") : [];
    const base = selected === null
      ? mergeAssistantConversation([...history, ...(log[ASSIST] ?? [])], assistantLive)
      : [...workerMessages, ...(log[selected] ?? [])].sort((a, b) => when(a) - when(b)
      || (a.turnOrder ?? Number.MAX_SAFE_INTEGER) - (b.turnOrder ?? Number.MAX_SAFE_INTEGER)
      || (a.itemOrder ?? Number.MAX_SAFE_INTEGER) - (b.itemOrder ?? Number.MAX_SAFE_INTEGER));
    return base.filter((m) => m.body.trim());
  }, [selected, workerChat, log, history]);
  const rendered = shown.slice(Math.max(0, shown.length - visible));
  const tailRevision = workerViewportRevision(key, rendered, goal ? `${goal.status}\0${goal.objective}` : "");

  // Keep scroll position when prepending older messages; otherwise stay pinned to the bottom.
  useLayoutEffect(() => {
    const el = logRef.current; if (!el) return;
    const previousRevision = workerTailRevisionRef.current;
    const preservation = preserveRef.current;
    const preservePending = preservation !== null;
    if (preservePending) {
      if (workerTailScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(workerTailScrollFrameRef.current);
        workerTailScrollFrameRef.current = null;
      }
      const advanced = advanceWorkerScrollPreservation(preservation, el.scrollHeight);
      el.scrollTop += advanced.scrollDelta;
      preserveRef.current = advanced.state;
    }
    else if (shouldFollowWorkerTail({ pinned: stickRef.current, preservePending, previousRevision, nextRevision: tailRevision })
      && workerTailScrollFrameRef.current === null) {
      workerTailScrollFrameRef.current = window.requestAnimationFrame(() => {
        workerTailScrollFrameRef.current = null;
        if (stickRef.current) el.scrollTop = el.scrollHeight;
      });
    }
    workerTailRevisionRef.current = tailRevision;
  }, [rendered.length, tailRevision, selected, loadingOlder, goal?.objective, goal?.status]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder) return;
    const el = logRef.current;
    const assistantCursor = selected === null ? history[0]?.at : undefined;
    const workerCursor = selected !== null && workerChat?.nickname === selected ? workerChat.olderCursor : undefined;
    if (assistantCursor === undefined && workerCursor === undefined) return;
    setLoadingOlder(true);
    if (el) preserveRef.current = { height: el.scrollHeight, pending: true };
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
    } catch { preserveRef.current = null; } finally {
      preserveRef.current = settleWorkerScrollPreservation(preserveRef.current);
      setLoadingOlder(false);
    }
  }, [loadingOlder, selected, history, workerChat, key, loadWorkerPage]);

  // Tool-heavy turns can yield a native page with few or no visible messages. Fill the foreground
  // viewport and cross its latest terminal-turn boundary; both searches stay capped and older
  // history remains lazy on scroll-up.
  useLayoutEffect(() => {
    if (selected === null || !workerChat || workerChat.nickname !== selected || !workerChat.subscriptionId
      || workerChat.pendingRecoveryTurnIds.length > 0) return;
    const key = `${selected}:${workerChat.subscriptionId}`;
    const previous = workerHistoryAutoFillsRef.current.get(key);
    if (!workerChat.olderCursor || workerChat.historyInFlight || loadingOlder || previous?.cursor === workerChat.olderCursor) return;
    const el = logRef.current;
    if (!el) return;
    const cursor = nextWorkerHistoryAutoFill({
      hasOlder: workerChat.hasOlder,
      historyInFlight: workerChat.historyInFlight,
      loadingOlder,
      cursor: workerChat.olderCursor,
      attempts: previous?.attempts ?? 0,
      recentBoundaryPending: workerChat.recentBoundaryPending,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
    if (!cursor) {
      workerHistoryAutoFillsRef.current.set(key, { attempts: previous?.attempts ?? 0, cursor: workerChat.olderCursor });
      return;
    }
    workerHistoryAutoFillsRef.current.set(key, { attempts: (previous?.attempts ?? 0) + 1, cursor });
    queueMicrotask(() => {
      const current = workerRef.current;
      if (current?.nickname === selected && current.subscriptionId === workerChat.subscriptionId) {
        const load = workerPageLoaderRef.current?.(selected, workerChat.subscriptionId!, false, cursor);
        void load?.then((started) => {
          if (started) return;
          const consumed = workerHistoryAutoFillsRef.current.get(key);
          const released = releaseWorkerHistoryAutoFill(consumed, cursor);
          if (released) workerHistoryAutoFillsRef.current.set(key, released);
        });
      }
    });
  }, [selected, workerChat, loadingOlder]);

  const onScroll = () => {
    const el = logRef.current; if (!el) return;
    stickRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_PX;
    if (el.scrollTop <= TOP_PX) {
      if (visible < shown.length) { preserveRef.current = { height: el.scrollHeight, pending: false }; setVisible((v) => Math.min(v + REVEAL_STEP, shown.length)); }
      else if (hasOlder[key] && !loadingOlder) void loadOlder();
    }
  };

  const requestOlder = () => {
    const el = logRef.current;
    if (visible < shown.length) {
      if (el) preserveRef.current = { height: el.scrollHeight, pending: false };
      setVisible((value) => Math.min(value + REVEAL_STEP, shown.length));
      return;
    }
    void loadOlder();
  };

  const onText = (v: string) => {
    setText(v); setSugIdx(0); setSlashSuggestionsOpen(true);
    const at = /(?:^|\s)@([a-z0-9_-]*)$/i.exec(v); // @-autocomplete of worker nicknames
    setMentionSuggestions(at ? sessions.map((s) => s.nickname).filter((n) => n.startsWith(at[1].toLowerCase())).slice(0, 6) : []);
  };
  const pickMentionSuggestion = (nick: string) => { setText((t) => t.replace(/@[a-z0-9_-]*$/i, `@${nick} `)); setMentionSuggestions([]); };
  const pickCommandSuggestion = (suggestion: CommandSuggestion) => {
    setText(suggestion.insert); setSlashSuggestionsOpen(false); setMentionSuggestions([]);
  };

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

  const runWorkerCommand = async (command: WorkerCommand, raw: string) => {
    if (!selected) return;
    const nickname = selected;
    stickRef.current = true;
    push(nickname, { role: "you", body: raw, at: Date.now() });
    if (command.kind === "help") { push(nickname, { role: "assistant", body: WORKER_GOAL_HELP, at: Date.now() }); return; }
    if (command.kind === "error") { push(nickname, { role: "assistant", body: `[goal command: ${command.message}]`, at: Date.now() }); return; }
    try {
      await api<{ ok: boolean; error?: string }>(`/api/sessions/${selected}/goal`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId: createBrowserUuid(), action: command.action, ...(command.action === "set" ? { objective: command.objective } : {}) }),
      });
      push(nickname, { role: "assistant", body: `[goal ${command.action} succeeded]`, at: Date.now() });
      void loadSessions();
    } catch (error) {
      push(nickname, { role: "assistant", body: `[goal command failed: ${(error as { error?: string })?.error ?? error}]`, at: Date.now() });
    }
  };

  const send = async () => {
    const t = text.trim(); if (!t) return;
    if (selected && t.startsWith("!")) { setText(""); setMentionSuggestions([]); setSlashSuggestionsOpen(false); void runExec(t.slice(1).trim()); return; }
    const workerCommand = selected ? parseWorkerCommand(t) : null;
    if (workerCommand) { setText(""); setMentionSuggestions([]); setSlashSuggestionsOpen(false); void runWorkerCommand(workerCommand, t); return; }
    const m = /^@([a-z0-9][a-z0-9_-]*)\s+([\s\S]+)$/.exec(t);
    const redirect = m && sessions.some((s) => s.nickname === m[1]) ? m[1] : null;
    const target = redirect ?? selected ?? undefined;
    const body = redirect ? m![2] : t;
    setText(""); setMentionSuggestions([]); setSlashSuggestionsOpen(false); stickRef.current = true;
    const clientInputId = target ? createBrowserUuid() : undefined;
    const active = workerRef.current;
    if (target && target === selected && clientInputId) {
      const session = sessions.find((candidate) => candidate.nickname === target);
      const mappingId = session?.mappingId ?? "";
      const timeline = active?.nickname === target && active.mappingId === mappingId
        ? active
        : beginWorkerSubscription(target, session?.provider ?? "codex", createBrowserUuid(), [], mappingId);
      replaceWorker(addOptimisticWorkerMessage(timeline, `to:web:${clientInputId}`, body, Date.now()));
    } else {
      push(key, { role: "you", body: redirect && redirect !== selected ? `→ @${redirect}  ${body}` : body, at: Date.now() });
    }
    const removeRejectedOptimisticMessage = () => {
      if (!target || target !== selected || !clientInputId) return;
      const current = workerRef.current;
      if (current?.nickname === target) replaceWorker(removeOptimisticWorkerMessage(current, `to:web:${clientInputId}`));
    };
    try { const r = await api<{ ok: boolean; error?: string; clientUserMessageId?: string }>("/api/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: body, target, ...(clientInputId ? { clientInputId } : {}) }) });
      if (!r.ok) push(key, { role: "assistant", body: `[send failed: ${r.error ?? ""}]`, at: Date.now() }); }
    catch (e) { removeRejectedOptimisticMessage(); push(key, { role: "assistant", body: `[send error: ${(e as { error?: string }).error ?? e}]`, at: Date.now() }); }
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
    if (suggestionCount > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSugIdx((i) => (i + 1) % suggestionCount); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSugIdx((i) => (i - 1 + suggestionCount) % suggestionCount); return; }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const index = sugIdx % suggestionCount;
        if (slashSuggestions.length > 0) pickCommandSuggestion(slashSuggestions[index]!);
        else pickMentionSuggestion(mentionSuggestions[index]!);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); setSlashSuggestionsOpen(false); setMentionSuggestions([]); return; }
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
  const explorerUploadInput = useRef<HTMLInputElement>(null);
  const explorerUploadTarget = useRef<{ directory: string; session: string | null } | null>(null);
  const [explorerUploading, setExplorerUploading] = useState(false);
  const chooseExplorerUpload = (directory: string, session: string | null) => {
    explorerUploadTarget.current = { directory, session };
    explorerUploadInput.current?.click();
  };
  const uploadExplorerFile = async (file: File) => {
    const target = explorerUploadTarget.current;
    if (!target) return;
    setExplorerUploading(true);
    const path = target.session === null
      ? joinFilesystemPath(target.directory, file.name)
      : target.directory ? `${target.directory}/${file.name}` : file.name;
    const route = target.session === null
      ? `/api/filesystem?path=${encodeURIComponent(path)}`
      : `/api/files/${target.session}?path=${encodeURIComponent(path)}`;
    try {
      await api(route, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: file });
      if (selectedRef.current === target.session) {
        setExpanded((state) => new Set(state).add(target.directory));
        await loadDir(target.session, target.directory);
      }
    } catch (error) {
      alert((error as { error?: string })?.error ?? "upload failed");
    } finally {
      setExplorerUploading(false);
      explorerUploadTarget.current = null;
    }
  };
  const download = (path: string, session: string | null) => window.open(`${rawUrl(path, session)}&download=1`, "_blank");
  const insertPath = (path: string) => { const proj = sessions.find((s) => s.nickname === selected)?.projectDir; setText((t) => `${t ? t.replace(/\s*$/, " ") : ""}${proj ? `${proj}/${path}` : path} `); };
  const openFilesystemPath = (path: string) => { void loadDir(null, path.trim() || "~", true); };

  // Recursive file tree: folders expand in place (lazy-loaded); files open the preview popup; hover
  // reveals per-row actions (new file/folder in a dir; download / insert-path for a file).
  const renderDir = (path: string, depth: number): React.ReactNode => {
    const node = dirs[path];
    if (!node) return null;
    if ("error" in node) return <div className="hint" style={{ paddingLeft: 8 + depth * 14 }}>{node.error}</div>;
    if (!node.length) return <div className="hint" style={{ paddingLeft: 8 + depth * 14 }}>empty</div>;
    return node.map((e) => {
      const full = selected === null ? joinFilesystemPath(path, e.name) : path ? `${path}/${e.name}` : e.name;
      if (e.type === "dir") {
        const open = expanded.has(full);
        return <div key={full}>
          <div className="frow dir" style={{ paddingLeft: 6 + depth * 14 }} onClick={() => toggleDir(selected, full)}>
            <span className="tw">{open ? "▾" : "▸"}</span>📁 <span className="fname">{e.name}</span>
            <span className="actions" onClick={(ev) => ev.stopPropagation()}>
              <button title="Upload file" disabled={explorerUploading} onClick={() => chooseExplorerUpload(full, selected)}>⬆</button>
              {selected && <button title="New file" onClick={() => newEntry("mkfile", full)}>＋📄</button>}
              {selected && <button title="New folder" onClick={() => newEntry("mkdir", full)}>＋📁</button>}
            </span>
          </div>
          {open && renderDir(full, depth + 1)}
        </div>;
      }
      return <div key={full} className={`frow ${e.type}`} style={{ paddingLeft: 24 + depth * 14 }} onClick={() => e.type === "file" ? openPreview(full, selected) : undefined}>
        {e.type === "file" ? "📄" : "🔗"} <span className="fname">{e.name}</span>
        {e.type === "file" && <span className="actions" onClick={(ev) => ev.stopPropagation()}>
          <button title="Download" onClick={() => download(full, selected)}>⬇</button>
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

  // Open a mentioned file in the popup. The server resolves absolute paths directly and worker
  // relative paths under their project, so the client never guesses which root a path lives in.
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
          {(() => {
            const status = assistantSession ? workerStatus(assistantSession) : { label: "unavailable" as const, tone: "unavailable" as const };
            return <button className={`tab ${selected === null ? "on" : ""}`} onClick={() => setSelected(null)} title={`codex · ${status.label}`}>
              <span className={`dot ${status.tone}`} />
              <span className="tab-copy"><span className="tab-name">QiYan</span><span className="tab-status">{status.label}</span></span>
            </button>;
          })()}
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
              <button className={sidebarTab === "git" ? "on" : ""} disabled={selected === null} onClick={() => setSidebarTab("git")}>Git</button>
            </span>
            {sidebarTab === "files" && <span className="head-actions">
              <input ref={explorerUploadInput} type="file" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadExplorerFile(file); event.target.value = ""; }} />
              <button className="ghost sm" title="Upload file" disabled={explorerUploading} onClick={() => chooseExplorerUpload(selected === null ? filesystemRoot : "", selected)}>{explorerUploading ? "…" : "⬆"}</button>
              {selected && <button className="ghost sm" title="New file at root" onClick={() => newEntry("mkfile", "")}>＋📄</button>}
              {selected && <button className="ghost sm" title="New folder at root" onClick={() => newEntry("mkdir", "")}>＋📁</button>}
              {selected && <button className="ghost sm" title="Refresh (no live watcher)" onClick={() => { [...new Set(["", ...Object.keys(dirs)])].forEach((p) => void loadDir(selected, p)); void loadSessions(); }}>⟳</button>}
            </span>}
          </div>
          {selected === null && <form className="filesystem-nav" onSubmit={(event) => { event.preventDefault(); openFilesystemPath(filesystemPath); }}>
            <button type="button" className="ghost sm" title="Parent folder" onClick={() => openFilesystemPath(parentFilesystemPath(filesystemRoot))}>↑</button>
            <input value={filesystemPath} onChange={(event) => setFilesystemPath(event.target.value)} placeholder="~/ or absolute path" aria-label="Filesystem path" />
            <button type="submit" className="ghost sm">Go</button>
            <button type="button" className="ghost sm" title="Refresh" onClick={() => openFilesystemPath(filesystemRoot)}>⟳</button>
          </form>}
          {sidebarTab === "files" ? <div className="tree">{renderDir(selected === null ? filesystemRoot : "", 0)}</div> : renderGit()}
        </aside>
        <div className="resizer" onMouseDown={startResize} title="Drag to resize" />

        <main className="chat">
          <div className="log" ref={logRef} onScroll={onScroll}>
            {(hasOlder[key] || visible < shown.length) && <button type="button" className="older" disabled={loadingOlder} onClick={requestOlder}>{loadingOlder ? "loading…" : "load older messages"}</button>}
            {shown.length === 0 && <div className="empty">{selected === null ? "Message QiYan — replies appear here." : `Message ${selected} — its replies appear here.`}</div>}
            {rendered.map((m, i) => {
              const presentation = selected === null ? assistantMessagePresentation(m) : null;
              return <div key={m.id ?? `${m.at ?? m.completedAt}-${i}`} className={`msg ${m.role === "you" ? "you" : presentation?.className ?? ""}`}>
                <div className="when">{m.role === "you" ? "you" : m.role === "assistant" ? presentation?.label ?? "QiYan" : `${m.completedAt ? new Date(m.completedAt).toLocaleString() : ""} · ${m.terminalStatus ?? ""}`}</div>
                <div className="md"><Markdown remarkPlugins={remark} rehypePlugins={[rehypeHighlight, rehypeKatex]} components={mdComponentsFor(selected ?? m.origin ?? null)}>{normalizeMath(m.body)}</Markdown></div>
              </div>;
            })}
          </div>
          {goal && <div className="goal-row" aria-label={`${selected} goal`} aria-live="polite">
            <div className="goal-meta"><span className="goal-label">Goal</span><span className="goal-status" data-status={goal.status}>{formatGoalStatus(goal.status)}</span></div>
            <div className="goal-objective">{goal.objective}</div>
          </div>}
          <div className="composer">
            {slashSuggestions.length > 0 && <div className="suggest command-suggest" role="listbox" aria-label="Command suggestions">
              {slashSuggestions.map((suggestion, i) => <div key={suggestion.id} role="option" aria-selected={i === sugIdx % suggestionCount} className={`srow command-row ${i === sugIdx % suggestionCount ? "on" : ""}`} onMouseDown={(e) => { e.preventDefault(); pickCommandSuggestion(suggestion); }}>
                <span className="command-label">{suggestion.label}</span><span className="command-description">{suggestion.description}</span>
              </div>)}
            </div>}
            {slashSuggestions.length === 0 && mentionSuggestions.length > 0 && <div className="suggest" role="listbox" aria-label="Worker suggestions">{mentionSuggestions.map((n, i) => <div key={n} role="option" aria-selected={i === sugIdx % suggestionCount} className={`srow ${i === sugIdx % suggestionCount ? "on" : ""}`} onMouseDown={(e) => { e.preventDefault(); pickMentionSuggestion(n); }}>@{n}</div>)}</div>}
            <input ref={fileInput} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFile(f); e.target.value = ""; }} />
            <button className="ghost" title="Send a file (its path is appended)" disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? "…" : "📎"}</button>
            <textarea value={text} onChange={(e) => onText(e.target.value)} onKeyDown={onKey} rows={2}
              placeholder={selected === null ? "Message QiYan… (type / for commands; @worker to direct-message)" : `Message ${selected}… (type / for commands)`} />
            <button onClick={() => void send()}>Send</button>
          </div>
          {selectedSession && <div className="worker-context" aria-label={`${selectedSession.nickname} session context`}>
            <span>{selectedSession.provider}</span>
            <span>model <strong>{selectedSession.model ?? "default"}</strong></span>
            <span>effort <strong>{selectedSession.effort ?? "default"}</strong></span>
            <span>cwd <strong>{selectedSession.projectDir}</strong></span>
            <span>host <strong>{selectedSession.host}</strong></span>
          </div>}
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
                  {preview.path !== undefined
                    && <button className="ghost sm" title="Download" onClick={() => download(preview.path!, preview.session ?? null)}>Download</button>}
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

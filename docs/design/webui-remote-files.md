# Design: Remote file explorer, transfer & git in the web UI

## Goal
A remote (ssh) worker's files browse / preview / download / upload / git in the web UI exactly like a local
worker's. A file path in a remote worker's message — including its `[worker] …` relay shown in the
QiYan panel — streams from **that worker's host**.

## Hard constraints
1. **Web-UI-only.** No changes to `src/endpoints/*`, `SshRuntime`, ControlMaster/tunnel management, or
   any chat adapter. Remote file access exists only while the web UI is running.
2. **One shared global ControlMaster.** MFA nodes require a human to verify a login once; you therefore
   cannot have more than one authenticated ssh connection per host. So the web UI must **not** create or
   manage its own ControlMaster — it runs plain `ssh <host>` and relies on the user's `~/.ssh/config`
   global ControlMaster (the same one the bot's core already reuses). Documented in the README.
3. **Chat apps unaffected.** They never touch the web layer.

## Architecture — transport-aware file layer
Today `web-files`/`web-server` resolve **local** paths via `fs`. Introduce a per-session transport:

```
deps.fileTarget(nickname) →
  { transport: "local",  projectDir }               // fs (today)
  { transport: "remote", host, projectDir }         // ssh (new)
  undefined                                         // unknown / not browsable
```
`host` + `projectDir` are read from `registry.sessions[nickname].endpoint` → catalog definition
(`transport:"ssh"`, `host`, `projects_root`) + `session.project_dir`. **Read-only** use of existing
config — no endpoint code changes.

New module `src/webui/web-remote.ts` mirrors `web-files`/`web-git` over ssh:
- `remoteBrowse(host, root, rel)` → dir listing (JSON, same shape as `browse`)
- `remoteRead(host, root, rel)` → **stream** of file bytes (for `/api/raw`)
- `remoteUploadFile(host, root, rel, bytes)` → size-capped, non-overwriting atomic publication
- `remoteGit(host, repoDir, args)` / `remoteDiscover(host, root)` → git status/diff/stage/commit/discover

The existing routes keep their URLs (`/api/files/:n`, `/api/raw`, `/api/git/*`); each dispatches
local→fs or remote→ssh on the session's transport. Explorer upload uses `PUT /api/files/:n?path=…`
for workers and `PUT /api/filesystem?path=…` for QiYan's owner filesystem.

## Remote transport mechanics (revised after adversarial review)

### SSH invocation — REUSE the core's `ssh-config` machinery (fixes injection + master reuse)
ssh does **not** deliver argv to the remote command — it joins post-alias args into one string handed
to the remote *login shell*, which re-parses it. So untrusted `path` MUST be POSIX-single-quoted into
the command string, and master reuse must use `-o ControlMaster=no` with the discovered `ControlPath`.
The core already does exactly this; the web UI reuses those functions (no core edits):

- `plan = planSshConnection(host, parseSshConfig(<ssh -G host>), sshRuntimeRoot)` — same runtimeDir as
  the core, so the plan's `controlPath` is the SAME socket the core established (user-owned master, or
  the deterministic QiYan-owned path). Cached per host.
- Run each op with `buildSshStreamArgs(plan, remoteCmd)` → `baseArgs(plan, false)` = `-S <controlPath>
  -o ControlMaster=no` + `BatchMode=yes`. **Reuse-only, never creates a master.** If the master is
  absent (endpoint not connected / MFA not authed) it fails fast → UI shows "remote host not connected".
- `remoteCmd` is built with POSIX single-quoting (mirror `SshClaudeCommandRunner`) and forces bash so
  the login shell only ever runs `exec bash -c '<script>'` (works for POSIX or csh login shells):
  ```
  q = s => "'" + s.replaceAll("'", "'\\''") + "'"
  script = `root=${q(root)}; rel=${q(rel)}; ...guard...; ...op...`
  remoteCmd = `exec bash -c ${q(script)}`      // one argv → login shell just execs bash
  ```
  Untrusted `root`/`rel`/`path` only ever appear single-quoted → no reparse/injection.

### Remote confinement guard (on the remote; mirrors local `confine`/`confineAbsolute`)
```bash
root=$(realpath -m -- "$root") || exit 3          # H3: realpath the ROOT too (symlinked NFS homes)
# relative path (browse/tree):  t=$(realpath -m -- "$root/$rel")
# absolute path (mentions):     t=$(realpath -m -- "$rel")           # confineAbsolute variant
[ -n "$t" ] || exit 3
case "$t/" in "$root"/*) ;; *) exit 4 ;; esac     # "$root" quoted ⇒ globs literal; only /* is wildcard
```
- Root realpath'd first (H3), so symlinked scratch/NFS roots resolve correctly.
- Absolute vs relative chosen by the route via `isAbsolute(path)` (M6) — no `root//abs` bug.
- Sibling-prefix (root `/a/b`, target `/a/bc`) is correctly rejected by the trailing-slash pattern (N1).
- TOCTOU between realpath and the op is accepted (same as local).

### Per-op remote scripts
- **read/stream (preview):** `t=<abs as-is | "$root/$rel">; [ -f "$t" ] || exit 5; exec cat -- "$t"`
  — the `[ -f ]` regular-file check (M6) rejects dirs/FIFOs. **NOT confined** to the project root: the
  owner-only preview streams ANY file the remote user can read (a worker legitimately references configs,
  logs, `~/.…` outside its project dir). The remote OS's own read permission is the boundary — an
  unreadable/absent path exits non-zero → 404. Only the preview read is unconfined; browse/git below
  keep the confinement guard. On client disconnect the caller kills the ssh child (SIGPIPEs the `cat`).
- **browse:** `ls` emitting **NUL-delimited** `type\tname` records (N3; newlines are legal in names).
- **git:** `git -C "$t" -c core.quotePath=false <args>` with **all `--` separators preserved** and
  `-`-leading paths rejected (H4). Untracked diff replicates the local `--no-index` guard: reject
  absolute/`..` and re-confine before `git diff --no-index -- /dev/null <confined>` (H4).
- **discover:** bounded — `find "$root" -maxdepth 4 -name .git -prune -print0` with a skip-list and a
  result cap + overall deadline (M8), mirroring local `discoverRepos`.

### Streaming lifecycle
`/api/raw` remote **pipes** the ssh child's stdout to the HTTP response (NOT the buffering
`runBoundedProcess` — M5). No `content-length` (chunked); `Content-Type`/CSP/`nosniff`/`download` still
derive from `extname(path)` on the string (M6). Client disconnect kills the local ssh, and the
stdin-tied script kills the remote `cat` (M5). Output byte cap + a hard deadline.

## QiYan panel: routing a relay's path to its host (M7)
Do NOT re-parse rendered markdown. The QiYan history is built server-side from `deliveries`; when a
delivery is a `worker_final`/`worker_warning`, the server extracts the **leading** `[<nick>…]` prefix
(the relay always prepends it, so only position 0 is trusted), validates `<nick>` against the live
registry, and attaches `origin: <nick>` as structured metadata on the message. The client routes a
clicked path in that message against `origin`'s session (remote → its host). A path text elsewhere in
the body is NOT trusted as an origin. All hosts are within the token's trust and each read stays
confined, so residual spoofing is UX-only.

## Security
- Same token gate. **Browse/git** reads are **confined** to the worker's remote project dir. The
  **preview** (`/api/raw`) is deliberately **unconfined** — it streams any file the remote user can read
  (owner decision, 2026-07-14): a worker references files outside its project dir and the owner wants to
  preview them. If the web token leaks, an attacker could read any user-readable file on that host — an
  accepted tradeoff, since the token already grants worker-drive + local shell.
- The ssh user is the account the worker already runs as, so this reveals nothing the worker couldn't
  already read; it is a read/exec primitive scoped to the web token (which already grants full local
  access + `!`-shell). Noted alongside the LAN warning.
- Remote git `commit`/`stage` mutate the remote repo — same trust as the worker itself.

## Failure modes
- ControlMaster not up / host down → `BatchMode` + `ConnectTimeout` fail fast → clear UI error.
- Slow/large file → output cap + a hard deadline; ssh child killed.
- `realpath`/`bash` missing on remote → op returns an error, never a partial/incorrect read.

## Isolation guarantees
- New code only (`web-remote.ts` + a transport branch in `web-files`/`web-server`).
- **Reuses** the existing `ssh-config.ts` FUNCTIONS (`planSshConnection`, `buildSshStreamArgs`,
  `parseSshConfig`) read-only — never opens/owns/creates a master (`ControlMaster=no`), so it can only
  ride the master the core already established. Zero edits to `src/endpoints/*`, `SshRuntime`, or chat
  adapters. Remote reads work only while the core has a live connection to that worker (which it does
  for a managed session).
- **Wiring (N5):** the web deps gain read-only access to the endpoint catalog (`host`/`transport`) and
  `sshRuntimeRoot` to build the plan — `production-app.ts` currently returns `undefined` for remote
  sessions; that branch is replaced with a remote `fileTarget`. Registry+catalog are cloned per request
  (session-gone → error); a catalog `host` swap mid-op is low-impact (still confined).

## Assumptions (N4) — documented
Remote workers are Linux with bash + GNU coreutils (`realpath -m`), a POSIX/csh login shell, and git —
already true for QiYan's remote endpoints. macOS `realpath` lacks `-m` (out of scope).

## README / docs addition
`docs/ssh-workers.md` already documents the required user-owned ControlMaster (`ControlPath
${XDG_RUNTIME_DIR}/qiyan-ssh-%C`, MFA-authenticated once). Add one line: the web UI's remote file
features **reuse that same master** (via `ssh -G` discovery + `ControlMaster=no`), so remote browsing,
transfer, and Git work only when it is up; for a QiYan-owned-master deployment they ride the QiYan socket.

## Phases (all in scope)
1. Remote preview/stream (`/api/raw` remote) + relay-path routing.
2. Remote tree (`/api/files` remote browse).
3. Remote git (multi-repo panel over ssh: discover/status/diff/stage/unstage/commit).
4. Local and remote explorer download/upload controls with project-confined, non-overwriting writes.

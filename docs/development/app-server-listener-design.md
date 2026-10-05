# Remote app-server listener: surviving a per-channel `/tmp`

## The failure

`lyris` gives every SSH channel a private `/tmp`. Codex resolves `--listen unix://PATH` by replacing
that path with a symlink into `/tmp/codex-daemon-<uid>/`, so the socket QiYan asked for in its shared
runtime directory ends up pointing at a file that exists only inside the channel that started the
app-server. Every later connection resolves the link to nothing, and the endpoint is unavailable
forever — no restart helps, because the next start repeats it.

Measured on `lyris` (codex 0.160.0):

```
app-server.sock -> /tmp/codex-daemon-2001066568/dec102b0…
target:            <does not exist in this channel>
/tmp/codex-daemon-*: not visible
```

`prenyx` carries the identical symlink and works, because its `/tmp` is shared. The redirect is not
new in 0.160.0 — `prenyx` showed it on 0.156.1 — and QiYan already tolerates it:
`privateSocketIdentity(path, allowCodexDaemonLink)` permits exactly this link shape under strict
ownership checks. What it cannot tolerate is the target being absent.

Configuration cannot fix it. On `lyris` all of these left the symlink unchanged:

| attempt | result |
| --- | --- |
| `TMPDIR=<shared dir>` | still `/tmp/codex-daemon-…`; the prefix is hardcoded |
| `-c daemon_auto_start=false` | `` `daemon_auto_start` is ignored `` |
| `--disable daemon_auto_start` | no change |
| `daemon_auto_start = false` in `config.toml` | no change |

## The mechanism

`--listen` also accepts `ws://IP:PORT`. A loopback TCP port is addressed through the network stack
rather than the filesystem, so a mount namespace cannot hide it. Verified across two separate SSH
channels on `lyris`: `LISTEN 127.0.0.1:45717` in one, `TCP CONNECT OK` from the other.

Given `:0` codex picks a free port. Measured properties of that listener, which this design depends
on:

- the WebSocket upgrade **requires** `Authorization: Bearer <token>` — `401 missing websocket bearer
  token` without it, `101` with it. `--ws-token-sha256` alone is sufficient server-side.
- `/readyz` and `/healthz` answer `200` with **no** auth.
- a bogus `Host` is accepted; a cross-origin `Origin` is rejected `403`. Node's `ws` client sends no
  `Origin`, so `ws://qiyan-app-server.invalid/` keeps working — nobody should add an `origin` option.
- the listener appears in `/proc/net/tcp` as `0100007F:<port> 00000000:0000 0A` with the owner uid
  in the uid column; nothing in `/proc/net/tcp6`.

### Precondition

Everything here assumes the **runtime directory** is shared across channels — `XDG_RUNTIME_DIR`,
i.e. `sharedRuntimeBase`. On the fallback base `/tmp/qiyan-<uid>`, a host with per-channel `/tmp`
also hides the helper, `tmux.sock`, `identity.json` and the token, and a loopback port fixes nothing.
A host that isolates `/tmp` *and* lacks a usable XDG runtime directory is out of scope and must fail
legibly rather than loop. The same applies to a host that isolates the network namespace per session:
the loopback port would then be as invisible as the socket.

### Why this does not weaken access control

A Unix socket is protected by its mode (`0600`, owner only). A loopback port is not: any local user
can connect, and these are shared login nodes — `prenyx` had 219 users logged in. The token is
therefore not optional.

Accepted exposure: `/readyz` and `/healthz` are unauthenticated, so any local user can fingerprint
the port. That buys liveness checks without handing the token to the prober, and reveals nothing
beyond "a codex app-server is here".

## Shape

The decision, the detection and the secret all live on the remote host, because that is where the
knowledge and the authority already are. QiYan learns one thing: the bearer token for its handshake.

### Starting

`start` runs the unix launcher exactly as today and polls as today. **After** the poll window expires
without reaching `healthy`, one extra question is asked: is the socket path a symlink of exactly the
codex-daemon shape whose target does not resolve? If so, this host redirects into a `/tmp` we cannot
see; the helper tears the generation down and restarts it as `ws`, in the same call.

"Exactly the codex-daemon shape" means the shape `privateSocketIdentity` already encodes: a uid-owned
link into `/tmp/codex-daemon-<uid>/` with a 64-hex basename, under a `0700` uid-owned daemon
directory. Reuse that check rather than accepting any broken link — a stray symlink or a half-cleaned
runtime directory must not migrate a healthy host to ws, which is the outcome the "after the window"
rule exists to prevent. The check runs on the timeout path only; an immediate launcher failure breaks
out as `absent` and leaves no symlink to inspect.

The check belongs *after* the window, not inside the loop. Codex creates the link and its target in
an order we have not pinned and do not control; a momentary "link present, target missing" during a
normal boot would otherwise migrate `prenyx`, `ptyche` and `polyphe` to ws silently — still working,
but on the wrong transport, with file-mode access control traded away on hosts that never needed it.
The symptom this design keys on is the *persistent* resolution failure, so it is tested once, when
persistence is established.

For a `ws` start the helper, not QiYan:

1. mints a **fresh** runtime token for the new generation — not a reuse of the unix generation's
   token, so an unreapable straggler cannot satisfy `processHasToken` for the replacement,
2. mints ≥128 bits of capability token with `randomBytes` and writes `app-server.token` via
   `atomicWrite(…, 0o600)` **before** the launcher starts, and
3. invokes the launcher with an explicit `ws` mode argument and the hex SHA-256 digest.

The launcher adds `--listen ws://127.0.0.1:0 --ws-auth capability-token --ws-token-sha256 "$digest"`.
It never receives the token itself, and `--ws-token-file` is deliberately unused: the digest already
authenticates, and a path in argv buys nothing.

The token must never ride the `start` request. That payload is base64url **in argv of the remote node
process**, and `/proc/<pid>/cmdline` is world-readable; base64 is not secrecy. The digest in argv is
fine — a SHA-256 of 128 random bits is not sensitive. The token is regenerated per generation, so a
leaked secret cannot authenticate a later server.

#### Tearing down the generation we just created

The teardown must be provably of *our* generation, never of a live runtime belonging to another
instance. Three facts together make it so:

- `start` runs `tmux new-session` **without** `allowFailure`, and `new-session` fails on a duplicate
  name. A successful creation is therefore a mutex: no other party holds a generation under this
  session name in this runtime directory.
- The pre-existing guard already refuses when the prior `inspect` reports `unhealthy`, so a
  concurrent second instance cannot reach the teardown at all.
- The direct proof: the launcher writes the token this call passed it into `identity.json`. The
  teardown proceeds **only** when the identity it reads carries exactly that token and
  `identityMatches` passes. Today's poll loop never compares against the token it sent — harmless
  while the loop only reads, load-bearing the moment it kills.

`stop` throws when survivors remain and the server is still alive. Inside `start` that must surface
as a legible failure, neither swallowed nor retried in a loop.

### Connecting

`RuntimeIdentity` is **unchanged**. It is an equality-compared value round-tripped as `expected`, and
`src/endpoints/types.ts` parses it with a `.strict()` discriminated union — an extra key would make
`parseRuntimeIdentity` throw on every call. An address is not an identity.

The listener kind is carried by the **presence of the capability token**: a ws generation has
`app-server.token`, a unix generation does not. There is no third state, and the invariant that makes
this safe is explicit: **`proxy-app-server` on a generation whose token is missing or unreadable
fails loudly; it never degrades to an unauthenticated connect.** Without that rule a dropped token
would quietly attempt a unix-shaped handshake and surface as a distant 401.

Because the marker is also the secret, `start`'s pre-clean must unlink `app-server.token` alongside
the socket and identity. A token left behind by a ws generation that died without a clean `stop`
would otherwise make the *next*, unix generation classify as ws and look for a port that does not
exist — unhealthy forever.

`SshRuntime` obtains the token from the `start`/`inspect` round trip inside `ensureStarted` and holds
it for the generation's lifetime, handing it to `openAppServerStream`. On the `healthy` short-circuit
`start` is never called, so **`inspect` returns the token too**. `inspect` runs from `prepare()` for
both the shared and legacy runtime directories and on every `classifyLoss` and `runtimeIdentity`, so
the "nothing logs this payload" obligation covers considerably more call sites than `start` alone. A cached token that outlives its generation fails closed — a 401
and a reconnect — which is acceptable and intended.

The helper's `proxy-app-server` gains one `connect` arm. The byte pipe, the readiness preamble and
the before/after identity proof are untouched; only the connect target varies. QiYan's side gains one
header: `WebSocketWire.connectStream` already performs the HTTP/1.1 upgrade locally over the piped
stream, so it takes `headers: { Authorization: \`Bearer ${token}\` }`. The remote helper is a byte
pipe and can never add a header — which is why the token has to reach QiYan rather than stay remote.

### Finding the port

The port is **derived from the process, never recorded.** The derivation runs fd-set first: read
`/proc/<identity.pid>/fd`, collect the `socket:[inode]` entries, and intersect them with the rows of
`/proc/net/tcp` that are state `0A`, have `rem_address 00000000:0000`, a loopback local address
(`0100007F`, or `::1` in `tcp6`), and our uid.

Codex holds one listening socket today, but a future version could hold a second — a code-mode host,
an MCP HTTP transport — and picking arbitrarily would aim the proxy at a service the bearer token
does not authenticate, surfacing as an unrelated handshake error. So among the candidates, take the
one whose `GET /readyz` returns 200; if zero or more than one qualifies, report unhealthy. That fails
closed and survives a multi-listener codex without a special case. Child processes do not pollute the
set: fds flow parent to child, and only `identity.pid` is scanned.

This is authoritative, impossible to lose, and self-invalidating when the process dies. The
alternative — parse codex's `listening on:` banner and persist it — introduces a window between the
bind and the write in which a dropped channel or an aborted `start` leaves a live ws generation with
no recorded address, which every later `inspect` reads as unhealthy while `serverAlive` stays true:
the same unrecoverable wedge this document exists to end, on a narrower window. Deriving it also
removes any dependence on `capRuntimeLog` truncation, on `2>&1` interleaving in the log, and on
Rust's stdout buffering.

### Attestation

| property | `unix` | `ws` |
| --- | --- | --- |
| only we can connect | mode `0600` | capability token, `0600` file |
| it is *our* runtime | socket is private and uid-owned | true by construction: the port is derived from `identity.pid`'s own fd set |
| nothing swapped under us | socket inode compared before/after | identity re-read after connect |

Ownership needs no separate check: deriving the port from `identity.pid`'s own fd set makes it
`identity.pid`'s port by construction. Nobody should write that proof a second time. The inode
comparison on the unix side is a *swap detector*, not an ownership proof, and its ws counterpart is
the identity re-read: an established TCP connection cannot have been accepted by a different process,
so a port derived at connect time plus an unchanged identity afterwards gives the same guarantee.

Never scan all of `/proc` — on a 219-user login node that is thousands of unreadable directories per
connect. Do not shell out to `ss`: it is in no capability probe.

### Health

`inspect` today calls a runtime `healthy` only if the socket file exists, is uid-owned and `0600`. A
ws generation creates no socket file, so without a second arm it is `unhealthy` forever, `start`
never sees `healthy`, and `ensureStarted` refuses on every later call. The predicate becomes, per
kind:

- **unix** — unchanged: socket file private and uid-owned, plus `socketListening`.
- **ws** — `app-server.token` present and readable, a port derived for `identity.pid`, and
  `GET /readyz` returning 200 under an explicit timeout in the same spirit as `socketListening`'s
  2 s. An unbounded GET inside `inspect` would stall the poll loop.

`readyz` is stronger than a completed TCP connect: it reports the server ready, not merely bound.

`inspectSchema` is `.strict()`, so the new facts are added there with the existing
omission-means-not-proven semantics, keeping older helpers working. `unservingSupervisor` keeps
identical semantics across kinds: a ws runtime with `serverAlive: false`, `readyz` failing, and a
session older than `UNSERVING_SUPERVISOR_MIN_AGE_MS` is reclaimable.

That reclaim path turns on one easily-missed detail. `unservingSupervisor` requires the serving fact
to be **`false`**, not absent — omission means "not proven", deliberately, so old helpers keep
working. So a ws generation whose process has died, and whose port therefore cannot be derived, must
report the fact as `false`. Omitting it instead would make a dead ws runtime permanently
unreclaimable: exactly the wedge this guard exists to break, and exactly the shape that passes every
test written against a live runtime. The kind is still known in that state because the marker is the
token file, which is independent of the process.

The converse shape — process alive, no derivable loopback listener — stays unhealthy and supervised,
so `ensureStarted` and `start` both refuse. That mirrors what unix already does with a live process
and a missing socket file, and the `readyz` disambiguation above makes it unlikely, but it is a real
dead end rather than a self-healing one.

### The launcher's new arguments

`qiyan-app-server-launcher.sh` validates every parameter against an explicit character class before
use, and the new ones get the same discipline: the digest as `[0-9a-f]{64}`, and the listener mode as
an explicit validated argument rather than inferred from "a digest was passed". Inside `/bin/sh` with
`set -eu`, inference is how an empty variable becomes a silently unauthenticated listener. In `ws`
mode `socket_path` is still passed and still validated — it is the path whose dangling link triggered
the mode — but is not handed to codex.

### Cost

On an affected host every cold start spawns, kills and respawns a codex: double the start latency
plus the teardown's own cost — `stop` performs two `waitForEmptyGroup(2_000)` waits, so up to ~4 s on
top — recurring on every start because the design deliberately keeps no memory. Against the <15 s
startup goal that is the price of self-healing — a host that stops isolating `/tmp` recovers by
itself on the next start — and it is paid only by hosts showing the symptom.

### Why not persist the choice per endpoint

An earlier draft marked the endpoint `ws` in the binding store. That is the wrong cut:

- `EndpointBindingStore` holds one column, `destination_sha256`, and `SshRuntime` has no `Database`
  handle — persisting a listener choice means a migration, a second concern in a store named for
  destination binding, and a new callback threaded through.
- It cannot fire on a fresh `lyris` endpoint. The first `unix` start leaves a **live** codex and tmux
  behind; the next `inspect` reports `unhealthy` with `supervised` and `serverAlive` true, so the
  reclaim guard — correctly — refuses to tear it down, and the endpoint wedges exactly as it does
  today. Moving to ws requires tearing down a live generation, i.e. the restart the draft claimed to
  avoid.
- Its clearing rule was unreachable: once marked `ws` an endpoint never starts on `unix` again, so
  "cleared on a successful `unix` start" could never execute.

### Why not `ws` everywhere

One code path is cheaper to maintain, but it moves `prenyx`, `ptyche` and `polyphe` off a transport
that works, and trades file-mode access control for a token on every host to fix a problem one host
has.

## Scope

- **Claude host: unaffected.** `qiyan-claude-host.mjs` binds `claude.sock` with node's own
  `createServer` in the runtime directory at `0600`. There is no codex daemon redirect in that path,
  so `openClaudeHostStream` needs no ws arm as long as the precondition above holds.
- **Web UI remote file access: unaffected.** It uses the `read-file` / `read-rollout-slice` /
  `workspace` helper operations, not the app-server socket.
- **`stop` / `reclaim`:** `rm(socketPath, { force: true })` on a missing path is already a no-op; the
  only addition is removing `app-server.token`.
- **Port already taken:** a non-issue. `:0` means the kernel picks a free port, and a port that is no
  longer ours is caught by the pid check.
- **Asset digests:** `REMOTE_HELPER_SHA256` and `REMOTE_LAUNCHER_SHA256` must be regenerated or
  `loadRemoteAssets` hard-fails.

## Test plan

Each claim gets a test that fails if the claim is removed. The existing helper tests already run the
real helper against a stub `codex` on a fake PATH; the stub gains a mode that binds a loopback port,
speaks the WebSocket upgrade and enforces the bearer check.

- a handshake **with** the token reaches `101`; **without** it the connect fails — the defect that
  would make the whole feature unusable
- a ws generation whose token is unreadable **refuses** the proxy rather than connecting unauthenticated
- the digest reaches the launcher's argv and the token never does
- a persistently dangling symlink triggers the ws restart; a link created *before* its target, then
  resolving, triggers **no** restart
- a `start` aborted after the port is bound still yields a reachable endpoint on the next `inspect`
- a second concurrent `start` against a live generation is refused rather than tearing it down
- a `start` over a stale `app-server.token` yields a working unix generation
- a `ws` generation reaches `healthy` through `inspect`, and `start` completes on it
- a listening port owned by a different pid is refused
- a ws generation whose process has died is **reclaimed** rather than refused — the one path that
  exercises reporting the serving fact as `false` rather than omitting it
- `readyz` failure reports unhealthy rather than absent
- an old helper that reports none of the new `inspect` facts still works as unix
- `stop` removes the token

Integration coverage is the existing SSH worker fixture, run once per listener kind.

# Remote workspace validation — kill the per-op ssh storm

## Root cause (measured)

For a remote (ssh) session, workspace validation makes **~72 sequential ssh helper calls** at
startup (endpoint recovery) and on **every turn dispatch / file op**. Each call is a fresh remote
`node qiyan-ssh-helper.mjs <op>` cold-start (~0.5s), so it serializes into minutes at startup and
adds latency to every remote turn. The ssh transport itself is fast (0.78s); it's the op *count*.

Three compounding causes:

1. **`policyFor(endpointId)` builds a fresh `ProjectWorkspacePolicy` + `SshHost` on every call**
   (production-app.ts:2585-2601) — no memoization — so every validation re-resolves everything.
2. **`assertDispatchable(prepared)` re-does the full resolve + safety check** (project-workspace.ts:76-93):
   `lstat` + `realpath` + `assertSafe` + `lstat` + `realpath` — even though `prepared` already carries
   the canonical `path` and the `device`/`inode` `identity` from when it was prepared.
3. **`assertSafe`** (project-workspace.ts:143-155) re-resolves the user home + the (deduped) protected
   paths (`qiyanHome`/`assistantWorkdir`/`dataDir` = the remote runtime dir, `registryPath`) on every
   call via `projectedCanonical` — those paths are **constant**.

`assertDispatchable` runs on every turn start/steer (lifecycle.ts), every recovery sub-step
(production-app.ts:3925, lifecycle.ts:258-331), and every worker file op (worker-file-bridge.ts).

## Fix (surgical — no new helper op, no backgrounding)

### 1. `assertDispatchable` → one identity `lstat` (+ the now-free `assertSafe`) — the big hot-path win

Keep the identity check + the (post-#3, ssh-free) safety check; drop only the genuinely redundant
re-`realpath` and the double read:

```
if (!validIdentity(prepared.identity.device) || !validIdentity(prepared.identity.inode)) throw managedError(...);
const value = await optionalWorkspaceEvidence(() => this.host.lstat(prepared.path));  // ONE ssh round-trip, mapped
if (value?.kind !== "directory"
    || value.device !== prepared.identity.device
    || value.inode  !== prepared.identity.inode) throw managedError("project workspace changed unexpectedly");
await this.assertSafe(prepared.path);   // prepared.path is already canonical; ssh-free after #3
```

- **Why the identity check is the real guarantee:** final-component swap → `kind:"symlink"`≠directory;
  final rename → different inode; intermediate-ancestor symlink → `lstat(path)` resolves a different
  inode (the only inode-preserving case is a bind-mount/symlink back to the *same* directory ⇒ same
  content ⇒ safe). So re-`realpath(prepared.path)==prepared.path` catches nothing exploitable that the
  inode check misses; drop it and the paranoid double lstat/realpath (the residual race vs. the actual
  `thread/start` dispatch exists regardless of read count). **~12 ssh ops → 1.**
- **Keep `assertSafe(prepared.path)`, do NOT drop it** (reviewer): after #3 it's cached string
  `contains`/`overlaps` comparisons — **0 ssh round-trips** — and it is the *sole* safety re-validation
  on the recovery path (production-app.ts:3925 dispatches a checkpoint-reconstructed workspace that
  never went through `prepareExisting`). `assertSafe` takes the already-canonical `prepared.path`
  directly (no `realpath` needed).
- **Keep the error mapping + `validIdentity` guard:** wrap the `lstat` in `optionalWorkspaceEvidence`
  so a transient ssh/helper throw maps to `managedError`/`CONFIGURATION_ERROR` (callers like
  `verifyCwd` map that to `CWD_MISMATCH`) instead of propagating raw. `lstat` returns `{kind:"missing"}`
  (truthy) on ENOENT, so the `kind !== "directory"` check covers deletion. Identity compares are
  canonical-decimal strings from the same helper (`dev.toString(10)`/`ino.toString(10)`) — keep that
  invariant; a mismatch fails safe (reject).

### 2. Memoize the workspace policy per endpoint (production-app `policyFor`)

Cache the `ProjectWorkspacePolicy` (+ its `SshHost`) per endpoint id, keyed on the endpoint
**generation** so it's dropped on reconnect/replacement (the remote runtime dir / home can change).
The generation key is correct: `remoteContexts` is only set in `bindProjectEndpoint(target, generation)`,
and each generation is a fresh remote context/host. Local endpoints already return the shared
`projectWorkspaces` — only the remote branch rebuilds. The real benefit isn't ssh savings (object
construction is local) — it's letting #3's per-instance cache **survive across the many validations in
one recovery/turn**.

**Must retain `ensureReady`:** the memo still calls `await endpointManager.ensureReady(id)` and keys on
the freshly-read `endpointGeneration(id).generation` before returning a cached policy — a cache hit must
never hand back a policy bound to a torn-down transport. Lease fencing is unaffected (the router still
runs `requireLease` around each op).

### 3. Cache the resolved protected/home paths in `ProjectWorkspacePolicy`

`assertSafe` resolves `requestedUserHome` + the protected set once and memoizes the
`projectedCanonical` results on the policy instance; subsequent `assertSafe`/`resolveUserPath` reuse
them. These paths are stable for the life of an endpoint generation. **Cache only *successful*
resolutions** (`projectedCanonical` can walk-up/throw for a not-yet-existing path — never memoize a
failure). The protected set dedupes to just two constants — `userHome` and the remote runtime dir
(`qiyanHome`==`assistantWorkdir`==`dataDir`==`registryDir`==runtimeDir). `resolveUserPath` also
`realpath`s `userHome` unconditionally (even for absolute inputs), so caching home removes 1 ssh op
from every `prepareCreate`/`prepareExisting`. `prepareCreate`/`prepareExisting` still resolve the
*project* path fresh (it's the untrusted input).

### 4. Dedupe the repeated project-path resolution within one recovery (reviewer finding)

`reconcileManaged` (lifecycle.ts) resolves the **same** project path ~3× per session recovery
(`prepareExisting` at :329, `verifyCwd`→`prepareExisting` at :365 and :420) plus `assertDispatchable`
×2. After #1–#3 that's still ~3×~5 + 2×1 ≈ 17 ssh ops for one session — above "seconds". Resolve the
project path **once** per reconcile and thread the `PreparedProjectWorkspace` through (or a per-lease
memo), so the repeat resolutions collapse. This is the largest remaining per-session cost.

## Why this is safe

- The device/inode identity check is the real anti-tamper guarantee; #1 keeps it and drops only work
  that an unchanged identity already implies.
- #2/#3 cache only **constant** paths (the user home + QiYan's own runtime dirs). A stale cache would
  mislead only if a *protected* path were moved/symlinked mid-generation — not a realistic threat
  (they're QiYan-owned), and any *project*-dir tampering is still caught by #1's identity check.
- No change to `prepareCreate`/`prepareExisting`'s resolution of the untrusted project path, nor to
  the local-fs path (fast already).

## Expected effect

Startup endpoint recovery and every remote turn drop from dozens of ssh round-trips to a handful:
`assertDispatchable` 1 op; `prepareExisting` resolves only the project path once (protected cached +
per-reconcile dedup). **Scope the claim honestly:** the measured ~72 also includes non-workspace ssh
ops this change does NOT touch — `prepareRemoteHost` preflight/bootstrap, and the ownership/transcript
`rollout-scan`/`claude-rollout-scan` for remote sessions. So the target is the *workspace* share going
from the bulk of ~72 to a few per session; verify by counting per session. For the current single
remote session, expect startup to drop from ~5 min to single-digit seconds. (A batched `resolve`
helper op could collapse `prepareExisting` further, but isn't needed to hit the target; deferred.)

## Files

- `src/sessions/project-workspace.ts` — `assertDispatchable` (identity `lstat` + retained `assertSafe`,
  drop realpath/double-read, keep error mapping + `validIdentity`); `assertSafe`/`resolveUserPath`
  cache the constant resolutions (success-only) on the policy instance.
- `src/production-app.ts` — memoize `policyFor` per endpoint id + generation (still `ensureReady`).
- `src/sessions/lifecycle.ts` — `reconcileManaged` resolves the project path once + reuses it (#4).

## Tests (`tests/sessions/project-workspace.test.ts` + lifecycle)

- `assertDispatchable`: accepts an unchanged dir (identity match); rejects a swapped inode, a symlink
  swap (kind), an **intermediate-ancestor symlink** swap (different resolved inode), and a deletion
  (`kind:"missing"`); a transient host `lstat` throw maps to `managedError` (not raw propagate);
  **rejects a dir that now overlaps the protected set** (proves `assertSafe` is retained); a
  recovery-reconstructed `prepared` with a mismatched device/inode is rejected.
- `assertSafe`/`resolveUserPath` resolve the protected set + home **once** across repeated calls
  (spy the host call count); a failed resolution is not memoized.
- Policy memo: a fresh endpoint generation rebuilds the policy (stale `runtimeDir` not reused).
- `prepareExisting` still detects a *moved* project dir with caching on (project path resolved fresh).
- `reconcileManaged` resolves the project path once per recovery (host-call-count assertion).

## Measurement

Re-run the startup trace (`ps`-count remote `qiyan-ssh-helper` invocations) before/after and record
the op count + wall-clock in this doc.

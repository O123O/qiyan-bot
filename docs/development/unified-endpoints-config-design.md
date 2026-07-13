# Unified endpoint configuration

## Problem

Endpoint configuration is split and the type field conflates two orthogonal concerns:

- **Split config.** A *local* Claude endpoint is configured via `.env`
  (`CLAUDE_CODE_ENDPOINT_ID`, `CLAUDE_CODE_MODEL`, `CLAUDE_BINARY`), while every
  *remote* endpoint lives in `endpoints.json`. Two places, two formats, for the
  same concept.
- **Conflated `type`.** `endpoints.json` entries use `type: "ssh" | "claude-code"`,
  which bundles **transport** (local vs ssh) with **provider** (codex vs claude):
  `"ssh"` really means "codex over ssh" and `"claude-code"` means "claude over ssh".
  There is no way to say "claude, locally" or to set a remote worker's model.

## Goal

One place, one format. Every configurable worker endpoint is declared in
`endpoints.json` with **orthogonal** `provider` and `transport` fields, plus
per-endpoint model/effort. No `.env` endpoint config.

Non-goals / decisions (confirmed with the user):
- **No backward compatibility.** There is no other user; a pre-existing
  differently-shaped file simply fails the normal schema validation (no special
  "please migrate" message, no auto-rewrite). The live `endpoints.json` and the
  test fixtures are rewritten by hand as part of this change. This is *the*
  schema, not "v2".
- **Built-ins stay implicit.** The default local Codex worker (`local`) and the
  assistant's own runtime (`assistant-local`) remain reserved built-ins, not
  entries in `endpoints.json`. "Unified" means all *configurable* endpoints.

## The schema

`endpoints.json` (`<qiyan_home>/endpoints.json`, mode 0600):

```jsonc
{
  "version": 1,                       // format marker only (not a migration anchor)
  "endpoints": {
    "local-claude": {
      "provider": "claude",           // "codex" | "claude"
      "transport": "local",           // "local" | "ssh"
      "model": "opus",                // optional (claude only)
      "effort": "high"                // optional (claude only)
    },
    "dfw-codex": {
      "provider": "codex",
      "transport": "ssh",
      "host": "dfw-vscode",           // ssh alias (required for ssh transport)
      "projects_root": "~/qiyan-projects"
    },
    "dfw-claude": {
      "provider": "claude",
      "transport": "ssh",
      "host": "dfw-claude",
      "model": "sonnet"
    }
  }
}
```

### Fields

| field          | provider | required            | notes |
|----------------|----------|---------------------|-------|
| `provider`     | both     | yes                 | `codex` \| `claude` |
| `transport`    | both     | yes                 | `local` \| `ssh` |
| `host`         | both     | iff `transport:ssh` | ssh alias (resolvable via `~/.ssh/config`); **forbidden** for `local` |
| `projects_root`| both     | no                  | absolute or `~/…`; default `~/qiyan-projects` |
| `model`        | claude   | no                  | per-endpoint model (closes the M2 gap); rejected for codex |
| `effort`       | claude   | no                  | per-endpoint reasoning effort; rejected for codex |
| `command`      | claude   | no                  | claude binary; default `claude`; rejected for codex |

Map key = endpoint **id** (arbitrary, `^[a-z0-9][a-z0-9_-]{0,63}$`, and not the
reserved `local`/`assistant-local`). The id is now decoupled from the ssh alias
(`host`), which was previously the key.

### Validation (zod, discriminated on `provider`, `.strict()`)

- `provider: "codex"` ⟹ `transport` **must** be `"ssh"` (via `z.literal("ssh")`)
  with `host` required. A local Codex worker is the built-in `local` endpoint;
  `codex`+`local` fails the literal with zod's ordinary message (no special
  "use the built-in" text — consistent with "no special rejection message").
  `model`/`effort`/`command` are rejected for codex (strict).
- `provider: "claude"` ⟹ `transport` `local` (no `host`, **no `projects_root`** —
  local claude uses `projectWorkspaces`, so `projects_root` would be inert;
  forbid it) or `ssh` (`host` required). `model`/`effort`/`command` allowed.
- A `.refine` enforces the host↔transport correspondence; `.strict()` rejects
  unknown keys (as today).
- **At most one** `provider:claude, transport:local` entry (the local Claude
  endpoint is singular — see M3). Enforced at startup with a clear error, not in
  the per-entry zod schema (it is a cross-entry invariant).

### Shared hosts

Two endpoints may resolve to the same host (the live setup already has
`dfw-vscode` and `dfw-claude` as distinct ssh aliases for one machine). This is
fine and unchanged: the ControlMaster `controlPath` is host-derived (shared per
host), the remote runtime dir is **id**-hashed (isolated per endpoint), and the
identity binding is **id**-keyed (see C1). No duplicate-`host` rejection.

### Allowed combinations

| provider | transport | result                              |
|----------|-----------|-------------------------------------|
| claude   | local     | local `claude -p` worker (was `.env`) |
| claude   | ssh       | remote `claude -p` worker (was `type:"claude-code"`) |
| codex    | ssh       | remote Codex app-server (was `type:"ssh"`) |
| codex    | local     | **rejected** — that is the built-in `local` |

## Code changes

### `src/endpoints/catalog.ts`
- Replace the `type`-discriminated `entry` schema with the `provider`/`transport`
  schema above.
- `RemoteEndpointDefinition` → carry `provider`, `transport`, optional `host`,
  `projectsRoot`, and claude-only `model`/`effort`/`command`. Keep discriminating
  by provider for the consumer branches.
- Add a `localClaudeDefinitions()` (or have the catalog expose *all* definitions,
  including `transport:local`) so production-app can build local Claude builtins
  from the catalog. `require(id)` still resolves any non-built-in id.
- Reserved-id rejection unchanged.

### `src/config.ts` / `src/config-source.ts`
- Delete `CLAUDE_CODE_ENDPOINT_ID`, `CLAUDE_CODE_MODEL`, `CLAUDE_BINARY` env keys,
  the `ClaudeCodeConfig` interface, and `config.claudeCode`. Remove them from
  `SUPPORTED_DOTENV_KEYS` (`config-source.ts`) and from `.env.example`.
- Extend `claudeLaunchPolicy(model?)` → `claudeLaunchPolicy(model?, effort?)` to
  thread the per-endpoint effort into `ClaudeLaunchFlags.effort`.
- `CLAUDE_DISABLED_TOOLS` / `CLAUDE_REDIRECT_PROMPT` stay.

### `src/production-app.ts`
- **Local Claude (singular, M3).** No longer built from `config.claudeCode`. At
  startup, find the (at most one) catalog entry with `provider:claude,
  transport:local` and build a local `ClaudeCodeRuntime` (`LocalClaudeCommandRunner`)
  builtin from it — reusing the exact single-endpoint wiring that exists today
  (`localEndpointId` scalar, `builtinEndpoints: [claudeEndpoint]`,
  `subscribeClaudeGoalDriver`, `monitorCheckRunners.set`, the built-in collision
  guard), applying `claudeLaunchPolicy(entry.model, entry.effort)`. A SECOND such
  entry is rejected at startup with a clear error. Keeping it singular avoids
  looping every one of those scalar-assuming sites for a case the user doesn't have.
  **Local-claude changes require a restart** (builtins are frozen from the startup
  snapshot; the manager's `builtins` map is not rebuilt on `catalog.reload()`).
- **`createRemote`** branch (2405): switch `definition.type === "claude-code"` to
  `definition.provider === "claude"`; codex branch is `provider === "codex"`.
  **Reject `transport:local` loudly here** (M1) — a local entry added to
  `endpoints.json` after startup is not in the frozen `builtins` map and would
  otherwise fall through to `createRemote` and be mis-run as remote ssh with no
  `host`. Read `definition.model`/`effort` into the remote launch policy
  (per-endpoint, closing M2).
- **The ssh planner (C1 — critical).** `SshGenerationPlanner.createGeneration`
  currently takes one `endpointId` used for BOTH the ssh alias (`ssh -G`, the
  host-derived `controlPath`) and the identity-binding key (`hasReferences`,
  `checkExisting`, the returned `pendingBinding.endpointId`). These now diverge.
  Split the signature to `createGeneration(id, host)`: **`host`** drives `ssh -G`
  + `planSshConnection` (controlPath); **`id`** stays the binding/reference key
  (`hasReferences(id)`, `checkExisting(id, …)`, `pendingBinding:{endpointId:id}`)
  and the runtime-dir hash (`prepareRemoteHost({endpointId:id})` — already id-keyed,
  unchanged). The single call site `createGeneration(definition.id)` becomes
  `createGeneration(definition.id, definition.host)`. Do NOT let the binding become
  host-keyed — that would defeat the `ENDPOINT_IDENTITY_CHANGED` guard and let two
  ids on one host collide.
- **`sessionProvider(endpointId)`** (3417): return `claude` when the catalog entry
  has `provider:claude` (local-claude is now itself a catalog entry, so the single
  catalog lookup covers it); built-ins `local`/`assistant-local` are codex. Drop
  the `config.claudeCode` check.
- **`isLocal(endpointId)`** (159): built-in `local`, OR a catalog entry with
  `transport:local`. Replaces the `localClaudeEndpointId` scalar. (Do not add
  `assistant-local` — it is not treated as local today and never reaches these
  predicates.)
- **Launch policy**: the single global `claudeLaunchFlags` const becomes
  per-endpoint `claudeLaunchPolicy(entry.model, entry.effort)` (local builtin from
  its entry; remote from `definition`).
- Guard: a catalog claude id colliding with a reserved built-in already rejected;
  keep it.

## Tests to update (rewrite fixtures to the new schema)

- `tests/endpoints/catalog.test.ts` — new schema + all validation rules
  (provider/transport combos, host required/forbidden, codex+local rejected,
  model/effort codex-rejected, unknown-key strictness).
- `tests/config.test.ts` — drop the CLAUDE_CODE_* env expectations; keep the
  `claudeLaunchPolicy` test (extend for effort).
- `tests/production-app.test.ts`, `tests/endpoints/manager.test.ts`,
  `tests/endpoints/worker-file-bridge.test.ts`, `tests/app-server/pool.test.ts`,
  `tests/endpoints/claude-models.test.ts` — update any `type:"ssh"/"claude-code"`
  fixtures + `config.claudeCode` usages.
- `tests/endpoints/endpoint-locality.test.ts` — asserts the OLD scalar
  `isLocalEndpointId(id, localClaudeEndpointId)` signature; rewrite for the
  catalog-driven `transport:local` predicate.
- `tests/config-source.test.ts` — the dotenv-key pinning test is derive-based, so
  it stays green after the key removal, but it is the guard for
  `SUPPORTED_DOTENV_KEYS`; re-run to confirm.
- `tests/integration/mcp-production-actions.test.ts` — the acceptance harness now
  declares the local Claude endpoint via `endpoints.json`
  (`{ provider:"claude", transport:"local" }`, id `claude-local`) instead of
  `config.claudeCode`, and the remote entries in the new shape
  (`dfw-vscode` → codex/ssh, `dfw-claude` → claude/ssh). Behavior unchanged.
- Add a focused test that a `provider:claude, transport:ssh, model:"…"` entry
  reaches `claude -p` as `--model` (per-endpoint model, the M2 close).

## Migration of live/hand files (done in the PR, not in code)

- `/home/mxin/.qiyan-bot/endpoints.json`: rewrite `dfw-vscode` → `{provider:codex,
  transport:ssh, host:dfw-vscode, projects_root:…}`, `dfw-claude` → `{provider:
  claude, transport:ssh, host:dfw-claude, projects_root:…}`, and ADD `claude-local`
  → `{provider:claude, transport:local}` (replacing `CLAUDE_CODE_ENDPOINT_ID`).
- `/home/mxin/.qiyan-bot/.env`: remove `CLAUDE_CODE_ENDPOINT_ID` (and any
  `CLAUDE_CODE_MODEL`/`CLAUDE_BINARY`).

## Risks

- Missing a consumer of `.type`/`config.claudeCode` → a Claude endpoint silently
  treated as Codex. Mitigation: `sessionProvider` is the single provider oracle;
  grep confirms `.type === "claude-code"` appears only at production-app.ts:2405
  and :3417 plus the catalog. tsc will catch the `ClaudeCodeConfig` removal.
- Local-claude-from-catalog changes startup ordering (built from the catalog
  snapshot rather than a config field). Must still register as an
  `EndpointManager` builtin before leased manager tools run (as today).
- Acceptance test must still pass end-to-end (local + remote), proving the rewiring.

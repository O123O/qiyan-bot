# Manager MCP Approval Fix Plan

**Goal:** Let the non-interactive coordinator call its authenticated manager MCP tools without Codex rejecting the call at an approval prompt.

## Root cause

The live coordinator attempted `prepare_chat_attachment` twice. Both Codex tool results were `user rejected MCP tool call`, while the durable backend operation ledger recorded no attachment operation. The manager handler therefore never ran.

The coordinator thread uses `approvalPolicy: "never"` with the production default `workspace-write` sandbox, while `coordinatorTurnConfig()` configures the private manager MCP server without `default_tools_approval_mode`. Omission selects Codex's `auto` mode. Because these MCP tools have no safety annotations, pinned Codex 0.142.4 conservatively treats them as approval-requiring; a non-interactive `never` thread rejects that request.

This server is intentionally safe to pre-approve only if its transport boundary is exact: it is loopback-only, requires an in-memory bearer token, requires an active durable source context, validates every typed tool argument, and records state-changing effects in the operation ledger. Project app-servers do not receive the bearer token or manager MCP configuration.

The bearer token is not a sufficient boundary by itself. A same-user coordinator shell can recover an ancestor app-server environment through `/proc`. After initialization, `LocalEndpoint` must resolve the exact protocol process identity (PID plus `/proc` start time): use the spawned root when it has no child (a directly launched native binary), or its sole direct child for the pinned Node-wrapper/native-child layout. Multiple children or deeper launcher layers are unsupported and must fail closed. The loopback server then accepts a socket owned by that exact live process identity only, validating start time before and after inspecting descriptors to reject PID reuse. Model-launched descendants remain unauthorized even when they recover the token. The real manager integration must continue to prove that the trusted client works.

## Test-first implementation

1. Add a regression assertion in `tests/mcp/server.test.ts` that the `codex_bot_manager` server config has `default_tools_approval_mode: "approve"`, while retaining the existing assertion that the bearer token value never appears in serialized config.
2. Change the real integration test's coordinator sandbox from `danger-full-access` to the production default `workspace-write`. Keep its `approvalPolicy: "never"`, exact one-call assertion, and shell token-hiding check.
3. Run the focused unit test and the opt-in real integration before changing production code. Confirm the unit assertion fails because the field is absent and the real manager call is rejected before reaching the handler.
4. Add only `default_tools_approval_mode: "approve"` to the `codex_bot_manager` entry returned by `coordinatorTurnConfig()` in `src/mcp/server.ts`.
5. Add Linux process-boundary regression tests that start the loopback MCP server with a dynamically selected exact allowed process identity, prove that process reaches the expected authorized-path HTTP status, prove a mismatched start time receives HTTP 403, and prove its token-bearing child receives HTTP 403. Add resolver tests for direct-native, wrapper/native-child, and ambiguous launcher topologies. Confirm the descendant assertion fails while arbitrary descendants are still authorized.
6. Resolve and expose the exact protocol identity from `LocalEndpoint` after successful initialization, bind it to that child generation, and clear it on stop, exit, startup failure, and unavailability. After the resolver await, verify the captured child/client are still current and the endpoint is still starting before publishing identity or ready state. Add exit-during-resolution and stop-during-resolution tests, and extend the existing delayed-old-child restart test to prove an old generation cannot clear or replace the new identity. Change production and integration wiring to use that identity, and require the request socket owner and start time to match it exactly before and after descriptor inspection.
7. Rerun the process-boundary tests and real manager integration; the former proves shell descendants and stale endpoint generations are denied, while the latter proves the pinned trusted app-server process remains accepted.
8. Update the real integration test name and prompt so it claims only the properties actually proved: the approved manager call reaches the handler under `workspace-write`, and the serialized manager config does not contain the bearer token. Do not claim the shell cannot recover an ancestor environment.
9. Exercise the existing worker endpoint fixture with an isolated temporary `CODEX_HOME`: start a worker thread without manager config, exhaustively page `mcpServerStatus/list` for that thread, and assert the reserved `codex_bot_manager` name is absent.
10. Rerun focused tests, typecheck, the full test suite, the real Codex MCP integration, and the package smoke test.

## Review and deployment

1. Have two agents review the change, focusing separately on Codex configuration semantics and on security/isolation regression risk.
2. Resolve all findings and repeat review until clean.
3. Fast-forward local `main`, rebuild and pack the distributable artifact, install it under `$HOME/.local`, and verify the installed command.
4. Gracefully stop the current installed bot, back up effective data, registry plus `.last-good`, and coordinator state, then restart from the newly installed binary with the existing secret environment.
5. Verify the binary process, both app-server children, managed policy digest, and version-2 dashboard. The user can then repeat the Telegram attachment request as the final end-to-end chat assertion.

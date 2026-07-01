# Manager MCP Approval Fix Plan

**Goal:** Let the non-interactive coordinator call its authenticated manager MCP tools without Codex rejecting the call at an approval prompt.

## Root cause

The live coordinator attempted `prepare_chat_attachment` twice. Both Codex tool results were `user rejected MCP tool call`, while the durable backend operation ledger recorded no attachment operation. The manager handler therefore never ran.

The coordinator thread uses `approvalPolicy: "never"`, while `coordinatorTurnConfig()` configures the private manager MCP server without `default_tools_approval_mode`. Current Codex supports `auto`, `prompt`, and `approve` for this field. The implicit mode can request approval; a non-interactive `never` thread rejects that request.

This server is intentionally safe to pre-approve as a transport boundary: it is loopback-only, requires an in-memory bearer token, verifies the client belongs to the coordinator app-server process tree, requires an active durable source context, validates every typed tool argument, and records state-changing effects in the operation ledger. Project app-servers do not receive the bearer token or manager MCP configuration.

## Test-first implementation

1. Add a regression assertion in `tests/mcp/server.test.ts` that the `codex_bot_manager` server config has `default_tools_approval_mode: "approve"`, while retaining the existing assertion that the bearer token value never appears in serialized config.
2. Run the focused test and confirm it fails because the field is absent.
3. Add only `default_tools_approval_mode: "approve"` to the `codex_bot_manager` entry returned by `coordinatorTurnConfig()` in `src/mcp/server.ts`.
4. Run the focused unit test, typecheck, full test suite, package smoke test, and the opt-in real Codex MCP integration test. The existing integration test must reach `list_managed_sessions` exactly once through an app-server thread with `approvalPolicy: "never"`.

## Review and deployment

1. Have two agents review the change, focusing separately on Codex configuration semantics and on security/isolation regression risk.
2. Resolve all findings and repeat review until clean.
3. Fast-forward local `main`, rebuild and pack the distributable artifact, install it under `$HOME/.local`, and verify the installed command.
4. Gracefully stop the current installed bot, back up effective data, registry plus `.last-good`, and coordinator state, then restart from the newly installed binary with the existing secret environment.
5. Verify the binary process, both app-server children, managed policy digest, and version-2 dashboard. The user can then repeat the Telegram attachment request as the final end-to-end chat assertion.

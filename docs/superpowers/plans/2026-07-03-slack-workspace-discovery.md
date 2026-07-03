# Slack Workspace Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive Slack's workspace ID from token identities so users no longer configure `SLACK_TEAM_ID`.

**Architecture:** Keep `teamId` as a required runtime identity after Slack startup validation, but remove it from static configuration. The startup validator cross-checks the bot and owner-token `auth.test` results, then binds the resolved ID once into the delivery adapter before any delivery registry or worker starts.

**Tech Stack:** Strict TypeScript, Node.js test runner, Zod, Slack Web API/Socket Mode SDKs.

---

### Task 1: Remove the static workspace field

**Files:**
- Modify: `tests/config.test.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Write the failing configuration tests**

Change Slack-only and dual-adapter fixtures to omit `SLACK_TEAM_ID`; assert the returned Slack config is exactly `{ appToken, botToken, userToken, ownerUserId }`. Add a legacy-input assertion proving `SLACK_TEAM_ID=E123` is ignored rather than validated or returned.

- [ ] **Step 2: Run the focused test and verify RED**

Run `node --import tsx --test tests/config.test.ts` and expect the Slack-only fixture to fail because the current credential group requires `SLACK_TEAM_ID`.

- [ ] **Step 3: Implement the minimal configuration change**

Remove `SLACK_TEAM_ID` from `configSchema`, `slackFields`, `SlackConfig`, and the mapped Slack object. Keep it in the dotenv allowlist and child-environment scrub list so a value left by an earlier release is safely accepted and never inherited by Codex children.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run `node --import tsx --test tests/config.test.ts` and expect all configuration tests to pass.

### Task 2: Resolve and bind the workspace at startup

**Files:**
- Modify: `tests/slack/clients.test.ts`
- Modify: `tests/slack/delivery-adapter.test.ts`
- Modify: `tests/slack/chat-adapter.test.ts`
- Modify: `src/slack/clients.ts`
- Modify: `src/slack/delivery-adapter.ts`
- Modify: `src/slack/chat-adapter.ts`
- Modify: Slack test fixtures that construct `SlackConfig`

- [ ] **Step 1: Write failing identity and binding tests**

Assert `validateSlackStartup` returns the bot token's `team_id` without a configured team; accepts matching bot/user IDs; rejects missing bot `team_id`, missing user `team_id`, and mismatched IDs. Assert `SlackDeliveryAdapter` rejects delivery before `bindWorkspace("T123")`, permits one identical bind, and rejects rebinding to a different workspace. Assert `SlackChatAdapter.initialize()` binds delivery before it is used.

- [ ] **Step 2: Run focused tests and verify RED**

Run `node --import tsx --test tests/slack/clients.test.ts tests/slack/delivery-adapter.test.ts tests/slack/chat-adapter.test.ts` and expect type/runtime failures showing the old configured-ID API.

- [ ] **Step 3: Implement workspace discovery**

In `validateSlackStartup`, require both `auth.test` responses to contain a workspace ID and compare them directly. Return `botTeamId`. In `SlackDeliveryAdapter`, replace the constructor workspace parameter with a private unbound field and add a one-time `bindWorkspace(teamId)` method; destination validation fails while unbound. In `SlackChatAdapter.initialize()`, call `delivery.bindWorkspace(identity.teamId)` immediately after validation and before exposing bindings or handlers.

- [ ] **Step 4: Update typed fixtures and verify GREEN**

Remove `teamId` only from static `SlackConfig` fixtures; retain `T…` values in events, destinations, live-test guards, and resolved identities. Re-run the focused Slack tests and expect them to pass.

### Task 3: Update setup and configuration audits

**Files:**
- Modify: `docs/chat-apps/slack.md`
- Modify: `docs/upgrading-to-v0.3.md`
- Modify: `tests/docs.test.ts`
- Modify: `tests/mcp/server.test.ts`

- [ ] **Step 1: Write failing documentation/audit assertions**

Change the Slack guide assertion to require language that the workspace is derived from both token identities and to reject any dotenv example containing `SLACK_TEAM_ID=`. Remove the key from required Slack credential arrays while retaining tests that child environments scrub legacy values.

- [ ] **Step 2: Run focused tests and verify RED**

Run `node --import tsx --test tests/docs.test.ts tests/mcp/server.test.ts` and expect the guide assertion to fail against the five-value instructions.

- [ ] **Step 3: Update documentation**

Describe four Slack values, remove manual team-ID discovery and the dotenv entry, explain that startup derives and cross-checks the workspace, and remove `SLACK_TEAM_ID` from new-service environment examples. Keep troubleshooting focused on tokens, owner identity, and a shared workspace.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run `node --import tsx --test tests/docs.test.ts tests/mcp/server.test.ts` and expect all tests to pass.

### Task 4: Verify, review, and deploy locally

**Files:**
- Modify only if review finds a concrete defect.

- [ ] **Step 1: Run the complete gate**

Run `npm run check`; expect TypeScript to pass and the full test suite to report zero failures.

- [ ] **Step 2: Review the complete diff**

Inspect `git diff --check`, `git diff --stat`, and the full diff for accidental credential output, weakened workspace checks, obsolete setup references, and changes outside the approved scope.

- [ ] **Step 3: Request runtime and security reviews**

Have the existing reviewers inspect runtime initialization/delivery ordering and workspace/auth security respectively. Apply only verified findings, then rerun `npm run check`.

- [ ] **Step 4: Commit and restart**

Commit the implementation after the fresh full check. Stop the current QiYan process using its existing process manager, launch the rebuilt binary with the protected local dotenv, verify it remains alive through Slack startup, and ask the owner to send a Slack DM for the live round trip.

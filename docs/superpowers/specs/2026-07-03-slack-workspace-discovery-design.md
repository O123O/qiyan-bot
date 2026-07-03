# Slack workspace discovery design

## Goal

Remove `SLACK_TEAM_ID` from user configuration. QiYan will derive the Slack workspace ID from the configured bot token during startup and verify that the owner user token belongs to the same workspace.

## Design

`SlackConfig` will contain only the three Slack tokens and `ownerUserId`. Configuration loading will treat those four values as the complete Slack credential group and will ignore a legacy `SLACK_TEAM_ID` value if one remains in the dotenv file.

The Slack startup validator will call `auth.test` with both the bot token and owner user token. It will require a nonempty `team_id` from each result and require the two values to match. The bot result becomes the authoritative internal `teamId`. Existing downstream event filtering, conversation keys, delivery checks, and search normalization continue to receive this resolved ID through `SlackStartupIdentity`; those security boundaries do not change.

Startup will still verify the configured owner ID against the user token, reject a bot/owner identity collision, verify Real-time Search availability, and resolve the owner DM. Missing or mismatched workspace identities fail startup with a sanitized configuration error.

## Alternatives considered

1. Keep a required manual workspace ID. This creates avoidable setup mistakes and duplicates an identity Slack already returns cryptographically through the tokens.
2. Make the manual ID optional and compare it when supplied. This supports an extra pin but creates two setup modes without adding meaningful protection for the single-workspace deployment.
3. Derive the ID and cross-check both tokens. This is the selected approach because it has the smallest user configuration while preserving the same-workspace security check.

## Compatibility and documentation

`SLACK_TEAM_ID` will disappear from examples, required-key lists, configuration diagnostics, and setup instructions. A leftover value will not block startup, allowing the current local dotenv file to work without exposing or editing credentials. The `SLACK_TEST_TEAM_ID` opt-in live-test guard remains separate because it explicitly protects write-enabled integration tests.

## Tests

- Configuration succeeds with the four-value Slack credential group and no `SLACK_TEAM_ID`.
- Partial Slack configuration still fails.
- Startup derives the bot workspace ID and returns it downstream.
- Startup rejects missing bot or user workspace identity and rejects bot/user workspace mismatch.
- Documentation and packaged configuration-key audits no longer require `SLACK_TEAM_ID`.
- `npm run check` remains the final regression gate.

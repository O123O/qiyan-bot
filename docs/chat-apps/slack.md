# Slack setup

Status: Implemented

The Slack adapter is a single-user Socket Mode bridge. It accepts DMs from one configured owner, owner mentions in joined channels, and later owner messages inside a thread that QiYan has already activated. Other users and irrelevant channel traffic are acknowledged and discarded.

## 1. Create an internal Slack app

In [Slack app management](https://api.slack.com/apps), choose **Create New App**, **From an app manifest**, select the target workspace, and paste `assets/slack/manifest.yaml` from the installed package or repository. Review the requested access before creating the app.

The packaged manifest enables Socket Mode, the App Home messages tab, and only these events: `app_mention`, `message.channels`, `message.groups`, and `message.im`. Do not add incoming webhooks or OAuth redirect URLs. This first release is for a workspace-internal app; Slack Real-time Search access depends on workspace policy and AI-app access.

Under **Basic Information → App-Level Tokens**, generate an `xapp-` token with `connections:write`. Under **Install App**, install the app to the workspace. Record the `xoxb-` Bot User OAuth Token and the installing owner's `xoxp-` User OAuth Token.

The three tokens have different roles:

- `SLACK_APP_TOKEN` (`xapp-`) opens Socket Mode only.
- `SLACK_BOT_TOKEN` (`xoxb-`) receives and sends messages and files as QiYan in conversations the app can access.
- `SLACK_USER_TOKEN` (`xoxp-`) is restricted by QiYan's code boundary to `auth.test`, `assistant.search.info`, and `assistant.search.context`. It is read-only in QiYan, but it remains a powerful user credential governed by the owner's Slack access and workspace policy.

The user token has a code boundary that is read-only, but the credential remains powerful; protect it like any owner credential.

Never paste tokens into source, screenshots, issue trackers, or shell history. Revoke any exposed token in Slack app management.

## 2. Confirm search consent and identities

The manifest requests user scopes for public, private, IM, MPIM, file, and user search. A workspace administrator may need to approve the internal AI app. Private search also requires Slack's applicable administrator and user consent. Keyword search remains available when Slack AI Search is not enabled; semantic search requires Slack AI Search on an eligible plan. Successful search never proves workspace-wide completeness: results cannot exceed the owner's permissions, consent, retention, or workspace policy.

Copy the owner's member ID (`U…`) from the Slack profile menu (**Copy member ID**). The workspace is derived at startup with `auth.test` from the bot token, and the user token must report the same workspace. QiYan also validates the configured owner identity and ensures that the bot is not the owner identity.

## 3. Store the four Slack values

Create the private QiYan dotenv file:

```bash
install -d -m 700 "$HOME/.qiyan-bot"
install -m 600 /dev/null "$HOME/.qiyan-bot/.env"
${EDITOR:-vi} "$HOME/.qiyan-bot/.env"
chmod 600 "$HOME/.qiyan-bot/.env"
```

Enter the four values in the editor, using this shape:

```dotenv
SLACK_APP_TOKEN=xapp-replace-with-app-token
SLACK_BOT_TOKEN=xoxb-replace-with-bot-token
SLACK_USER_TOKEN=xoxp-replace-with-owner-user-token
SLACK_OWNER_USER_ID=U01234567
```

Creating the empty file with mode `0600` before editing prevents a temporary world-readable token file. Editing it directly also keeps literal credentials out of shell history; do not place real tokens in command arguments or an interactive heredoc.

All four values are required together. For a nondefault QiYan home, write `<QIYAN_HOME>/.env` and pass the same absolute `--home` to validation, login, and run. Do not put `QIYAN_HOME` inside `.env`.

To run Telegram and Slack at the same time, place both complete credential groups in the same file and add exactly one of:

```dotenv
PRIMARY_CHAT_APP=slack
```

```dotenv
PRIMARY_CHAT_APP=telegram
```

The primary selects only the initial route before the first accepted owner message. Replies and later unsolicited updates follow the owning or latest accepted conversation; QiYan never broadcasts across adapters.

## 4. Invite and use QiYan

The App Home messages tab provides the owner DM. To use a public or private channel, invite the app with `/invite @QiYan`. The bot cannot search or read a conversation merely because the owner can; bot history and attachment access are limited to conversations the app has joined.

Mention `@QiYan` in a channel to activate that thread. The mention starts or queues a QiYan conversation, and owner follow-ups in the same activated thread no longer need another mention. Unmentioned messages in other channel threads are ignored. QiYan can retrieve current-chat history when asked, while `search_slack` and `get_slack_mentions` use the owner's separately authorized search token.

Search results are transient and newest-first. QiYan retains no search-result report or SQLite receipt, returns at most 30 matches and 3,000 rendered words, and tells the assistant when pagination is incomplete or output was truncated. Ask for a narrower query or date range when warned. `get_slack_mentions` means exact owner-mention matches returned by Slack search; Slack exposes no API that reproduces the Activity feed.

Inbound and outbound Slack files use the shared private attachment store and configured `ATTACHMENT_MAX_BYTES` and `ATTACHMENT_STORE_MAX_BYTES` limits. Ambiguous uploads are not blindly repeated.

## 5. Authenticate, launch, and test

The assistant defaults to non-interactive `danger-full-access`, and chat approvals are unsupported. Workers must already use an automatic/non-interactive normal Codex configuration.

```bash
qiyan-bot config-check
qiyan-bot assistant-login
qiyan-bot
```

Smoke-test the App Home DM, a channel mention and same-thread follow-up, a small inbound and outbound file, a public search, and `get_slack_mentions` over a narrow recent date range. In dual mode, start work in Slack and ask its status from Telegram; the second conversation receives `[system] queued` while another conversation owns the active turn.

## Troubleshooting and revocation

- Startup identity/search failure: verify all token prefixes, the owner ID, that both OAuth tokens belong to the same workspace, app installation, Real-time Search scopes, and private-search consent.
- Persisted workspace mismatch: restore tokens for the original workspace, or intentionally start with a fresh QiYan home when moving the entire assistant to another workspace.
- No DM event: enable the App Home messages tab, reinstall after manifest changes, and confirm `message.im` subscription.
- No channel event: invite QiYan, mention it once in the intended thread, and confirm the four event subscriptions.
- Search is partial: narrow dates/query and inspect returned coverage; Activity notifications are not an API completeness source.
- File unavailable: confirm the app remains in the conversation and the attachment is below configured limits.
- Revoked `xoxp-` token: bot messaging already running can continue, but searches become unavailable. A later restart fails configured Slack validation until a valid owner user token is installed. Revoke the user token if its search power is unwanted, then remove or reconfigure the Slack adapter before restart.

Runtime Socket Mode reconnects are contained to Slack; Telegram can remain active. Stop QiYan before replacing credentials, then run `config-check` and restart it yourself.

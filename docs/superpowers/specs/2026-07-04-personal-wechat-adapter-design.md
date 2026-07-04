# Personal WeChat Adapter Design

**Date:** 2026-07-04

**Status:** Approved for implementation planning

## Purpose

Add an official personal-WeChat channel to QiYan. A user authorizes one Tencent-issued bot with a QR code in the terminal, then talks to QiYan in a one-to-one conversation inside personal WeChat. The adapter runs alongside Telegram and Slack and uses the same assistant, conversation arbitration, attachments, durable delivery, and managed-session tools.

The wire protocol is learned from Tencent's MIT-licensed [`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) repository at inspected revision `cef0bfc390393f716903e16d50408118047f87e0` (release 2.4.6). QiYan will implement only the protocol behavior it needs. It will not depend on OpenClaw, run an OpenClaw sidecar, or transplant OpenClaw routing and storage code.

## Product scope

The first release supports:

- one Tencent-issued WeChat bot identity per QiYan deployment;
- the personal WeChat user who completes QR authorization as the sole accepted owner;
- one-to-one conversations only;
- text, images, and generic files in both directions;
- Tencent-provided voice transcription as text when present;
- concurrent operation with Telegram and Slack;
- terminal-based QR login; and
- the existing QiYan assistant tools, conversation steering, queueing, safeguards, and durable outbox.

The first release does not support:

- WeChat groups;
- multiple WeChat bot identities;
- raw voice download, transcription, or sending;
- raw video download, understanding, or sending;
- WeChat search or history tools;
- impersonating or automating the owner's ordinary personal account;
- OpenClaw as a runtime dependency or bridge; or
- copying unrelated implementation code from Tencent's plugin.

The QR scan authorizes a distinct `ilink_bot_id`. The scanner's `ilink_user_id` is a separate owner identity. QiYan acts as the bot, never as the personal user.

## User experience

### Login

The user runs:

```bash
qiyan-bot weixin-login [--home <qiyan-home>]
```

The command uses the same QiYan-home resolution rules as other commands. It does not start the assistant or either Codex App Server. It starts login with `POST ilink/bot/get_bot_qrcode?bot_type=3`; the JSON body contains `local_token_list` with at most the current single-account token. That token lets Tencent report an already-bound bot without issuing duplicate credentials. The command renders the returned QR payload in the terminal and polls `GET ilink/bot/get_qrcode_status`.

The login state machine accepts only `wait`, `scaned`, `scaned_but_redirect`, `need_verifycode`, `verify_code_blocked`, `binded_redirect`, `expired`, and `confirmed`. `scaned_but_redirect` changes the polling host only after endpoint validation. `need_verifycode` prompts for a numeric code in the terminal; repeated rejection and QR refresh are bounded. On `binded_redirect`, the command probes `getconfig` with the prior credential and owner identity. A successful probe leaves the credential file, account-generation ID, cursor, deduplication domain, inbox, and routes unchanged; startup may clear an inactive authorization latch only after repeating that authenticated probe. A stale/authorization failure performs one fresh QR attempt with an empty `local_token_list`. `confirmed` succeeds only when the response includes a nonempty token, bot ID, owner user ID, and an effective validated API base URL; the effective URL is the response `baseurl` when present and the current validated fixed/redirect host otherwise. Unknown states fail closed.

On success, the command atomically stores one credential record and tells the user to restart the QiYan service. Re-login does not replace the local credential until the new authorization is fully validated; a failed or cancelled login leaves the prior local record intact. If Tencent independently invalidates the prior token during authorization, normal stale-token handling applies. Re-login replaces the single supported WeChat bot identity rather than adding another account.

The QR payload, verification code, bot token, and raw authentication responses are never written to logs. The QR payload is not persisted.

### Normal startup

A valid managed WeChat credential automatically configures the `weixin` adapter. No token or owner ID is copied into `.env`. `main.ts` performs an asynchronous WeChat bootstrap after resolving QiYan home and before ordinary configuration validation. That bootstrap validates and pins the credential once, passes only a public configured flag into `loadConfig`, and passes an opaque in-memory credential handle separately into application composition. `run` and `config-check` share this exact bootstrap; `assistant-login`, `weixin-login`, `--version`, and `--update` do not require it. If WeChat is the only configured adapter, it is the primary adapter. When two or more adapters are configured, `PRIMARY_CHAT_APP` is required and accepts `telegram`, `slack`, or `weixin`.

`qiyan-bot config-check` reports whether a WeChat credential is present and structurally valid without printing bot IDs, owner IDs, tokens, context tokens, or endpoint query data. An invalid or unsafe credential file is an actionable configuration error, not a silently disabled adapter.

### Chat behavior

The accepted owner can continue the same assistant work from WeChat, Telegram, or Slack. Existing conversation-bound steering applies unchanged: the active conversation can steer its turn, another conversation is durably queued, and `[system] queued` is sent through the losing conversation's adapter. Replies follow the immutable attempt binding or the current owner route according to existing QiYan rules.

WeChat does not add assistant-facing platform tools in the first release. `send_chat_message`, `prepare_chat_attachment`, and `send_chat_attachment` work through the generic delivery layer. `get_chat_history` on a WeChat binding returns `UNSUPPORTED_CAPABILITY`; `search_slack` and `get_slack_mentions` remain Slack-only.

## Architecture

### Components

The implementation adds a `src/weixin/` boundary with these focused components:

- `WeixinAuthClient` implements QR creation, status polling, verification-code submission, expiry, confirmation, and validated Tencent redirects.
- `WeixinCredentialStore` owns the single versioned credential file, private path validation, atomic replacement, and structural parsing.
- `WeixinApiClient` implements typed calls for `getupdates`, `sendmessage`, `getuploadurl`, `getconfig`, `sendtyping`, `notifystart`, and `notifystop`.
- Protocol decoders validate all untrusted JSON before the rest of QiYan observes it.
- `WeixinInboxStore` atomically owns polling cursor replacement, normalized authorized inbox rows, message deduplication, route-token versions, processing claims, attachment checkpoints, and inbox attachment holds.
- `WeixinIngressWorker` downloads and decrypts supported media, records permanent failures, and submits canonical chat sources to `ConversationStore`.
- `WeixinOutboundStore` owns deterministic per-delivery step plans, upload/send intent, dispatch uncertainty, and successful step receipts.
- `WeixinDeliveryAdapter` implements `ChatDeliveryAdapter` for text, image, and generic-file delivery and implements the generic uncertain-delivery reconciliation hook.
- `WeixinChatAdapter` implements `ChatAdapter` and owns initialization, long polling, backoff, health, startup, shutdown, and component composition.

The protocol client stays independent of chat orchestration, persistence, and attachment policy. Fake protocol transports can test each boundary without Tencent or Codex.

### Generic integration

`weixin` becomes a valid adapter ID and primary-app value. `production-app.ts` composes it from the managed credential in the same chat-adapter lifecycle that owns Telegram and Slack. `ChatAdapterRegistry`, `DeliveryWorker`, `OwnerRouteStore`, `ConversationStore`, and assistant attempt bindings remain platform-neutral.

The primary WeChat binding points to the authorized owner even before the first inbound message. Tencent permits a send without a conversation context token, so startup warnings can target that owner when WeChat is primary. Once inbound traffic supplies a context token, later bindings use a frozen route-token record as described below.

Application composition also creates an in-memory catalog of each configured adapter's administrative owner binding. Warning routing excludes a failed adapter, then prefers the current nonfailed route, the configured primary, and finally a stable adapter order. This lets a stale WeChat incident reach Telegram or Slack even when the latest persisted route is WeChat. Warning preparation remains durable and idempotent.

## Credentials and trust boundaries

The default credential path is:

```text
~/.qiyan-bot/credentials/weixin.json
```

It contains a schema version, stable random account-generation ID, replaceable random credential-revision ID, bot ID, owner user ID, bot token, validated API base URL, and authentication timestamp. A confirmed authorization with the same bot and owner preserves the account-generation ID and changes only the credential revision and authentication material; a different bot or owner creates a new account generation. The credentials directory is mode `0700`; the file is mode `0600`. Initialization repairs overly broad modes only on already validated ordinary directories/files. Symlinks, hard-link surprises, non-directories, non-regular files, path replacement, malformed JSON, unknown schema versions, and identity changes during a pinned process lifetime are rejected.

Atomic replacement uses a private sibling temporary file, file sync, rename, and directory sync. It does not create a plaintext backup. The token never enters the environment inherited by Codex, chat transports, package managers, or subprocesses. The bootstrap pins the credential file and every managed parent by device/inode, type, owner, mode, canonical path, and content digest. Every poll, upload, download, and delivery verifies that pin immediately before network dispatch. Replacement, deletion, recreation, or path substitution atomically latches the account generation inactive and stops both ingress and egress until restart and validated generation activation.

Tencent hosts are fail-closed. QR login starts at `https://ilinkai.weixin.qq.com`. API base URLs, redirect hosts, CDN URLs, and upload URLs must use HTTPS and resolve to `weixin.qq.com` or a true subdomain of `weixin.qq.com`, checked at DNS-label boundaries. The initial CDN base is `https://novac2c.cdn.weixin.qq.com/c2c`. User-provided endpoint overrides and broader `*.qq.com` trust are not part of the product interface. Every fetch uses `redirect: "manual"`; each `Location` hop is resolved and revalidated for scheme, hostname, ordinary HTTPS port, absent userinfo, endpoint-appropriate path, and a bounded redirect count before following it. iLink bearer credentials are never forwarded to CDN requests.

Request authentication is endpoint-specific:

- All iLink requests carry `iLink-App-Id: bot` and the packed `iLink-App-ClientVersion`.
- QR creation is an unauthenticated JSON `POST` carrying `AuthorizationType: ilink_bot_token` and a fresh `X-WECHAT-UIN`, but no bearer token.
- QR status is a `GET` carrying only the common iLink headers.
- Authenticated JSON API `POST`s additionally carry `Content-Type: application/json`, `AuthorizationType: ilink_bot_token`, a fresh base64 encoding of a decimal uint32 in `X-WECHAT-UIN`, and `Authorization: Bearer <token>`.
- Authenticated API bodies carry both `base_info.channel_version` and `base_info.bot_agent`; QR requests do not invent `base_info` fields.
- CDN download and upload use only the headers required by their signed CDN protocol and never carry the bot bearer token.

`base_info.bot_agent` identifies `QiYan/<version>` for Tencent observability. Logs may include operation names, status categories, counts, bounded timings, and redacted hostnames, but never message bodies, attachment contents, tokens, QR data, verification codes, context tokens, encrypted CDN parameters, signed query strings, or credentials.

## Conversation and route identity

The adapter account identity is the Tencent `ilink_bot_id`; the only accepted peer is the QR-scanning `ilink_user_id`. A conversation key is derived deterministically from both identities. The generic binding destination contains only stable account/peer identity and an opaque route-token record ID, never the context token itself.

Each accepted inbound message with a `context_token` creates or reuses a persisted immutable route-token record scoped to the account generation. The source binding points at that exact record. Assistant attempts and prepared deliveries therefore retain the context associated with the source that created them, even if a later WeChat message rotates the current token while an earlier turn is still running. Administrative sends created without an inbound source may use the latest committed route-token record, or omit the token before the first message.

Route-token records are secret state. They are not rendered into the dashboard, manager metadata, assistant prompt, tool results, logs, or generic session registry. Reference-aware garbage collection deletes a token only when it is not the current route and no source, attempt, delivery, or outbound step references it. Retiring an account generation performs the same reference-aware cleanup instead of retaining tokens indefinitely.

### Account-generation activation

Startup atomically compares the validated account generation, credential revision, and bot/owner identities with persisted WeChat account state. An unchanged account generation resumes its cursor, deduplication domain, inbox, and routes. An unchanged credential revision resumes its authorization latch; a new validated revision for the same account generation preserves all message state and may reactivate the latch after an authenticated probe. Only a different bot or owner creates a new account generation that:

1. creates a fresh active account generation with an empty cursor and active authorization state;
2. fences unprocessed inbox work from older generations so it cannot create new assistant input;
3. leaves already accepted generic sources and active attempts untouched;
4. deletes `latest_owner_route` only when it points to an older WeChat generation, while preserving a Telegram or Slack latest route;
5. preserves old immutable route-token and outbound records only while referenced; and
6. deterministically fails unsent old-generation deliveries rather than redirecting them through the new bot identity.

The in-memory primary fallback then points at the new owner. This makes re-login behavior deterministic before the first message on the new bot.

## Inbound data flow

Only one long poll may be active for the single account. The worker sends the last committed `get_updates_buf`; the first poll sends an empty cursor. The cursor is opaque base64 state: advancement means single-writer replacement after a successful transaction, never numeric, lexical, or prefix comparison. The server-recommended next timeout is bounded by local minimum and maximum values. Shutdown aborts the in-flight request immediately.

API response parsing preserves JSON integers losslessly. Tencent numeric identifiers are normalized to canonical decimal strings before schema decoding; values used as timeouts, sizes, counts, or timestamps must separately fit their safe local bounds. Every JSON response is byte-bounded before conversion to text, pre-scanned with string-aware nesting limits before parsing, and schema-bounded for arrays and retained strings. The implementation pins and bundles `lossless-json` 4.3.0 rather than allowing JavaScript number rounding to merge distinct message IDs.

For each successful response, QiYan:

1. Runtime-validates the response envelope and `ret === 0`. A valid nonempty next cursor replaces the prior cursor; a missing or empty successor preserves the prior cursor rather than resetting it. An invalid envelope rejects the whole response and retains the old cursor.
2. Losslessly decodes candidates independently. A candidate uses identity kind `message` plus its canonical decimal `message_id`, or identity kind `client` plus a nonempty string `client_id` only when `message_id` is absent. Kind and value are separate persisted key fields, so `message:123` cannot collide with `client:123`. A candidate with neither identity is malformed. Malformed candidates, messages not sent by the exact owner, bot-originated echoes, and unsupported conversation types are discarded without retaining bodies or attachment metadata; other valid candidates in the same batch still commit and the batch cursor advances.
3. In one SQLite transaction, deduplicates authorized messages by account generation plus stable Tencent identity, stores new normalized inbox rows and route-token records in server order, and advances the polling cursor. The generic canonical source ID includes the account-generation ID, identity kind, and identity value, so a new bot generation cannot collide with an equal Tencent ID from a retired generation.
4. Returns to polling independently of downstream assistant latency.
5. Lets `WeixinIngressWorker` claim durable inbox rows in order and recover `processing` rows after restart.

The cursor never advances independently of inbox persistence. A crash after commit can replay processing but cannot lose an authorized message. A crash before commit causes Tencent to return the same batch; deduplication makes that harmless. Cursor updates are ordered replacements within the single bot-account generation.

The inbox stores bounded normalized fields rather than arbitrary raw response JSON. Message text is retained only for the authorized owner and is subject to the same private-state assumptions as existing Telegram and Slack source content.

### Attachments

An inbox row holds per-item attachment checkpoints. Every completed checkpoint also creates a durable inbox attachment hold and increments the attachment reference count before the checkpoint becomes visible. Maintenance therefore cannot delete a downloaded file while the inbox head is retrying. Source acceptance, processed transition, source retention, and transfer/release of all inbox holds commit in one transaction. Recovery repairs neither a checkpoint without its hold nor a hold without its checkpoint; such inconsistency fails closed.

Download, validation, decryption, and source acceptance follow these rules:

- Images are downloaded from validated Tencent CDN URLs, size-checked, format-validated, checked against relevant declared plaintext/ciphertext lengths, stored once, and submitted as native Codex local-image inputs. An `image_item.aeskey` must be exactly 32 hexadecimal characters. A base64 `media.aes_key` must decode either to exactly 16 raw bytes or exactly 32 ASCII hexadecimal characters. Encrypted media uses AES-128-ECB with strict PKCS#7 validation, ciphertext block-size checks, and ciphertext/plaintext caps. The observed keyless HTTPS image variant is treated as validated plaintext rather than passed through decryption.
- Generic files require the same strict `media.aes_key` decoding, are downloaded, decrypted, checked against declared lowercase MD5, plaintext length, and ciphertext size, size-checked, stored once, and submitted as filesystem mentions with safe display names and media types. A missing key on a file is a permanent unsupported protocol form, not plaintext fallback.
- Voice items contribute Tencent's provided transcription as source text. Raw voice media is not downloaded. A voice item without transcription produces one explicit unsupported-media descriptor.
- Video items are not downloaded and produce one explicit unsupported-media descriptor.
- Permanent download, decryption, integrity, size, or format failures produce bounded failed-attachment descriptors and do not block later text processing.
- Transient failures keep the inbox head retryable with bounded backoff; later rows do not overtake it.

Attachment-store references, source acceptance, route binding, inbox-hold transfer, and the permanent inbox transition commit under the existing exact-once retention rules. A duplicate or restarted ingest reuses the deterministic attachment ID and hold rather than incrementing twice. No attachment content is logged.

## Outbound data flow

Before network dispatch, `WeixinOutboundStore` creates an immutable ordered step plan for the delivery. Text is split at a conservative 4,000 UTF-8-byte boundary while preserving Unicode code points; this matches or is stricter than the pinned reference plugin's declared 4,000-character host chunk. Live acceptance tests the boundary before release, and the constant may only be lowered if Tencent rejects it. Each text step receives a deterministic Tencent `client_id` derived from the QiYan delivery ID and chunk ordinal. The destination freezes account generation, bot identity, owner identity, and the route-token record selected when the delivery is prepared.

Attachment plans contain: upload-parameter acquisition, encrypted CDN upload, optional caption send, and media-item send. The retained QiYan snapshot is size-checked and assigned a deterministic upload identity. Plan creation generates a fresh cryptographically random 16-byte AES key, persists it inside the immutable plan before dispatch, and reuses that stored key across recovery; only the upload identity, `filekey`, and message client IDs are deterministic. The snapshot is encrypted with AES-128-ECB and uploaded with `POST` plus `Content-Type: application/octet-stream` to the validated CDN destination. Success requires HTTP 200 and one bounded, syntactically validated `x-encrypted-param` response header; that header is the persisted upload receipt used by the later media step. This intentionally follows pinned Tencent release code and tests where they differ from the README's `PUT` prose. Retry never rereads a mutable original path. Outbound attachments classified as audio or video are rejected as unsupported instead of being disguised as generic files.

`getuploadurl` carries a deterministic 32-hex-character `filekey`, media type `1` for image or `3` for generic file, target owner ID, plaintext size, lowercase plaintext MD5, PKCS#7-padded ciphertext size, `no_need_thumb: true`, the 32-hex-character AES key, and normal `base_info`. It requires at least one validated `upload_full_url` or `upload_param`, allows both, and prefers `upload_full_url` when both are present. The later `sendmessage` body always has empty `from_user_id`, target owner ID, deterministic `client_id`, `message_type: 2`, `message_state: 2`, exactly one item, and the frozen context token when present. Text uses item type `1`. Image uses item type `2` with `media.encrypt_query_param`, `media.aes_key` as base64 of the 32 ASCII hex-key characters, `media.encrypt_type: 1`, and ciphertext `mid_size`. Generic file uses item type `4` with the same media reference plus safe `file_name` and plaintext byte length as decimal `len`. Canonical request/response fixtures assert these bodies byte-for-byte apart from explicitly variable headers.

Every effecting step has `prepared`, `dispatching`, `succeeded`, or `uncertain` state. QiYan persists `dispatching` before the network call and atomically persists the bounded receipt before moving to the next step. Restart skips succeeded steps. A crash or transport ambiguity while a step is `dispatching` makes that step and the overall delivery uncertain and blocks every later step. A partial successful delivery can resume only when every already-dispatched step has a durable success receipt.

The generic delivery contract gains optional uncertain reconciliation with three outcomes: `confirmed` with a receipt, `resume_safe` when all dispatched effects are checkpointed or no effect began, and `unresolved`. `DeliveryWorker` invokes it before any automatic handling of an uncertain delivery, regardless of `mandatory`. WeChat returns `confirmed` when every planned step succeeded, `resume_safe` when no step has unresolved dispatch and work remains, and `unresolved` when any step may have taken effect. An unresolved WeChat delivery is excluded from redispatch even when mandatory; its retained attachment snapshot is not released until final confirmation or deterministic failure. Adapters without this hook retain their existing recovery policy.

The adapter does not claim that Tencent deduplicates `client_id` until a live protocol test proves it. A local validation or inactive-latch failure before network dispatch is deterministic no-effect. A syntactically valid nonzero `sendmessage` response is terminal failed and is never retried; `-14` additionally trips the authorization latch. A network failure, timeout, malformed success response, unexpected redirect, or connection loss after dispatch is `uncertain`; neither optional nor mandatory WeChat messages are automatically resent. A deduplicated warning is routed through another configured adapter when possible, without attempting to warn through the same unresolved WeChat path.

Typing indicators are optional best-effort effects and never determine delivery state. `notifystart` and `notifystop` are also best effort; their failure cannot roll back durable chat state or prevent bounded shutdown.

## Failure handling and health

Long-poll transport failures use bounded exponential backoff with jitter and reset only after a successful response. Repeated failures update adapter health without blocking Telegram or Slack. Protocol failures are categorized into authorization, rate limit, invalid request, service, and unknown classes without including server bodies that may contain sensitive data.

Each account generation has a durable authorization latch shared by polling, downloads, uploads, and delivery. Tencent error `-14` in either `ret` or `errcode`, or a failed credential-pin check, atomically changes the latch from `active` to `relogin_required` or `credential_changed`. Every WeChat network operation checks the latch and credential pin before dispatch. Restart preserves the inactive latch; only an authenticated probe of the unchanged revision or activation of a newly validated credential revision/account generation clears it.

A stale-token transition pauses new WeChat polls and deliveries and requires `qiyan-bot weixin-login` followed by service restart. The latch transition, incident deduplication row, and alternate-adapter warning delivery are created in one SQLite transaction when a non-WeChat owner route exists. With no alternate route, the same transaction records `no_route`; startup reconciles every inactive incident and creates its missing warning if a new alternate route is now configured. A crash can therefore produce neither an inactive latch without a durable incident nor a duplicate warning. If WeChat remains the only route, the condition is visible through service status and safe logs. QiYan never deletes credentials or starts an interactive login automatically.

Malformed credentials, unsafe endpoint state, owner/bot identity mismatch, and credential replacement during a running process fail closed. Ordinary unauthorized incoming users are silently ignored.

## Persistence

An additive SQLite migration creates:

- `weixin_account_generations` for bot/owner identity, credential revision, activation, retirement, and durable authorization latch;
- `weixin_auth_incidents` for crash-atomic stale/change warning deduplication and alternate-route delivery identity;
- `weixin_sync_state` for the active generation's opaque cursor;
- an ordered `weixin_inbox` and sequence allocator;
- immutable generation-scoped `weixin_route_tokens` with reference-aware cleanup;
- per-inbox media checkpoints and `weixin_inbox_attachment_refs` holds; and
- `weixin_outbound_steps` for deterministic step plans, request hashes, client IDs, upload identity/key, pre-dispatch state, bounded receipts, and uncertainty.

Indexes and constraints enforce one active generation, one unresolved processing head, stable generation/kind/value-scoped deduplication, unique holds, immutable step identity, and no cross-generation route use.

The migration accepts the repository's exact supported QiYan product-state versions 2 and 3, including a completed conversation-routing cutover, and does not require a destructive fresh cutover. Unknown future product-state versions remain rejected read-only. WeChat tables do not weaken existing Telegram, Slack, delivery, source, attempt, or attachment constraints.

The credential file is not copied into SQLite. The database may reference the stable bot-account generation but never stores the bot bearer token.

## Distribution and documentation

The release package includes only QiYan's compiled implementation and existing assets. It pins and bundles `qrcode-terminal` 0.12.0 for terminal rendering and `lossless-json` 4.3.0 for untrusted protocol integers; Tencent's OpenClaw package and OpenClaw itself are not dependencies. Node built-ins implement HTTP, crypto, file streaming, and atomic storage where practical.

The active WeChat guide replaces its planned-status warning with:

- prerequisites and supported scope;
- terminal QR login;
- service configuration and `PRIMARY_CHAT_APP` examples;
- restart and re-login behavior;
- text/image/file and voice-transcription behavior;
- explicit group/raw-voice/raw-video/history limitations;
- credential backup and revocation cautions; and
- troubleshooting for stale tokens, QR expiry, verification codes, endpoint rejection, attachment failures, and polling health.

README, installation, setup, security, `.env` examples, release-package audits, and updater documentation are updated where the third concurrent adapter changes user-visible behavior. Documentation credits Tencent's public protocol reference and inspected revision without suggesting Tencent endorses QiYan.

## Testing strategy

Behavior changes are developed test-first. CI uses deterministic fake Tencent transports and cryptographic fixtures; no real personal account or secret is required.

### Unit and contract tests

- QR creation with the prior token, every exact login state, scan, effective-base-URL confirmation requirements, already-bound probe/no-op preserving file/generation/cursor/routes, forced fresh login after a stale probe, expiry, bounded refresh, verification-code flow, regional redirect validation, cancellation, and re-login rollback.
- Credential schema, atomic replacement, fsync ordering, private permissions, per-network-use path pinning, replacement/delete/recreate/symlink/inode swaps, unknown versions, and secret redaction.
- Exact endpoint method/header/auth/body matrix, bot-agent identity, canonical text/image/file send fixtures, manual bounded redirects, timeouts, abort behavior, response decoding, host/path validation, bearer exclusion from CDN, and failure classification.
- Bounded JSON reads before parsing, string-aware nesting depth, candidate/item counts, QR/auth field sizes, cursor/context-token/text sizes, and over-limit rejection without cursor advancement, persistence, or sensitive logging.
- Lossless identifiers above `Number.MAX_SAFE_INTEGER`, canonical decimal identity, kind-separated `message_id`/`client_id` keys including equal-value collision, missing-identity discard, opaque cursor replacement, and mixed valid/malformed batches.
- AES key decoding from hex, raw-byte base64, and ASCII-hex base64; padding, block/cap checks, keyless HTTPS images, declared MD5/plaintext/ciphertext length and image-format integrity, safe filenames, `POST` upload, status/header receipt parsing, and bounded streaming behavior.
- Owner-only event classification, bot-echo discard, direct-only enforcement, malformed-message discard, and no unauthorized content retention.
- Atomic inbox-plus-cursor commit, multi-message ordering, replay deduplication, crash before/after commit, processing recovery, account-generation fencing, and poisoned-head behavior.
- Inbox attachment holds across TTL cleanup and retry, crash before/after checkpoint, duplicate ingest, and atomic hold transfer/release at source acceptance.
- Immutable route-token selection and garbage collection across later messages, active turns, queueing, steering, restart, administrative sends, and generation retirement.
- Same-identity credential revision preserving cursor/dedup/inbox/routes and different-identity account-generation activation with pending/processing inbox rows, active sources, prepared/dispatched deliveries, old latest WeChat route, and preserved Telegram/Slack latest route.
- Conservative text boundary splitting, deterministic chunk IDs, immutable step plans, persisted upload/message checkpoints, retained snapshots, deterministic no-effect failures, and confirmed receipts.
- Network ambiguity and process death before/after every chunk, upload, caption, and media-send checkpoint for optional tool deliveries, mandatory assistant finals, and mandatory system notices; no unresolved WeChat redispatch.
- Image/file success, transient retry, permanent failed descriptors, voice transcription, missing voice transcription, and unsupported video.
- Adapter initialization, concurrent-poll prevention, bounded backoff, health reset, durable stale-token/credential-change latch across restart, crash between latch and warning creation, startup warning reconciliation, alternate-route selection, abortable shutdown, and best-effort lifecycle notifications.

### Integration and distribution tests

- WeChat-only startup and primary binding.
- Telegram, Slack, and WeChat configured together with required primary selection.
- Cross-adapter owner-route changes, active-conversation steering, losing-conversation queue notices, and reply routing.
- Generic chat-message and attachment tools delivering through WeChat without WeChat-specific tools.
- Database migration fixtures from exact product-state versions 2 and 3, including completed conversation cutover, unknown-future rejection, restart recovery, and no regression to existing chat adapters.
- Runtime-only package contents, clean-prefix installation, `--version`, `config-check`, and the packaged WeChat setup guide.
- Static assertions that no Tencent/OpenClaw runtime dependency, raw secret logging, or unsupported capability claim enters the release.

### Live acceptance

An opt-in live test uses a real terminal QR login outside CI. It verifies:

1. authorization returns one bot identity and the scanning owner identity;
2. service restart connects and long-polls;
3. owner text, image, and file messages reach QiYan exactly once;
4. another personal WeChat user is ignored;
5. QiYan replies with text just below, at, and above the configured 4,000 UTF-8-byte chunk boundary, an image, and a file;
6. a Tencent-transcribed voice message reaches QiYan as text;
7. raw video receives the documented unsupported-media behavior;
8. Telegram or Slack can continue a task begun in WeChat and vice versa;
9. stop and restart resume from the persisted cursor without loss or duplicate assistant work; and
10. logs and status output contain none of the prohibited sensitive values.

The test records only opaque operation identities, counts, states, and timing. It does not commit credentials, user IDs, chat bodies, or attachment content.

## Acceptance criteria

The feature is complete when:

- a fresh QiYan installation can authorize one personal-WeChat bot through the terminal;
- only the QR-authorizing user can drive the assistant;
- text, images, generic files, and voice transcription work according to scope;
- WeChat runs alone or concurrently with Telegram and Slack;
- crashes cannot advance the Tencent cursor without durable authorized inbox state;
- outbound ambiguity cannot cause automatic duplicate sends;
- all credential, endpoint, attachment, and logging trust boundaries fail closed;
- the full repository check, package audit, fake-transport integration suite, and documented live acceptance pass; and
- active documentation accurately distinguishes supported behavior from deferred groups, raw voice/video, and history/search.

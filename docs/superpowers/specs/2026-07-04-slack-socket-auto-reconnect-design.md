# Slack Socket Fast-Reconnect Design

## Problem

The first Slack request after the assistant recovery fix took 15.8 seconds end to end. Codex used 1.9 seconds and outbound Slack delivery used 1.1 seconds, while 12.8 seconds elapsed before assistant admission. The Slack Socket Mode connection also reported missed pong deadlines and TCP retransmissions. QiYan currently disables the Slack SDK's automatic reconnection and implements its own reconnect state machine.

## Goal

Detect and replace a dead or routinely refreshed Socket Mode connection promptly, without changing durable ingress, conversation arbitration, or assistant execution.

## Architecture

`SlackChatAdapter` will construct one `SocketModeClient` with `autoReconnectEnabled: false`. It will omit custom ping thresholds so the SDK uses its supported defaults: a 5-second client-pong timeout and a 30-second server-ping timeout. The adapter will keep the existing 10-second `apps.connections.open` HTTP timeout, reject rate-limited calls, and disable Web API request retries.

QiYan will retain its application-owned disconnected listener, reconnect timer, bounded exponential backoff, and lifecycle generation fence. This controller catches every `SocketModeClient.start()` rejection instead of relying on SDK 2.0.7's unsafe automatic reconnect path, which can produce an unhandled rejection for transient URL-open failures and can reconnect past shutdown. `start()` will subscribe to Slack events, start the durable ingress worker, and establish the initial connection. `stop()` will unsubscribe, cancel pending reconnect timers, fence in-flight reconnect settlement, settle accepted events, stop the ingress worker, and call `disconnect()`.

## Data Flow

Incoming envelopes keep the current order:

1. Classify the authenticated Slack event.
2. Persist accepted metadata and content in the durable Slack inbox.
3. Acknowledge the envelope.
4. Drain the inbox into the platform-neutral conversation store.
5. Let the conversation dispatcher start or steer Codex.

No message bodies, attachments, tokens, or credentials will be added to logs. The change affects only how the Socket Mode transport maintains its connection.

## Failure Handling

- Missed ping or pong deadlines, Slack-requested refreshes, and unexpected closes emit `disconnected`; QiYan schedules one replacement attempt.
- Replacement failures are caught and retried after 1, 2, 4, 8, 16, and at most 30 seconds, while each individual HTTP attempt remains bounded to 10 seconds.
- Initial startup still fails if the first Socket Mode connection cannot be established.
- Explicit application shutdown cancels pending reconnect timers. An already-running URL request is generation-fenced and disconnected if it later establishes a socket.
- Durable inbox recovery remains responsible for events persisted before a crash.

## Testing

Unit tests will verify that the adapter disables SDK automatic reconnection, preserves the bounded Web API client options, omits custom heartbeat settings, and retains the application-owned reconnect and shutdown fences. Existing tests will continue to cover event persistence, acknowledgement, draining, reconnect failure, and orderly shutdown. The full `npm run check` suite must pass.

After packaging and restarting the local service, a fresh owner DM will be measured using metadata-only timestamps for Slack event time, assistant admission, terminal completion, and confirmed delivery. Success means the service stays active and a stable connection delivers the test event without the previous 10-plus-second pre-admission stall. On a connection that has never returned a pong, the SDK's default heartbeat detects failure on the fourth approximately 1.7-second ping tick, after about 6.7 seconds, before QiYan's 1-second reconnect delay. A single transient slow event will be reported rather than hidden; repeated samples are needed before attributing residual delay to the network route.

## Non-Goals

- Maintaining multiple simultaneous Socket Mode connections.
- Changing assistant queuing, turn steering, model behavior, or delivery semantics.
- Adding a public HTTP Events API endpoint.
- Logging or persisting new message content for diagnostics.

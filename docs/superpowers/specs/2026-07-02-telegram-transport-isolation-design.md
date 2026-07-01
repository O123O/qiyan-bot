# Telegram Transport Isolation Design

## Problem

The Telegram adapter currently shares one `TelegramApi` instance, and therefore one
Node global `fetch` transport, between inbound long polling and outbound delivery.
In the deployed Node 26.4.0 runtime, Telegram negotiates HTTP/2. An active
`getUpdates` request with `timeout: 50` then blocks Undici from sending the body of a
concurrent Telegram write request on that transport.

Live tracing established the boundary:

- an independent `sendMessage` connection completed in 1.156 seconds;
- a shared-transport `sendMessage` was created immediately but its body remained
  unsent for 48.456 seconds;
- Telegram returned the successful response 449 milliseconds after Undici finally
  sent the body;
- a read-only `getMe` request was not blocked, while both `sendMessage` and
  `sendChatAction` were blocked until the long poll completed.

The latency is therefore in the local HTTP transport queue, before Telegram
receives the write request. The long poll itself is working as designed.

## Goal

Allow Telegram long polling and outgoing delivery to run concurrently so a reply
is transmitted as soon as Codex produces it, without changing Telegram update
semantics, delivery recovery, or message contents.

## Non-goals

- Replacing long polling with webhooks.
- Shortening the 50-second `getUpdates` timeout.
- Changing coordinator scheduling, delivery persistence, or retry policy.
- Adding general-purpose HTTP client configuration.

## Architecture

Add a focused Telegram transport factory that returns:

- a polling `TelegramApi` whose fetch function uses a dedicated Undici `Agent`;
- a delivery `TelegramApi` that continues to use the normal global fetch transport;
- an idempotent close operation for the polling agent.

`TelegramChatAdapter` will expose the delivery API as it does today, give the
polling API to `TelegramPoller`, and own the polling transport lifecycle. On stop,
it first aborts and awaits the active long poll, then closes the dedicated agent.

Only polling owns an additional agent. This matches the existing production phase
order: polling is stopped before the delivery worker. Closing a delivery agent from
`TelegramChatAdapter.stop()` could otherwise race with an in-flight delivery.

The implementation will add `undici` as a build dependency and use its supported
`Agent` and `fetch` APIs together. The existing esbuild configuration will bundle it
into the executable, preserving the published package's zero-runtime-dependency
contract.

## Data Flow

1. `TelegramPoller` calls `getUpdates` through the dedicated polling agent.
2. Telegram returns immediately when a user update arrives.
3. The poller persists and dispatches the accepted source, then starts the next long
   poll on the same dedicated polling agent.
4. Codex processes the source concurrently.
5. `DeliveryWorker` calls `sendMessage` or `sendDocument` through the independent
   global delivery transport, so the active long poll cannot queue its request body.

## Error Handling and Shutdown

Telegram API parsing, 429 retry handling, delivery uncertainty, and attachment
streaming remain unchanged. If polling startup or polling itself fails, the existing
poll loop behavior remains authoritative. The dedicated agent close is idempotent;
shutdown aborts the poll before closing the agent so an expected abort is not treated
as an operational failure.

## Testing

The regression test will prove the transport boundary rather than relying on timing:

- polling requests receive the dedicated dispatcher;
- delivery requests do not receive that dispatcher;
- stopping the adapter closes the polling dispatcher after the poll is aborted;
- all existing Telegram API, poller, delivery, production, and packaging tests remain
  green.

After automated verification, rebuild and reinstall the distributable binary, restart
the real bot, and repeat a live timing trace. Success means `sendMessage` body
transmission begins without waiting for the active `getUpdates` request to finish.

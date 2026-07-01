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

- a polling `TelegramApi` whose fetch function uses a dedicated Undici dispatcher;
- a delivery `TelegramApi` whose fetch function uses a second dedicated dispatcher;
- idempotent close operations for both dispatchers.

The factory preserves Node's effective opt-in environment-proxy policy without
reimplementing Node's CLI parser. At process startup, Node records the resolved policy
on the HTTPS global agent's `options.proxyEnv`; this already accounts for
`NODE_USE_ENV_PROXY`, `NODE_OPTIONS`, command-line boolean forms, and precedence. The
factory creates an `EnvHttpProxyAgent` from that effective environment when present,
or a normal `Agent` otherwise. Both choices still provide a pool independent from the
delivery transport. Lowercase proxy variables retain Undici's documented precedence
over uppercase variants.

Delivery also uses an explicit dispatcher because loading the standalone Undici
package can replace the dispatcher consulted by Node's global fetch on supported Node
24 and 25 releases. Giving both roles explicit, separately constructed dispatchers
preserves proxy behavior and prevents either role from depending on mutable global
dispatcher state.

`TelegramChatAdapter` will expose the delivery API as it does today, give the
polling API to `TelegramPoller`, and own the polling transport lifecycle. On stop,
it first aborts and awaits the active long poll, then closes the dedicated agent.

The existing production phase order stops polling before the delivery worker. The
adapter therefore closes only the polling dispatcher from `stop()`. After the delivery
worker fully stops, the delivery phase calls `close()` to close the delivery dispatcher
without racing an in-flight send. A stopped adapter is terminal and rejects restart;
production creates a fresh adapter for a later application start.

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
5. `DeliveryWorker` calls `sendMessage` or `sendDocument` through the second explicit
   delivery dispatcher, so the active long poll cannot queue its request body.

## Error Handling and Shutdown

Telegram API parsing, 429 retry handling, delivery uncertainty, and attachment
streaming remain unchanged. If polling startup or polling itself fails, the existing
poll loop behavior remains authoritative. Shutdown awaits `TelegramPoller.stop()` in
full before closing the dispatcher. This covers an active long poll, attachment
download, or `onAccepted` callback rather than closing transport resources while any
polling-owned work is still running. Repeated or concurrent stops share one close
operation, and each dispatcher closes exactly once in its owning shutdown phase.

## Testing

The regression tests will prove the transport boundary without wall-clock timing:

- hold `getUpdates` at a synchronization barrier, initiate delivery, and prove the
  independent delivery fetch is invoked and completes before releasing polling;
- verify Node-resolved direct and proxy modes select the expected independent
  dispatcher type and preserve lowercase-over-uppercase values for `http_proxy`,
  `https_proxy`, and `no_proxy`;
- hold a polling-owned file download, stop the adapter, and prove the dispatcher
  closes only after that work settles;
- call stop repeatedly and concurrently, proving the dispatcher closes exactly once
  and every caller settles;
- all existing Telegram API, poller, delivery, production, and packaging tests remain
  green.

After automated verification, rebuild and reinstall the distributable binary, restart
the real bot, and repeat a live timing trace. Success means `sendMessage` body
transmission begins without waiting for the active `getUpdates` request to finish.

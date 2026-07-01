import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramTransports, effectiveProxyEnvironment } from "../../src/telegram/transport.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("delivery completes while long polling remains pending on its dedicated dispatcher", async () => {
  const pollStarted = deferred<void>();
  const releasePoll = deferred<void>();
  const pollingDispatcher = { close: async () => undefined };
  const deliveryDispatcher = { close: async () => undefined };
  const pollingDispatchers: unknown[] = [];
  const deliveryDispatchers: unknown[] = [];
  let deliveryCalls = 0;
  const transports = createTelegramTransports("token", {
    createDispatcher: (_configuration, role) => role === "polling" ? pollingDispatcher : deliveryDispatcher,
    pollingFetch: async (_input, init) => {
      pollingDispatchers.push(init?.dispatcher);
      pollStarted.resolve();
      await releasePoll.promise;
      return new Response(JSON.stringify({ ok: true, result: [] }));
    },
    deliveryFetch: async (_input, init) => {
      deliveryDispatchers.push(init?.dispatcher);
      deliveryCalls += 1;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }));
    },
  });

  const polling = transports.polling.getUpdates(0);
  await pollStarted.promise;
  assert.equal((await transports.delivery.sendMessage(1, "ready")).message_id, 7);
  assert.equal(deliveryCalls, 1);
  assert.deepEqual(pollingDispatchers, [pollingDispatcher]);
  assert.deepEqual(deliveryDispatchers, [deliveryDispatcher]);
  releasePoll.resolve();
  await polling;
});

test("polling dispatcher mirrors Node-resolved proxy mode and Undici variable precedence", async () => {
  const proxyEnv = {
    http_proxy: "http://lower-http.example",
    HTTP_PROXY: "http://upper-http.example",
    https_proxy: "http://lower-https.example",
    HTTPS_PROXY: "http://upper-https.example",
    no_proxy: "lower.example",
    NO_PROXY: "upper.example",
  };
  assert.equal(effectiveProxyEnvironment({ options: {} }), undefined);
  assert.equal(effectiveProxyEnvironment({ options: { proxyEnv } }), proxyEnv);

  const configurations: unknown[] = [];
  for (const resolved of [undefined, proxyEnv]) {
    const transports = createTelegramTransports("token", {
      proxyEnvironment: () => resolved,
      createDispatcher: (configuration) => { configurations.push(configuration); return { close: async () => undefined }; },
      pollingFetch: async () => new Response(JSON.stringify({ ok: true, result: [] })),
      deliveryFetch: async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
    });
    await transports.closePolling();
  }
  assert.deepEqual(configurations, [
    { kind: "direct" },
    { kind: "direct" },
    {
      kind: "env-proxy",
      httpProxy: "http://lower-http.example",
      httpsProxy: "http://lower-https.example",
      noProxy: "lower.example",
    },
    {
      kind: "env-proxy",
      httpProxy: "http://lower-http.example",
      httpsProxy: "http://lower-https.example",
      noProxy: "lower.example",
    },
  ]);
});

test("concurrent transport closes share one close per dispatcher", async () => {
  const closeStarted = deferred<void>();
  const releaseClose = deferred<void>();
  let pollingCloses = 0;
  let deliveryCloses = 0;
  const transports = createTelegramTransports("token", {
    createDispatcher: (_configuration, role) => ({ close: async () => {
      if (role === "polling") pollingCloses += 1;
      else deliveryCloses += 1;
      if (pollingCloses + deliveryCloses === 2) closeStarted.resolve();
      await releaseClose.promise;
    } }),
    pollingFetch: async () => new Response(JSON.stringify({ ok: true, result: [] })),
    deliveryFetch: async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
  });

  const first = transports.closePolling();
  const second = transports.closePolling();
  const deliveryFirst = transports.closeDelivery();
  const deliverySecond = transports.closeDelivery();
  await closeStarted.promise;
  assert.equal(pollingCloses, 1);
  assert.equal(deliveryCloses, 1);
  releaseClose.resolve();
  await Promise.all([first, second, deliveryFirst, deliverySecond, transports.closePolling(), transports.closeDelivery()]);
  assert.equal(pollingCloses, 1);
  assert.equal(deliveryCloses, 1);
});

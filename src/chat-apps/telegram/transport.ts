import { globalAgent as httpsGlobalAgent } from "node:https";
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { TelegramApi } from "./api.ts";

export type PollingDispatcherConfiguration =
  | { kind: "direct" }
  | { kind: "env-proxy"; httpProxy?: string; httpsProxy?: string; noProxy?: string };

export interface PollingDispatcher {
  close(): Promise<void>;
}

interface ProxyAwareAgent {
  options: { proxyEnv?: NodeJS.ProcessEnv };
}

type DispatcherFetch = (
  input: string | URL | Request,
  init?: RequestInit & { dispatcher?: unknown },
) => Promise<Response>;

export interface TelegramTransports {
  polling: Pick<TelegramApi, "getUpdates" | "downloadFile">;
  delivery: Pick<TelegramApi, "sendMessage" | "sendDocument">;
  closePolling(): Promise<void>;
  closeDelivery(): Promise<void>;
}

interface TelegramTransportDependencies {
  proxyEnvironment?: () => NodeJS.ProcessEnv | undefined;
  createDispatcher?: (configuration: PollingDispatcherConfiguration, role: "polling" | "delivery") => PollingDispatcher;
  pollingFetch?: DispatcherFetch;
  deliveryFetch?: DispatcherFetch;
}

export function effectiveProxyEnvironment(agent: ProxyAwareAgent = httpsGlobalAgent as ProxyAwareAgent): NodeJS.ProcessEnv | undefined {
  return agent.options.proxyEnv;
}

export function createTelegramTransports(token: string, dependencies: TelegramTransportDependencies = {}): TelegramTransports {
  const proxyEnv = dependencies.proxyEnvironment ? dependencies.proxyEnvironment() : effectiveProxyEnvironment();
  const configuration = dispatcherConfiguration(proxyEnv);
  const create = dependencies.createDispatcher ?? ((value: PollingDispatcherConfiguration) => createDispatcher(value));
  const pollingDispatcher = create(configuration, "polling");
  const deliveryDispatcher = create(configuration, "delivery");
  const pollingFetch = dependencies.pollingFetch ?? (undiciFetch as unknown as DispatcherFetch);
  const deliveryFetch = dependencies.deliveryFetch ?? (undiciFetch as unknown as DispatcherFetch);
  const fetchWith = (fetch: DispatcherFetch, dispatcher: PollingDispatcher): typeof globalThis.fetch =>
    (input, init) => fetch(input, { ...init, dispatcher });
  let closePollingPromise: Promise<void> | undefined;
  let closeDeliveryPromise: Promise<void> | undefined;

  return {
    polling: new TelegramApi(token, { fetch: fetchWith(pollingFetch, pollingDispatcher) }),
    delivery: new TelegramApi(token, { fetch: fetchWith(deliveryFetch, deliveryDispatcher) }),
    closePolling: () => closePollingPromise ??= pollingDispatcher.close(),
    closeDelivery: () => closeDeliveryPromise ??= deliveryDispatcher.close(),
  };
}

function dispatcherConfiguration(env: NodeJS.ProcessEnv | undefined): PollingDispatcherConfiguration {
  if (!env) return { kind: "direct" };
  const read = (lower: string, upper: string) => env[lower] ?? env[upper];
  const httpProxy = read("http_proxy", "HTTP_PROXY");
  const httpsProxy = read("https_proxy", "HTTPS_PROXY");
  const noProxy = read("no_proxy", "NO_PROXY");
  return {
    kind: "env-proxy",
    ...(httpProxy === undefined ? {} : { httpProxy }),
    ...(httpsProxy === undefined ? {} : { httpsProxy }),
    ...(noProxy === undefined ? {} : { noProxy }),
  };
}

function createDispatcher(configuration: PollingDispatcherConfiguration): PollingDispatcher {
  if (configuration.kind === "direct") return new Agent();
  return new EnvHttpProxyAgent({
    ...(configuration.httpProxy === undefined ? {} : { httpProxy: configuration.httpProxy }),
    ...(configuration.httpsProxy === undefined ? {} : { httpsProxy: configuration.httpsProxy }),
    ...(configuration.noProxy === undefined ? {} : { noProxy: configuration.noProxy }),
  });
}

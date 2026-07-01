import { globalAgent as httpsGlobalAgent } from "node:https";
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import type { ChatDeliveryAdapter } from "../chat/contracts.ts";
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
  delivery: ChatDeliveryAdapter;
  closePolling(): Promise<void>;
}

interface TelegramTransportDependencies {
  proxyEnvironment?: () => NodeJS.ProcessEnv | undefined;
  createDispatcher?: (configuration: PollingDispatcherConfiguration) => PollingDispatcher;
  pollingFetch?: DispatcherFetch;
  deliveryFetch?: typeof globalThis.fetch;
}

export function effectiveProxyEnvironment(agent: ProxyAwareAgent = httpsGlobalAgent as ProxyAwareAgent): NodeJS.ProcessEnv | undefined {
  return agent.options.proxyEnv;
}

export function createTelegramTransports(token: string, dependencies: TelegramTransportDependencies = {}): TelegramTransports {
  const proxyEnv = dependencies.proxyEnvironment ? dependencies.proxyEnvironment() : effectiveProxyEnvironment();
  const configuration = dispatcherConfiguration(proxyEnv);
  const dispatcher = dependencies.createDispatcher?.(configuration) ?? createDispatcher(configuration);
  const pollingFetch = dependencies.pollingFetch ?? (undiciFetch as unknown as DispatcherFetch);
  const deliveryFetch = dependencies.deliveryFetch ?? globalThis.fetch;
  const fetchWithDispatcher: typeof globalThis.fetch = (input, init) => pollingFetch(input, { ...init, dispatcher });
  let closePromise: Promise<void> | undefined;

  return {
    polling: new TelegramApi(token, { fetch: fetchWithDispatcher }),
    delivery: new TelegramApi(token, { fetch: deliveryFetch }),
    closePolling: () => closePromise ??= dispatcher.close(),
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

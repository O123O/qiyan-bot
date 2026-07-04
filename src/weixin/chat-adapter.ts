import type { ConversationBinding } from "../chat/binding.ts";
import type { ChatAdapter, ChatDeliveryAdapter } from "../chat/contracts.ts";
import { AppError } from "../core/errors.ts";
import type { WeixinAccountStore, WeixinAuthorizationIncidentSink } from "./account-store.ts";
import { WeixinApiError } from "./api-client.ts";
import type { WeixinCredentialPublic } from "./credential-store.ts";
import type { WeixinInboxStore } from "./inbox-store.ts";
import type { WeixinOutboundStore } from "./outbound-store.ts";
import type { ParsedUpdates } from "./protocol.ts";

interface WeixinLifecycleApi {
  getConfig(signal?: AbortSignal): Promise<unknown>;
  getUpdates(cursor: string, signal: AbortSignal, serverTimeoutMs?: number): Promise<ParsedUpdates>;
  notifyLifecycle(state: "start" | "stop", signal?: AbortSignal): Promise<void>;
  sendTyping?(state: "start" | "stop", signal?: AbortSignal): Promise<void>;
}

interface WeixinIngressPort {
  recoverAndDrain(): Promise<void>;
  scheduleDrain(): void;
  start(intervalMs?: number): void;
  stop(): Promise<void>;
}

interface ReconciledIncidentSink extends WeixinAuthorizationIncidentSink {
  reconcileUnwarned?(): Promise<void>;
}

interface WeixinChatAdapterOptions {
  credential: WeixinCredentialPublic;
  api: WeixinLifecycleApi;
  accounts: WeixinAccountStore;
  inbox: WeixinInboxStore;
  outbound: WeixinOutboundStore;
  ingress: WeixinIngressPort;
  delivery: ChatDeliveryAdapter;
  incidentSink: ReconciledIncidentSink;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  jitter?: () => number;
}

export interface WeixinAdapterHealth {
  state: "created" | "initialized" | "polling" | "backoff" | "authorization_inactive" | "stopped";
  consecutiveFailures: number;
  lastFailureCategory?: string;
}

export class WeixinChatAdapter implements ChatAdapter {
  readonly delivery: ChatDeliveryAdapter;
  readonly primaryBinding: ConversationBinding;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly jitter: () => number;
  private controller: AbortController | undefined;
  private polling: Promise<void> | undefined;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private initialized = false;
  private healthValue: WeixinAdapterHealth = { state: "created", consecutiveFailures: 0 };

  constructor(private readonly options: WeixinChatAdapterOptions) {
    this.delivery = options.delivery;
    this.sleep = options.sleep ?? abortableDelay;
    this.jitter = options.jitter ?? Math.random;
    this.primaryBinding = {
      adapterId: "weixin",
      conversationKey: `weixin:${options.credential.accountGenerationId}:${options.credential.ownerUserId}`,
      destination: {
        generationId: options.credential.accountGenerationId,
        botId: options.credential.botId,
        ownerUserId: options.credential.ownerUserId,
      },
    };
  }

  get health(): WeixinAdapterHealth { return { ...this.healthValue }; }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.options.accounts.prepareAuthenticatedProbe(this.options.credential);
    this.options.outbound.markDispatchingUncertain();
    try { await this.options.api.getConfig(); }
    catch (error) {
      const incident = authorizationIncident(error);
      if (!incident) throw error;
      await this.options.incidentSink.transition({
        generationId: this.options.credential.accountGenerationId,
        ...incident,
      });
      await this.options.incidentSink.reconcileUnwarned?.();
      this.initialized = true;
      this.healthValue = {
        state: "authorization_inactive",
        consecutiveFailures: 0,
        lastFailureCategory: incident.category,
      };
      return;
    }
    this.options.accounts.activate(this.options.credential);
    await this.options.ingress.recoverAndDrain();
    await this.options.incidentSink.reconcileUnwarned?.();
    this.initialized = true;
    this.healthValue = { state: "initialized", consecutiveFailures: 0 };
  }

  start(): Promise<void> {
    return this.serializeLifecycle(() => this.startInner());
  }

  stop(): Promise<void> {
    return this.serializeLifecycle(() => this.stopInner());
  }

  async close(): Promise<void> { await this.stop(); }

  async idle(): Promise<void> { await this.polling; }

  async sendTyping(state: "start" | "stop"): Promise<void> {
    try { await this.options.api.sendTyping?.(state, this.controller?.signal); }
    catch { /* typing is a best-effort presentation effect */ }
  }

  private async startInner(): Promise<void> {
    if (!this.initialized) throw new Error("WeChat adapter is not initialized");
    if (this.controller) return;
    if (this.options.accounts.authorization(this.options.credential.accountGenerationId) !== "active") {
      this.healthValue = { ...this.healthValue, state: "authorization_inactive" };
      return;
    }
    this.controller = new AbortController();
    this.options.ingress.start();
    await this.bestEffortLifecycle("start", this.controller.signal);
    this.healthValue = { state: "polling", consecutiveFailures: 0 };
    this.polling = this.poll(this.controller.signal).finally(() => { this.polling = undefined; });
  }

  private async stopInner(): Promise<void> {
    if (!this.controller && this.healthValue.state === "stopped") return;
    const controller = this.controller;
    controller?.abort();
    await this.polling?.catch(() => undefined);
    await this.options.ingress.stop();
    if (controller) await this.bestEffortLifecycle("stop");
    this.controller = undefined;
    this.healthValue = { ...this.healthValue, state: "stopped" };
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let failures = 0;
    let serverTimeoutMs: number | undefined;
    while (!signal.aborted) {
      try {
        try { this.options.accounts.requireActive(this.options.credential.accountGenerationId); }
        catch {
          const authorization = this.options.accounts.authorization(this.options.credential.accountGenerationId);
          this.healthValue = {
            state: "authorization_inactive",
            consecutiveFailures: failures,
            lastFailureCategory: authorization,
          };
          return;
        }
        this.healthValue = { state: "polling", consecutiveFailures: failures };
        const cursor = this.options.inbox.cursor(this.options.credential.accountGenerationId);
        const batch = await this.options.api.getUpdates(cursor, signal, serverTimeoutMs);
        this.options.inbox.commitPoll(this.options.credential.accountGenerationId, cursor, batch);
        this.options.ingress.scheduleDrain();
        serverTimeoutMs = batch.timeoutMs;
        failures = 0;
        this.healthValue = { state: "polling", consecutiveFailures: 0 };
      } catch (error) {
        if (signal.aborted || isAbort(error)) return;
        const incident = authorizationIncident(error);
        if (incident) {
          await this.options.incidentSink.transition({
            generationId: this.options.credential.accountGenerationId,
            ...incident,
          });
          this.healthValue = { state: "authorization_inactive", consecutiveFailures: failures, lastFailureCategory: incident.category };
          return;
        }
        failures += 1;
        const category = error instanceof WeixinApiError ? error.category : "unknown";
        this.healthValue = { state: "backoff", consecutiveFailures: failures, lastFailureCategory: category };
        const base = Math.min(30_000, 250 * 2 ** Math.min(failures - 1, 7));
        const jitter = Math.max(0, Math.min(1, this.jitter()));
        await this.sleep(base + Math.floor(base * 0.2 * jitter), signal);
      }
    }
  }

  private async bestEffortLifecycle(state: "start" | "stop", signal?: AbortSignal): Promise<void> {
    try { await this.options.api.notifyLifecycle(state, signal); }
    catch { /* lifecycle notification does not define chat state */ }
  }

  private serializeLifecycle(action: () => Promise<void>): Promise<void> {
    const run = this.lifecycleTail.then(action, action);
    this.lifecycleTail = run.catch(() => undefined);
    return run;
  }
}

export function authorizationIncident(error: unknown):
  | { state: "relogin_required"; category: "authorization" }
  | { state: "credential_changed"; category: "credential_changed" }
  | undefined {
  if (error instanceof WeixinApiError && error.options.protocolCode === -14) {
    return { state: "relogin_required", category: "authorization" };
  }
  if (error instanceof AppError && error.code === "CONFIGURATION_ERROR" && error.message.startsWith("WeChat credential")) {
    return { state: "credential_changed", category: "credential_changed" };
  }
  return undefined;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

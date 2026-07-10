import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import qrCodeTerminal from "qrcode-terminal";
import { AppError } from "../../core/errors.ts";
import { WeixinApiError } from "./api-client.ts";
import type { WeixinQrChallenge, WeixinQrState } from "./auth-client.ts";
import type {
  ConfirmedWeixinCredential,
  WeixinCredentialHandle,
  WeixinCredentialPublic,
} from "./credential-store.ts";

const MAX_QR_CHALLENGES = 3;
const MAX_VERIFICATION_PROMPTS = 3;

export interface WeixinLoginTerminal {
  renderQr(payload: string): void;
  promptVerificationCode(signal?: AbortSignal): Promise<string>;
  status(message: string): void;
}

export interface WeixinLoginCredentialStore {
  loadPinned(): Promise<WeixinCredentialHandle | undefined>;
  commitConfirmed(input: ConfirmedWeixinCredential): Promise<WeixinCredentialPublic>;
}

export interface WeixinLoginAuthClient {
  createQr(localToken?: string, signal?: AbortSignal): Promise<WeixinQrChallenge>;
  pollQr(challenge: WeixinQrChallenge, verificationCode?: string, signal?: AbortSignal): Promise<WeixinQrState>;
  probeCredential(credential: WeixinCredentialHandle, signal?: AbortSignal): Promise<void>;
}

export async function runWeixinLogin(input: {
  store: WeixinLoginCredentialStore;
  auth: WeixinLoginAuthClient;
  terminal: WeixinLoginTerminal;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<WeixinCredentialPublic> {
  throwIfAborted(input.signal);
  const prior = await input.store.loadPinned();
  let usePriorToken = prior !== undefined;
  let staleRestartUsed = false;
  let qrChallenges = 0;
  let verificationPrompts = 0;
  let pendingVerificationCode: string | undefined;

  const createChallenge = async (): Promise<WeixinQrChallenge> => {
    throwIfAborted(input.signal);
    if (qrChallenges >= MAX_QR_CHALLENGES) throw loginError("WeChat QR refresh limit reached");
    qrChallenges += 1;
    const challenge = usePriorToken && prior
      ? await prior.withVerifiedCredential((credential) => input.auth.createQr(credential.botToken, input.signal))
      : await input.auth.createQr(undefined, input.signal);
    input.terminal.status(qrChallenges === 1
      ? "Scan the WeChat QR code to authorize QiYan."
      : "The WeChat QR code was refreshed; scan the new code.");
    input.terminal.renderQr(challenge.payload);
    return challenge;
  };

  let challenge = await createChallenge();
  while (true) {
    throwIfAborted(input.signal);
    const state = await input.auth.pollQr(challenge, pendingVerificationCode, input.signal);
    switch (state.status) {
      case "wait":
        break;
      case "scaned":
        pendingVerificationCode = undefined;
        input.terminal.status("WeChat QR code scanned; waiting for confirmation.");
        break;
      case "scaned_but_redirect":
        challenge = { ...challenge, baseUrl: state.redirectBaseUrl };
        break;
      case "need_verifycode": {
        pendingVerificationCode = await promptForVerificationCode(input.terminal, input.signal, () => {
          verificationPrompts += 1;
          return verificationPrompts;
        });
        break;
      }
      case "verify_code_blocked":
        pendingVerificationCode = undefined;
        input.terminal.status("WeChat rejected the verification attempts; refreshing the QR code.");
        challenge = await createChallenge();
        break;
      case "expired":
        pendingVerificationCode = undefined;
        input.terminal.status("The WeChat QR code expired; refreshing it.");
        challenge = await createChallenge();
        break;
      case "binded_redirect": {
        if (!prior) throw loginError("WeChat reported an existing binding without a local credential");
        try {
          await input.auth.probeCredential(prior, input.signal);
          input.terminal.status("The existing WeChat authorization is still valid; no changes were made.");
          return prior.public;
        } catch (error) {
          if (!(error instanceof WeixinApiError) || error.category !== "authorization" || staleRestartUsed) throw error;
          staleRestartUsed = true;
          usePriorToken = false;
          pendingVerificationCode = undefined;
          input.terminal.status("The existing WeChat authorization is stale; starting one fresh authorization.");
          challenge = await createChallenge();
        }
        break;
      }
      case "confirmed": {
        if (!state.botToken || !state.botId || !state.ownerUserId) {
          throw loginError("WeChat login confirmation is incomplete");
        }
        const result = await input.store.commitConfirmed({
          botToken: state.botToken,
          botId: state.botId,
          ownerUserId: state.ownerUserId,
          apiBaseUrl: state.apiBaseUrl ?? challenge.baseUrl,
          authenticatedAt: (input.now ?? Date.now)(),
        });
        input.terminal.status("WeChat authorization completed. Restart QiYan to activate it.");
        return result;
      }
    }
  }
}

export function createNodeWeixinLoginTerminal(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): WeixinLoginTerminal {
  return {
    renderQr(payload) {
      qrCodeTerminal.generate(payload, { small: true }, (qr) => { output.write(`${qr}\n`); });
    },
    async promptVerificationCode(signal) {
      const terminal = createInterface({ input, output });
      try {
        const prompt = "Enter the numeric code shown in WeChat: ";
        return signal ? await terminal.question(prompt, { signal }) : await terminal.question(prompt);
      }
      finally { terminal.close(); }
    },
    status(message) { output.write(`${message}\n`); },
  };
}

async function promptForVerificationCode(
  terminal: WeixinLoginTerminal,
  signal: AbortSignal | undefined,
  nextAttempt: () => number,
): Promise<string> {
  while (true) {
    if (nextAttempt() > MAX_VERIFICATION_PROMPTS) throw loginError("WeChat verification attempt limit reached");
    const code = (await terminal.promptVerificationCode(signal)).trim();
    if (/^\d{4,12}$/u.test(code)) return code;
    terminal.status("The WeChat verification code must contain 4 to 12 digits.");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
}

function loginError(message: string): AppError {
  return new AppError("CONFIGURATION_ERROR", message);
}

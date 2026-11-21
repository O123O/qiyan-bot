export type ErrorCode =
  | "CONFIGURATION_ERROR"
  | "UNKNOWN_SESSION"
  | "AMBIGUOUS_SESSION"
  | "SESSION_DETACHED"
  | "SESSION_BUSY"
  | "SESSION_IDLE"
  | "THREAD_NOT_FOUND"
  | "CWD_MISMATCH"
  | "ENDPOINT_UNAVAILABLE"
  | "ENDPOINT_IDENTITY_CHANGED"
  | "UNSUPPORTED_CAPABILITY"
  | "DIRECTIVE_MISMATCH"
  | "DIRECTIVE_ALREADY_CONSUMED"
  | "ATTACHMENT_INVALID"
  | "DELIVERY_FAILED"
  | "DELIVERY_UNCERTAIN"
  | "OPERATION_CONFLICT"
  | "OPERATION_FAILED"
  | "OPERATION_UNCERTAIN"
  | "CAPACITY_EXCEEDED"
  | "PERMISSION_BLOCKED";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class StartupPhaseError extends Error {
  constructor(
    readonly phase: string,
    override readonly cause: unknown,
  ) {
    super("application startup failed", { cause });
    this.name = "StartupPhaseError";
  }
}

const OBSERVED_OUTCOME = Symbol("qiyan.observedOutcome");

// What a failed side-effecting call turned out to have done, established by LOOKING at the target
// after the fact rather than by inferring it from whatever the ledger happened to record before
// the call died.
//
// The ledger can only ever answer "how far did we get before we lost contact", and for a verb
// whose effect is observable that is the wrong question. An endpoint restart has a crisp ground
// truth -- the runtime either still carries the identity the action set out to stop, or it does
// not -- so "it may have taken effect" is a statement about nobody having asked, not about the
// world being unknowable.
//
// `no_effect`: the target was inspected and provably still holds what the call set out to change.
// `unknown_on_host`: the target could not be inspected, so what it did is genuinely unknown -- but
// the CALL is over and failed, which is an answer the caller can act on. It is deliberately still
// terminal: an unsettled row fences every later lifecycle action on its endpoint, and on an
// unreachable endpoint a later lifecycle action is the only remaining move. Nothing is risked by
// releasing it, because the ledger is not what stops a second runtime from starting -- the runtime
// attests its identity on the host, and a start refuses over a live supervised one whatever the
// ledger says.
export type ObservedOutcome = "no_effect" | "unknown_on_host";

export function tagObservedOutcome<E extends Error>(error: E, outcome: ObservedOutcome): E {
  return Object.assign(error, { [OBSERVED_OUTCOME]: outcome });
}

export function observedOutcome(error: unknown): ObservedOutcome | undefined {
  return error instanceof Error
    ? (error as Error & { [OBSERVED_OUTCOME]?: ObservedOutcome })[OBSERVED_OUTCOME]
    : undefined;
}

// A codex turn failure is DATA, not a thrown error: the app-server reports it as
// `{ message, codexErrorInfo, additionalDetails }` on the turn itself, and `codexErrorInfo` is
// either a bare string ("serverOverloaded") or a single-key object carrying an http status
// (`{ httpConnectionFailed: { httpStatusCode } }`). This reads the code out of either shape.
export function codexErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const info = (error as { codexErrorInfo?: unknown }).codexErrorInfo;
  if (typeof info === "string") return info;
  return info && typeof info === "object" && !Array.isArray(info) ? Object.keys(info)[0] : undefined;
}

// The journal takes a token (safeToken only accepts a lowercase slug); the owner-facing notice
// takes the readable detail. Splitting them means the chat message can name the actual cause
// without the journal degrading it to "unknown".
export function describeAttemptFailure(error: unknown): { token: string; detail: string } {
  const detail = (value: string): string => {
    const line = value.replace(/\s+/gu, " ").trim();
    return line.length > 300 ? `${line.slice(0, 299)}\u2026` : line;
  };
  if (error instanceof AppError) return { token: error.code.toLowerCase(), detail: detail(`${error.code}: ${error.message}`) };
  if (error instanceof Error) return { token: "exception", detail: detail(error.message || error.name) };
  if (typeof error === "string" && error.length > 0) {
    return { token: /^[a-z][a-z0-9_-]{0,63}$/u.test(error) ? error : "unknown", detail: detail(error) };
  }
  // A failed codex turn arrives here as that plain object, which is neither an Error nor a
  // string, so it used to fall all the way through to "no cause was recorded" -- about an
  // outage codex had already classified for us. Measured 2026-11-20 20:10-20:14 UTC: three
  // assistant turns lost to `failed to connect to Responses WebSocket`, each reported as
  // `assistant_attempt_failed reason=unknown` and announced to the owner as having no cause.
  // The code is lower-cased rather than re-spelled, so it reads the same here as it does on
  // the worker line (`turn_retry_scheduled reason=httpconnectionfailed`) that names it today.
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    const additional = (error as { additionalDetails?: unknown }).additionalDetails;
    const text = [message, additional].filter((part): part is string => typeof part === "string" && part.length > 0).join(" -- ");
    const code = codexErrorCode(error);
    if (code !== undefined) return { token: code.toLowerCase(), detail: detail(text || code) };
    // `codexErrorInfo` present but null is codex saying it has no classification for this
    // failure -- which still tells us a TURN failed, and is the discriminator for the shape.
    // Without that key this is some other library's rejected value: its message is worth
    // carrying, but naming it a turn failure would assert something nothing here has shown.
    if ("codexErrorInfo" in error) return { token: "turn_failed", detail: detail(text || "turn failed") };
    if (text) return { token: "unknown", detail: detail(text) };
  }
  return { token: "unknown", detail: "no cause was recorded" };
}

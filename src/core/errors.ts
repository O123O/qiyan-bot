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

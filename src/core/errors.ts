export type ErrorCode =
  | "UNKNOWN_SESSION"
  | "AMBIGUOUS_SESSION"
  | "SESSION_DETACHED"
  | "SESSION_BUSY"
  | "SESSION_IDLE"
  | "THREAD_NOT_FOUND"
  | "CWD_MISMATCH"
  | "ENDPOINT_UNAVAILABLE"
  | "UNSUPPORTED_CAPABILITY"
  | "DIRECTIVE_MISMATCH"
  | "DIRECTIVE_ALREADY_CONSUMED"
  | "ATTACHMENT_INVALID"
  | "DELIVERY_FAILED"
  | "DELIVERY_UNCERTAIN"
  | "OPERATION_CONFLICT"
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

export type OperationalEventCode =
  | "chat_ingress_started"
  | "chat_input_accepted"
  | "chat_input_ignored"
  | "chat_ingress_failed"
  | "chat_ingress_recovered"
  | "chat_connection_lost"
  | "chat_reconnect_failed"
  | "chat_connection_reconnected"
  | "assistant_turn_started"
  | "assistant_turn_steered"
  | "assistant_submission_uncertain"
  | "assistant_turn_terminal"
  | "delivery_failed"
  | "database_metadata_recovered"
  | "database_metadata_recovery_required"
  | "background_task_failed";

export interface OperationalEvent {
  level: "info" | "warn";
  code: OperationalEventCode;
  adapter?: string;
  reason?: string;
  component?: string;
  consecutiveFailures?: number;
}

export type OperationalEventSink = (event: OperationalEvent) => void;

export function createOperationalLogSink(
  write: (line: string) => void = (line) => { process.stderr.write(line); },
): OperationalEventSink {
  return (event) => {
    const fields = [`event=${safeToken(event.code)}`];
    if (event.adapter !== undefined) fields.push(`adapter=${safeToken(event.adapter)}`);
    if (event.reason !== undefined) fields.push(`reason=${safeToken(event.reason)}`);
    if (event.component !== undefined) fields.push(`component=${safeToken(event.component)}`);
    if (event.consecutiveFailures !== undefined) fields.push(`consecutive_failures=${safeCount(event.consecutiveFailures)}`);
    try { write(`qiyan-bot: ${event.level.toUpperCase()} ${fields.join(" ")}\n`); }
    catch { /* operational logging must not change runtime behavior */ }
  };
}

function safeToken(value: string): string {
  return /^[a-z][a-z0-9_-]{0,63}$/u.test(value) ? value : "unknown";
}

function safeCount(value: number): string {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? String(value) : "unknown";
}

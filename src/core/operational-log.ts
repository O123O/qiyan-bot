export type OperationalEventCode =
  // Recording what the web panel displayed is best-effort; routing the notification is not.
  // Managed sessions stopped being retried on this endpoint, with the reason they stopped. The
  // next reconnect re-enters them, so this is not a terminal state and may repeat.
  | "managed_session_parked"
  | "owner_transcript_record_failed"
  // A created worker whose thread was not materialized is one reconcile away from being reaped.
  | "worker_thread_not_materialized"
  | "chat_ingress_started"
  | "chat_input_accepted"
  | "direct_to_delivered"
  | "direct_to_failed"
  | "web_ui_lan_exposure"
  | "chat_input_ignored"
  | "chat_ingress_failed"
  | "startup_phase_completed"
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
  | "worker_scheduling_unavailable"
  // A managed Claude session inherits the user's own permission settings; "default" mode
  // denies every tool call, so an unattended worker silently does nothing without this.
  | "claude_permission_mode"
  | "endpoint_recovery_paused"
  | "endpoint_reconnect_gave_up"
  | "endpoint_connection_lost"
  | "endpoint_runtime_reclaimed"
  | "background_task_failed";

export interface OperationalEvent {
  level: "info" | "warn";
  code: OperationalEventCode;
  adapter?: string;
  endpoint?: string;
  reason?: string;
  component?: string;
  consecutiveFailures?: number;
  sessions?: number;
  phase?: string;
  elapsedMs?: number;
}

export type OperationalEventSink = (event: OperationalEvent) => void;

export function createOperationalLogSink(
  write: (line: string) => void = (line) => { process.stderr.write(line); },
): OperationalEventSink {
  return (event) => {
    const fields = [`event=${safeToken(event.code)}`];
    if (event.adapter !== undefined) fields.push(`adapter=${safeToken(event.adapter)}`);
    if (event.endpoint !== undefined) fields.push(`endpoint=${safeToken(event.endpoint)}`);
    if (event.reason !== undefined) fields.push(`reason=${safeToken(event.reason)}`);
    if (event.component !== undefined) fields.push(`component=${safeToken(event.component)}`);
    if (event.consecutiveFailures !== undefined) fields.push(`consecutive_failures=${safeCount(event.consecutiveFailures)}`);
    if (event.sessions !== undefined) fields.push(`sessions=${safeCount(event.sessions)}`);
    if (event.phase !== undefined) fields.push(`phase=${safeToken(event.phase)}`);
    if (event.elapsedMs !== undefined) fields.push(`elapsed_ms=${safeCount(event.elapsedMs)}`);
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

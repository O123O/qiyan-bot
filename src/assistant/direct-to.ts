import type { OperationalEvent } from "../core/operational-log.ts";
import type { CanonicalChatSource } from "../core/types.ts";
import type { InternalSource } from "../storage/conversation-store.ts";

export interface DirectToDeps {
  // True if this exact `/to` ingress message was already handled (idempotency across retries).
  alreadyDelivered(sourceId: string): boolean;
  // Deliver verbatim text to a named worker (SessionService.send).
  send(nickname: string, text: string, options: { mode: "auto"; clientUserMessageId: string }): Promise<unknown>;
  // Record the assistant's awareness copy as an INTERNAL source (source_class 'internal') — it is
  // never steered into a live chat attempt, so a directive embedded in the payload cannot hijack an
  // unrelated send. Idempotent on (kind, sourceId).
  recordAwareness(input: InternalSource): void;
  // Trigger the assistant to process the internal awareness source.
  pump(): void;
  // Ack the native ingress checkpoint so the surface does not redeliver this message.
  commitCheckpoint(): void;
  report(event: OperationalEvent): void;
}

// Handle a `/to <worker> <text>` ingress directive: deliver the text DIRECTLY to that worker
// (deterministic target + verbatim content, in parallel — not routed by the serialized
// assistant), then hand the assistant an awareness copy (an internal source it records but never
// replies to; the policy for that copy lives in AGENTS.md). Idempotent per ingress message. A
// delivery failure is non-fatal and is itself reported to the assistant as an informational note.
export async function deliverDirectTo(
  deps: DirectToDeps,
  source: CanonicalChatSource,
  target: string,
  payload: string,
): Promise<void> {
  const sourceId = `direct_to:${source.nativeSourceId}`;
  // Idempotency: on redelivery (the marker exists) do nothing but re-ack the ingress checkpoint.
  if (deps.alreadyDelivered(sourceId)) { deps.commitCheckpoint(); return; }

  let failure: string | undefined;
  try {
    await deps.send(target, payload, { mode: "auto", clientUserMessageId: `to:${source.nativeSourceId}` });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  // `/to` is text-only for now; make a dropped attachment visible rather than silent.
  const dropped = source.attachmentIds.length > 0 ? ` (${source.attachmentIds.length} attachment(s) were NOT forwarded — /to is text-only for now)` : "";
  const note = failure
    ? `[direct message could NOT be delivered to worker "${target}" (${failure}); no action needed]${dropped}\n${payload}`
    : `[the user sent this directly to worker "${target}"; for your awareness only — do not reply or resend]${dropped}\n${payload}`;
  deps.recordAwareness({ id: `direct-to-note:${source.id}`, kind: "direct_to", sourceId, rawText: note, attachmentIds: [], receivedAt: source.receivedAt });
  deps.commitCheckpoint();
  deps.pump();
  deps.report({
    level: failure ? "warn" : "info",
    code: failure ? "direct_to_failed" : "direct_to_delivered",
    adapter: source.binding.adapterId,
  });
}

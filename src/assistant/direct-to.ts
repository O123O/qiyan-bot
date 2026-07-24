import type { OperationalEvent } from "../core/operational-log.ts";
import type { CanonicalChatSource } from "../core/types.ts";
import type { InternalSource } from "../storage/conversation-store.ts";

export interface DirectToDeps {
  // True if this exact `/to` ingress message was already handled (idempotency across retries).
  alreadyDelivered(sourceId: string): boolean;
  // Deliver verbatim text to a named worker (SessionService.send).
  send(nickname: string, text: string, options: { mode: "auto"; clientUserMessageId: string }): Promise<unknown>;
  // Record a completed audit row. It is never eligible for an assistant turn.
  recordAudit(input: InternalSource, ownerEcho?: CanonicalChatSource): void;
  // Ack the native ingress checkpoint so the surface does not redeliver this message.
  commitCheckpoint(): void;
  report(event: OperationalEvent): void;
}

// Handle a `/to <worker> <text>` ingress directive: deliver the text DIRECTLY to that worker
// (deterministic target + verbatim content, in parallel — not routed by the serialized
// assistant). The ingress is recorded for idempotency and audit, but never wakes QiYan.
export async function deliverDirectTo(
  deps: DirectToDeps,
  source: CanonicalChatSource,
  target: string,
  payload: string,
  ownerDisplayText?: string,
): Promise<{ delivered: boolean; error?: string }> {
  const sourceId = `direct_to:${source.nativeSourceId}`;
  // Idempotency: on redelivery (the marker exists) do nothing but re-ack the ingress checkpoint.
  // Legacy markers predate the panel-origin discriminator, so they cannot safely be backfilled into
  // the QiYan transcript: some came from worker panels. New audit + owner-echo rows commit atomically.
  if (deps.alreadyDelivered(sourceId)) { deps.commitCheckpoint(); return { delivered: true }; }

  let failure: string | undefined;
  try {
    await deps.send(target, payload, { mode: "auto", clientUserMessageId: `to:${source.nativeSourceId}` });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  // `/to` is text-only for now; make a dropped attachment visible rather than silent.
  const dropped = source.attachmentIds.length > 0 ? ` (${source.attachmentIds.length} attachment(s) were NOT forwarded — /to is text-only for now)` : "";
  const note = failure
    ? `[direct message could NOT be delivered to worker "${target}" (${failure})]${dropped}\n${payload}`
    : `[direct message delivered to worker "${target}"]${dropped}\n${payload}`;
  deps.recordAudit(
    { id: `direct-to-note:${source.id}`, kind: "direct_to", sourceId, rawText: note, attachmentIds: [], receivedAt: source.receivedAt },
    !failure && ownerDisplayText ? { ...source, rawText: ownerDisplayText, attachmentIds: [] } : undefined,
  );
  deps.commitCheckpoint();
  deps.report({
    level: failure ? "warn" : "info",
    code: failure ? "direct_to_failed" : "direct_to_delivered",
    adapter: source.binding.adapterId,
  });
  return failure ? { delivered: false, error: failure } : { delivered: true };
}

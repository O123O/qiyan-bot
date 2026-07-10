import type { DeliveryStore } from "../storage/delivery-store.ts";
import type { ConversationBinding } from "../chat/binding.ts";
import { EndpointAuthenticationRequiredError } from "../app-server/managed-endpoint.ts";
import { AppError } from "../core/errors.ts";

export function assistantAuthenticationStartupError(error: unknown): unknown {
  if (!(error instanceof EndpointAuthenticationRequiredError)) return error;
  return new AppError(
    "CONFIGURATION_ERROR",
    "assistant Codex authentication is unavailable; run qiyan-bot assistant-login with the configured DATA_DIR",
    { reason: "assistant_auth_required", endpointId: error.endpointId },
  );
}

export function recordAssistantAuthenticationFailure(
  deliveries: DeliveryStore,
  binding: () => ConversationBinding,
  incident: number,
): void {
  deliveries.prepare({
    id: `assistant-auth-required:${incident}`,
    kind: "system_warning",
    binding: binding(),
    body: "[system] assistant Codex authentication is unavailable; run qiyan-bot assistant-login with the configured DATA_DIR",
    mandatory: true,
  });
}

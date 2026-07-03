import type { DeliveryStore } from "../storage/delivery-store.ts";
import type { ConversationBinding } from "../chat/binding.ts";

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

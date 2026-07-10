import { AppError } from "../../core/errors.ts";
import type { ConversationBinding, JsonValue } from "./binding.ts";
import type { ChatAdapterCapabilities, ChatDeliveryAdapter, ChatHistoryRequest } from "./contracts.ts";

export class ChatAdapterRegistry {
  private readonly adapters = new Map<string, ChatAdapterCapabilities>();

  constructor(adapters: readonly ChatAdapterCapabilities[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.delivery.id)) throw new AppError("CONFIGURATION_ERROR", `duplicate chat adapter: ${adapter.delivery.id}`);
      this.adapters.set(adapter.delivery.id, adapter);
    }
  }

  delivery(id: string): ChatDeliveryAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new AppError("CONFIGURATION_ERROR", `unknown chat adapter: ${id}`);
    return adapter.delivery;
  }

  async getHistory(binding: ConversationBinding, request: ChatHistoryRequest): Promise<JsonValue> {
    const adapter = this.adapters.get(binding.adapterId);
    if (!adapter) throw new AppError("CONFIGURATION_ERROR", `unknown chat adapter: ${binding.adapterId}`);
    if (!adapter.history) throw new AppError("UNSUPPORTED_CAPABILITY", `${binding.adapterId} does not support chat history retrieval`);
    return adapter.history.getHistory(binding, request);
  }
}

import type { ConversationBinding, JsonValue } from "./binding.ts";
import type { Database } from "../../storage/database.ts";

export class OwnerRouteStore {
  private readonly fallback: ConversationBinding;

  constructor(private readonly db: Database, primary: ConversationBinding) {
    this.fallback = copyBinding(primary);
  }

  current(): ConversationBinding {
    const row = this.db.prepare("SELECT adapter_id, conversation_key, destination_json, reply_json FROM latest_owner_route WHERE singleton = 1")
      .get() as Record<string, unknown> | undefined;
    if (!row) return copyBinding(this.fallback);
    return {
      adapterId: String(row.adapter_id),
      conversationKey: String(row.conversation_key),
      destination: JSON.parse(String(row.destination_json)) as JsonValue,
      ...(row.reply_json ? { reply: JSON.parse(String(row.reply_json)) as JsonValue } : {}),
    };
  }
}

export class OwnerRouteCatalog {
  private readonly bindings: readonly ConversationBinding[];
  private readonly primary: ConversationBinding;

  constructor(bindings: readonly ConversationBinding[], primaryAdapterId: string) {
    const seen = new Set<string>();
    this.bindings = bindings.map((binding) => {
      if (seen.has(binding.adapterId)) throw new TypeError(`duplicate owner route adapter: ${binding.adapterId}`);
      seen.add(binding.adapterId);
      return copyBinding(binding);
    });
    const primary = this.bindings.find((binding) => binding.adapterId === primaryAdapterId);
    if (!primary) throw new TypeError("primary owner route is unavailable");
    this.primary = primary;
  }

  warningRoute(input: { failedAdapterId: string; current?: ConversationBinding }): ConversationBinding | undefined {
    const current = input.current;
    if (current && current.adapterId !== input.failedAdapterId
      && this.bindings.some((binding) => binding.adapterId === current.adapterId)) return copyBinding(current);
    if (this.primary.adapterId !== input.failedAdapterId) return copyBinding(this.primary);
    const fallback = this.bindings.find((binding) => binding.adapterId !== input.failedAdapterId);
    return fallback ? copyBinding(fallback) : undefined;
  }
}

function copyBinding(binding: ConversationBinding): ConversationBinding {
  return {
    adapterId: binding.adapterId,
    conversationKey: binding.conversationKey,
    destination: structuredClone(binding.destination),
    ...(binding.reply === undefined ? {} : { reply: structuredClone(binding.reply) }),
  };
}

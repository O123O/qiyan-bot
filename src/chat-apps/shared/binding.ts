export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ConversationBinding {
  adapterId: string;
  conversationKey: string;
  destination: JsonValue;
  reply?: JsonValue;
}

// Takes the identifying half rather than a whole binding: a caller that knows only which
// conversation something belongs to -- a pending candidate, say -- is asking the same question,
// and should not have to invent a destination to ask it.
type ConversationIdentity = Pick<ConversationBinding, "adapterId" | "conversationKey">;

export function sameConversation(left: ConversationIdentity, right: ConversationIdentity): boolean {
  return left.adapterId === right.adapterId && left.conversationKey === right.conversationKey;
}

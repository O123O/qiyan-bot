export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ConversationBinding {
  adapterId: string;
  conversationKey: string;
  destination: JsonValue;
  reply?: JsonValue;
}

export function sameConversation(left: ConversationBinding, right: ConversationBinding): boolean {
  return left.adapterId === right.adapterId && left.conversationKey === right.conversationKey;
}

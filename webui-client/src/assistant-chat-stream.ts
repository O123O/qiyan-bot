export interface AssistantConversationMessage {
  id?: string;
  at?: number;
  completedAt?: number;
  turnId?: string;
  phase?: string;
  role?: "you" | "assistant" | "worker";
}

function deduplicate<T extends AssistantConversationMessage>(messages: readonly T[]): T[] {
  const result: T[] = [];
  const positions = new Map<string, number>();
  for (const message of messages) {
    if (!message.id) {
      result.push(message);
      continue;
    }
    const existing = positions.get(message.id);
    if (existing === undefined) {
      positions.set(message.id, result.length);
      result.push(message);
    } else result[existing] = message;
  }
  return result;
}

const timestamp = (message: AssistantConversationMessage): number => message.completedAt ?? message.at ?? 0;

export function mergeAssistantConversation<T extends AssistantConversationMessage>(
  durableInput: readonly T[],
  liveInput: readonly T[],
): T[] {
  const durable = deduplicate(durableInput);
  const durableIds = new Set(durable.flatMap((message) => message.id ? [message.id] : []));
  const replacedLiveIds = new Set<string>();
  const finalizedTurns = new Set<string>();
  for (const message of durable) {
    const commentary = /^assistant-commentary:([^:]+):(.+)$/u.exec(message.id ?? "");
    if (commentary) replacedLiveIds.add(`a:${commentary[1]}:${commentary[2]}`);
    const final = /^assistant:([^:]+)$/u.exec(message.id ?? "");
    if (final) finalizedTurns.add(final[1]!);
  }
  const live = deduplicate(liveInput).map((message) => (
    message.role === "assistant" ? message : { ...message, role: "assistant" } as T
  )).filter((message) => {
    if (message.id && (durableIds.has(message.id) || replacedLiveIds.has(message.id))) return false;
    return !(message.phase === "final_answer" && message.turnId && finalizedTurns.has(message.turnId));
  });
  return [...durable, ...live].sort((left, right) => timestamp(left) - timestamp(right));
}

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

// Folds the newest page into whatever scroll-up has already loaded. A reconnect refetches this
// page to close the gap it opened, and that refetch used to replace `history` outright -- so every
// socket blip threw away every page read back and snapped the view to the last handful. It also
// erased your own messages specifically: the live stream drops role "you" (they are durable, not
// streamed), so assistant rows survived a wipe in the live log and yours did not.
//
// Replacing was not arbitrary, though. `history` is one contiguous run paged backwards from its
// oldest row, so if more than a page arrived while the socket was down, the newest page starts
// past what we hold and nothing would ever fetch the rows between -- a hole no cursor can reach.
// The page's own oldest row decides which case this is: already loaded means the two runs touch
// and merging keeps the run contiguous; absent means there is a hole, and replacing is still the
// only honest answer.
export function mergeAssistantHistoryPage<T extends AssistantConversationMessage>(
  loaded: readonly T[],
  latestPage: readonly T[],
): T[] {
  const page = deduplicate(latestPage).sort((left, right) => timestamp(left) - timestamp(right));
  if (loaded.length === 0) return page;
  const oldest = page[0];
  const loadedIds = new Set(loaded.flatMap((message) => message.id ? [message.id] : []));
  if (!oldest?.id || !loadedIds.has(oldest.id)) return page;
  return deduplicate([...loaded, ...page]).sort((left, right) => timestamp(left) - timestamp(right));
}

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

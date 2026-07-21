export interface CommandSuggestion {
  id: string;
  label: string;
  insert: string;
  description: string;
}

export const ASSISTANT_COMMAND_SUGGESTIONS: readonly CommandSuggestion[] = [
  { id: "pass", label: "/pass <message>", insert: "/pass ", description: "Send exact text through QiYan to a worker." },
  { id: "collect", label: "/collect [count]", insert: "/collect ", description: "Deliver recent worker final messages directly." },
  { id: "to", label: "/to <worker> <message>", insert: "/to ", description: "Send a direct message to a worker." },
];

export function filterCommandSuggestions(
  text: string,
  suggestions: readonly CommandSuggestion[],
): readonly CommandSuggestion[] {
  if (!text.startsWith("/") || /[\r\n]/u.test(text)) return [];
  const query = text.toLowerCase();
  return suggestions.filter(({ label }) => label.toLowerCase().startsWith(query));
}

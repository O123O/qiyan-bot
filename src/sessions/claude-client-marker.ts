const clientMarkerPattern = /<!--\s*qiyan-cid:([A-Za-z0-9:_.-]{1,256})\s*-->/u;

// Read-only compatibility for transcripts written by QiYan versions that appended
// correlation metadata to Claude prompts. New turns always preserve exact user input.

function messageText(message: unknown): string {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => (
    block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string"
      ? [(block as Record<string, unknown>).text as string]
      : []
  )).join("\n");
}

export function extractClaudeClientMarker(message: unknown): string | undefined {
  return clientMarkerPattern.exec(messageText(message))?.[1];
}

export function isClaudeInternalTaskNotification(message: unknown): boolean {
  const text = messageText(message).trim();
  return text.startsWith("<task-notification>") && text.endsWith("</task-notification>");
}

export function visibleClaudeUserText(message: unknown): string {
  return messageText(message).replace(clientMarkerPattern, "").trim();
}

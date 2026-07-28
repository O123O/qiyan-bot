interface AssistantMessageLike {
  role?: "you" | "assistant" | "worker";
  worker?: string;
  origin?: string;
}

export interface AssistantMessagePresentation {
  className: "qiyan" | "worker-relay";
  label: string;
}

// `worker` is trusted delivery provenance. `origin` only chooses a host for file links and must not
// change who the UI says authored the message (old relays intentionally have no routable origin).
export function assistantMessagePresentation(message: AssistantMessageLike): AssistantMessagePresentation | null {
  if (message.role !== "assistant") return null;
  return message.worker
    ? { className: "worker-relay", label: `Worker · ${message.worker}` }
    : { className: "qiyan", label: "QiYan" };
}

export function workerMentionDraft(draft: string, worker: string): string {
  const body = draft.trimStart().replace(/^@[a-z0-9][a-z0-9_-]*(?:\s+|$)/iu, "");
  return `@${worker} ${body}`;
}

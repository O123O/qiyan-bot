import type { ConversationBinding } from "../shared/binding.ts";

export interface SlackFileDescriptor {
  slackFileId: string;
  displayName: string;
  mediaType: string;
  declaredSize?: number;
  downloadUrl?: string;
}

export interface NormalizedSlackEvent {
  eventId: string;
  eventType: "app_mention" | "message.channels" | "message.groups" | "message.im";
  teamId: string;
  channelId: string;
  messageTs: string;
  threadTs?: string;
  userId: string;
  rawText: string;
  files: readonly SlackFileDescriptor[];
  nativeSourceId: string;
  sourceId: string;
  binding: ConversationBinding;
  activate: boolean;
  receivedAt: number;
}

export type SlackEventClassification =
  | { kind: "discard" }
  | { kind: "accept"; event: NormalizedSlackEvent };

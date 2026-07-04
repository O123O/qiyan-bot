import type {
  ParsedFileItem,
  ParsedImageItem,
  ParsedMessageCandidate,
  WeixinMessageIdentity,
} from "./protocol.ts";

export interface WeixinOwnerIdentity {
  botId: string;
  ownerUserId: string;
}

export type WeixinClassifiedItem =
  | { kind: "text"; text: string; source?: "voice" }
  | { kind: "image"; image: ParsedImageItem }
  | { kind: "file"; file: ParsedFileItem }
  | { kind: "failed"; reason: "voice_without_transcription" | "video_unsupported" | "item_unsupported" };

export interface WeixinClassifiedMessage {
  ordinal: number;
  identity: WeixinMessageIdentity;
  contextToken?: string;
  items: readonly WeixinClassifiedItem[];
}

export function classifyWeixinMessage(
  candidate: ParsedMessageCandidate,
  identity: WeixinOwnerIdentity,
): WeixinClassifiedMessage | undefined {
  if (candidate.status !== "valid"
    || candidate.fromUserId !== identity.ownerUserId
    || candidate.toUserId !== identity.botId
    || (candidate.messageType !== undefined && candidate.messageType !== 1)
    || candidate.groupId !== undefined) return undefined;
  const items = candidate.items.map((item): WeixinClassifiedItem => {
    switch (item.kind) {
      case "text": return { kind: "text", text: item.text };
      case "voice": return item.transcription === undefined
        ? { kind: "failed", reason: "voice_without_transcription" }
        : { kind: "text", text: item.transcription, source: "voice" };
      case "image": return { kind: "image", image: item.image };
      case "file": return { kind: "file", file: item.file };
      case "video": return { kind: "failed", reason: "video_unsupported" };
      case "unknown": return { kind: "failed", reason: "item_unsupported" };
    }
  });
  return {
    ordinal: candidate.ordinal,
    identity: candidate.identity,
    ...(candidate.contextToken === undefined ? {} : { contextToken: candidate.contextToken }),
    items,
  };
}

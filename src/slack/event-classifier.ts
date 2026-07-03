import { basename } from "node:path";
import type { ConversationBinding } from "../chat/binding.ts";
import type { NormalizedSlackEvent, SlackEventClassification, SlackFileDescriptor } from "./types.ts";

export interface SlackClassificationContext {
  teamId: string;
  ownerUserId: string;
  botUserId: string;
  now(): number;
  isActivated(conversationKey: string): boolean;
}

export function classifySlackEvent(value: unknown, context: SlackClassificationContext): SlackEventClassification {
  const body = record(value);
  const event = record(body?.event);
  if (!body || !event || body.type !== "event_callback" || body.team_id !== context.teamId) return discard();
  const eventId = string(body.event_id);
  const type = string(event.type);
  const channelId = string(event.channel);
  const userId = string(event.user);
  const messageTs = string(event.ts);
  if (!eventId || !channelId || !userId || !messageTs || userId !== context.ownerUserId) return discard();
  const subtype = string(event.subtype);
  if (event.bot_id != null || event.app_id != null || event.hidden === true) return discard();
  if (subtype && !(type === "message" && subtype === "file_share")) return discard();

  const threadTs = string(event.thread_ts);
  let eventType: NormalizedSlackEvent["eventType"];
  let conversationKey: string;
  let destination: ConversationBinding["destination"];
  let activate = false;
  let rawText = string(event.text) ?? "";

  if (type === "app_mention") {
    const root = threadTs ?? messageTs;
    eventType = "app_mention";
    conversationKey = `slack:${context.teamId}:thread:${channelId}:${root}`;
    destination = { workspaceId: context.teamId, channelId, threadTs: root };
    activate = true;
    rawText = stripLeadingMention(rawText, context.botUserId);
  } else if (type === "message" && event.channel_type === "im") {
    eventType = "message.im";
    conversationKey = `slack:${context.teamId}:dm:${channelId}`;
    destination = { workspaceId: context.teamId, channelId };
  } else if (type === "message" && (event.channel_type === "channel" || event.channel_type === "group")) {
    if (!threadTs) return discard();
    conversationKey = `slack:${context.teamId}:thread:${channelId}:${threadTs}`;
    if (!context.isActivated(conversationKey)) return discard();
    eventType = event.channel_type === "channel" ? "message.channels" : "message.groups";
    destination = { workspaceId: context.teamId, channelId, threadTs };
    rawText = stripLeadingMention(rawText, context.botUserId);
  } else return discard();

  const files = normalizeFiles(event.files);
  if (!files) return discard();
  const nativeSourceId = `${context.teamId}:${channelId}:${messageTs}`;
  const receivedAt = typeof body.event_time === "number" && Number.isFinite(body.event_time)
    ? Math.trunc(body.event_time * 1_000)
    : context.now();
  return {
    kind: "accept",
    event: {
      eventId,
      eventType,
      teamId: context.teamId,
      channelId,
      messageTs,
      ...(threadTs ? { threadTs } : {}),
      userId,
      rawText,
      files,
      nativeSourceId,
      sourceId: `slack:${nativeSourceId}`,
      binding: {
        adapterId: "slack",
        conversationKey,
        destination,
        reply: { messageTs },
      },
      activate,
      receivedAt,
    },
  };
}

function normalizeFiles(value: unknown): SlackFileDescriptor[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const files: SlackFileDescriptor[] = [];
  for (const candidate of value) {
    const file = record(candidate);
    const slackFileId = string(file?.id);
    if (!file || !slackFileId) return undefined;
    const displayName = safeName(string(file.name) ?? string(file.title) ?? "attachment");
    const mediaType = (string(file.mimetype) ?? "application/octet-stream").slice(0, 200);
    const declaredSize = typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : undefined;
    const downloadUrl = string(file.url_private_download) ?? string(file.url_private);
    files.push({
      slackFileId,
      displayName,
      mediaType,
      ...(declaredSize === undefined ? {} : { declaredSize }),
      ...(downloadUrl === undefined ? {} : { downloadUrl }),
    });
  }
  return files;
}

function stripLeadingMention(text: string, botUserId: string): string {
  const escaped = botUserId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return text.replace(new RegExp(`^<@${escaped}>[\\t\\n\\r ]*`, "u"), "");
}

function safeName(value: string): string {
  const clean = basename(value.replace(/[\u0000-\u001f\u007f]/gu, "_")).trim().slice(0, 180);
  return clean || "attachment";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined { return typeof value === "string" && value.length > 0 ? value : undefined; }
function discard(): SlackEventClassification { return { kind: "discard" }; }

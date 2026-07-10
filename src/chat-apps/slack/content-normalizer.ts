import type { SlackFileDescriptor } from "./types.ts";

export type SlackContentNormalization =
  | { kind: "content"; text: string; files: SlackFileDescriptor[]; complete: boolean }
  | { kind: "empty" };

const UNSUPPORTED = "[Unsupported Slack content]";
const UNSUPPORTED_FILE = "[Unsupported Slack file]";
const UNSUPPORTED_FORWARD_IMAGE = "[Unsupported Slack forwarded image]";
const LIMIT_MARKER = "[Slack content omitted: limit exceeded]";
const MAX_DEPTH = 32;
const MAX_NODES = 2_000;
const MAX_ATTACHMENTS = 100;
const MAX_ATTACHMENT_SCAN = 10_000;
const MAX_FILES = 100;
const INPUT_TAIL_RESERVE_BYTES = 8 * 1024;
const INPUT_TAIL_RESERVE_CODE_POINTS = 2_048;
const MAX_INPUT_TEXT_BYTES = 160 * 1024 + INPUT_TAIL_RESERVE_BYTES;
const MAX_INPUT_TEXT_CODE_POINTS = 40_000 + INPUT_TAIL_RESERVE_CODE_POINTS;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_CONSTRUCT_BYTES = MAX_OUTPUT_BYTES / 2;

interface ParseState {
  nodes: number;
  files: FileCollector;
  inputTextBytesRemaining: number;
  inputTextCodePointsRemaining: number;
  inputLimitMarkerEmitted: boolean;
  nodeLimitMarkerEmitted: boolean;
}

interface Rendered {
  text: string;
  complete: boolean;
  present: boolean;
  block: boolean;
}

interface TextBudget {
  bytes: number;
  codePoints: number;
  markerEmitted: boolean;
}

interface FileEntry {
  descriptor: SlackFileDescriptor;
  hasDisplayName: boolean;
  hasMediaType: boolean;
  hasDeclaredSize: boolean;
  hasDownloadUrl: boolean;
}

class FileCollector {
  private readonly entries: FileEntry[] = [];
  private readonly indexes = new Map<string, number>();

  add(candidate: FileEntry): boolean {
    const existingIndex = this.indexes.get(candidate.descriptor.slackFileId);
    if (existingIndex === undefined) {
      if (this.entries.length >= MAX_FILES) return false;
      this.indexes.set(candidate.descriptor.slackFileId, this.entries.length);
      this.entries.push(candidate);
      return true;
    }
    const existing = this.entries[existingIndex]!;
    const descriptor = { ...existing.descriptor };
    if (!existing.hasDisplayName && candidate.hasDisplayName) descriptor.displayName = candidate.descriptor.displayName;
    if (!existing.hasMediaType && candidate.hasMediaType) descriptor.mediaType = candidate.descriptor.mediaType;
    if (!existing.hasDeclaredSize && candidate.descriptor.declaredSize !== undefined) descriptor.declaredSize = candidate.descriptor.declaredSize;
    if (!existing.hasDownloadUrl && candidate.descriptor.downloadUrl !== undefined) descriptor.downloadUrl = candidate.descriptor.downloadUrl;
    this.entries[existingIndex] = {
      descriptor,
      hasDisplayName: existing.hasDisplayName || candidate.hasDisplayName,
      hasMediaType: existing.hasMediaType || candidate.hasMediaType,
      hasDeclaredSize: existing.hasDeclaredSize || candidate.hasDeclaredSize,
      hasDownloadUrl: existing.hasDownloadUrl || candidate.hasDownloadUrl,
    };
    return true;
  }

  values(): SlackFileDescriptor[] {
    return this.entries.map(({ descriptor }) => descriptor);
  }

  get size(): number {
    return this.entries.length;
  }
}

export function normalizeSlackMessageContent(value: unknown): SlackContentNormalization {
  try {
    return normalizeSlackMessageContentInner(value);
  } catch {
    return { kind: "content", text: UNSUPPORTED, files: [], complete: false };
  }
}

function normalizeSlackMessageContentInner(value: unknown): SlackContentNormalization {
  const event = record(value);
  if (!event) return { kind: "empty" };
  const state: ParseState = {
    nodes: 0,
    files: new FileCollector(),
    inputTextBytesRemaining: MAX_INPUT_TEXT_BYTES,
    inputTextCodePointsRemaining: MAX_INPUT_TEXT_CODE_POINTS,
    inputLimitMarkerEmitted: false,
    nodeLimitMarkerEmitted: false,
  };
  const parts: string[] = [];
  let complete = true;

  const budgetBeforeBlocks = textBudget(state);
  const blocks = renderBlocks(event.blocks, state, 0);
  const budgetAfterBlocks = textBudget(state);
  const primary = selectPrimary(blocks, () => readFallback(event, "text", state), state, budgetBeforeBlocks, budgetAfterBlocks);
  if (primary.text) parts.push(primary.text);
  complete &&= primary.complete;

  const topFiles = normalizeFiles(event.files, state, 0);
  if (topFiles.marker) parts.push(topFiles.marker);
  complete &&= topFiles.complete;

  const forwarded = renderForwardedAttachments(event.attachments, state, 0);
  if (forwarded.text) parts.push(forwarded.text);
  complete &&= forwarded.complete;

  const joined = joinBounded(parts.filter(Boolean), "\n\n");
  let text = joined.text;
  complete &&= joined.complete;
  text = boundFinalOutput(text);
  if (text.includes(LIMIT_MARKER)) complete = false;
  const files = state.files.values();
  if (!text && files.length === 0) return { kind: "empty" };
  return { kind: "content", text, files, complete };
}

function selectPrimary(
  blocks: Rendered,
  fallbackFactory: () => Rendered,
  state: ParseState,
  budgetBeforeBlocks: TextBudget,
  budgetAfterBlocks: TextBudget,
): Rendered {
  if (!blocks.present) {
    restoreTextBudget(state, budgetBeforeBlocks);
    return fallbackFactory();
  }
  if (blocks.complete && blocks.text) return blocks;
  restoreTextBudget(state, budgetBeforeBlocks);
  const fallback = fallbackFactory();
  if (!blocks.complete && fallback.text) {
    const joined = joinBounded([fallback.text, UNSUPPORTED], "\n");
    return rendered(joined.text, false, true, true);
  }
  restoreTextBudget(state, budgetAfterBlocks);
  return blocks;
}

function renderForwardedAttachments(value: unknown, state: ParseState, depth: number): Rendered {
  if (value === undefined) return empty();
  if (!Array.isArray(value)) return unsupported(true);
  const parts: string[] = [];
  let complete = true;
  let sharedCount = 0;
  const scanCount = Math.min(value.length, MAX_ATTACHMENT_SCAN);
  for (let index = 0; index < scanCount; index += 1) {
    const attachment = record(value[index]);
    if (attachment && attachment.is_share !== true) continue;
    if (state.nodes >= MAX_NODES) {
      const marker = nodeLimitMarker(state);
      if (marker) parts.push(marker);
      complete = false;
      break;
    }
    const guard = enter(state, depth);
    if (guard) {
      if (guard.text) parts.push(guard.text);
      complete = false;
      break;
    }
    if (!attachment) {
      parts.push(UNSUPPORTED);
      complete = false;
      continue;
    }
    sharedCount += 1;
    if (sharedCount > MAX_ATTACHMENTS) {
      parts.push(LIMIT_MARKER);
      complete = false;
      break;
    }

    const blockValue = chooseAttachmentBlocks(attachment);
    const budgetBeforeBlocks = textBudget(state);
    const blocks = renderBlocks(blockValue, state, depth + 1);
    const budgetAfterBlocks = textBudget(state);
    let body = selectPrimary(blocks, () => firstFallback(attachment, state), state, budgetBeforeBlocks, budgetAfterBlocks);

    const filesBefore = state.files.size;
    const nestedFiles = normalizeFiles(attachment.files, state, depth + 1);
    if (nestedFiles.marker) body = appendRendered(body, nestedFiles.marker, false);
    complete &&= nestedFiles.complete;

    if (nonEmptyString(attachment.image_url)) {
      body = appendRendered(body, UNSUPPORTED_FORWARD_IMAGE, false);
      complete = false;
    }
    if (!body.text && state.files.size === filesBefore) body = unsupported(true);

    const author = sanitizeAuthor(nonEmptyString(attachment.author_name));
    const heading = author ? `[Forwarded Slack message from ${author}]` : "[Forwarded Slack message]";
    const forwarded = joinBounded(body.text ? [heading, body.text] : [heading], "\n");
    parts.push(forwarded.text);
    complete &&= forwarded.complete;
    complete &&= body.complete;
  }
  if (value.length > MAX_ATTACHMENT_SCAN && !parts.includes(LIMIT_MARKER)) {
    parts.push(LIMIT_MARKER);
    complete = false;
  }
  const joined = joinBounded(parts, "\n\n");
  return rendered(joined.text, complete && joined.complete, parts.length > 0, true);
}

function chooseAttachmentBlocks(attachment: Record<string, unknown>): unknown {
  if (Array.isArray(attachment.blocks) && attachment.blocks.length === 0 && attachment.message_blocks !== undefined) {
    return attachment.message_blocks;
  }
  return attachment.blocks ?? attachment.message_blocks;
}

function firstFallback(attachment: Record<string, unknown>, state: ParseState): Rendered {
  const text = readFallback(attachment, "text", state);
  if (text.text && text.complete) return text;
  const fallback = readFallback(attachment, "fallback", state);
  if (text.complete) return fallback;
  return rendered(fallback.text ? `${fallback.text}\n${UNSUPPORTED}` : UNSUPPORTED, false, true, false);
}

function renderBlocks(value: unknown, state: ParseState, depth: number): Rendered {
  if (value === undefined) return empty();
  if (!Array.isArray(value)) return unsupported(true);
  const results: Rendered[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (state.nodes >= MAX_NODES) {
      results.push(rendered(nodeLimitMarker(state), false, true, true));
      break;
    }
    results.push(renderBlock(value[index], state, depth + 1));
  }
  return combine(results, "\n", true);
}

function renderBlock(value: unknown, state: ParseState, depth: number): Rendered {
  const guard = enter(state, depth);
  if (guard) return guard;
  const block = record(value);
  if (!block) return unsupported(true);
  switch (block.type) {
    case "rich_text":
      return renderRichElements(block.elements, state, depth + 1);
    case "section": {
      const values: Rendered[] = [];
      if (block.text !== undefined) values.push(renderTextObject(block.text, state, depth + 1));
      if (block.fields !== undefined) {
        if (!Array.isArray(block.fields)) values.push(unsupported(true));
        else {
          for (let index = 0; index < block.fields.length; index += 1) {
            if (state.nodes >= MAX_NODES) {
              values.push(rendered(nodeLimitMarker(state), false, true, true));
              break;
            }
            values.push(renderTextObject(block.fields[index], state, depth + 1));
          }
        }
      }
      if (block.accessory !== undefined) values.push(unsupported(true));
      return combine(values, "\n", true);
    }
    case "header":
      return renderTextObject(block.text, state, depth + 1);
    case "context": {
      if (!Array.isArray(block.elements)) return unsupported(true);
      const values: Rendered[] = [];
      for (let index = 0; index < block.elements.length; index += 1) {
        if (state.nodes >= MAX_NODES) {
          values.push(rendered(nodeLimitMarker(state), false, true, true));
          break;
        }
        values.push(renderContextElement(block.elements[index], state, depth + 1));
      }
      return combine(values, " ", true);
    }
    case "image": {
      const alt = readFallback(block, "alt_text", state);
      if (alt.text) return alt;
      return renderTextObject(block.title, state, depth + 1);
    }
    case "video": {
      const title = renderTextObject(block.title, state, depth + 1);
      if (title.text) return title;
      return readFallback(block, "alt_text", state);
    }
    case "markdown":
      return readFallback(block, "text", state);
    case "divider":
      return empty();
    default:
      return unsupported(true);
  }
}

function renderContextElement(value: unknown, state: ParseState, depth: number): Rendered {
  const guard = enter(state, depth);
  if (guard) return guard;
  const item = record(value);
  if (!item) return unsupported(false);
  if (item.type === "image") return readFallback(item, "alt_text", state);
  return renderTextObject(item, state, depth + 1);
}

function renderTextObject(value: unknown, state: ParseState, depth: number): Rendered {
  const guard = enter(state, depth);
  if (guard) return guard;
  if (typeof value === "string") return textValue(value, state);
  const item = record(value);
  if (!item || typeof item.text !== "string") return unsupported(false);
  return textValue(item.text, state);
}

function renderRichElements(value: unknown, state: ParseState, depth: number): Rendered {
  if (!Array.isArray(value)) return unsupported(true);
  const parts: string[] = [];
  let complete = true;
  let present = false;
  let previousBlock = false;
  for (let index = 0; index < value.length; index += 1) {
    if (state.nodes >= MAX_NODES) {
      const marker = nodeLimitMarker(state);
      if (marker) parts.push(marker);
      complete = false;
      present = true;
      break;
    }
    const item = renderRichElement(value[index], state, depth + 1);
    complete &&= item.complete;
    present ||= item.present;
    if (!item.text) continue;
    const prior = parts.at(-1) ?? "";
    const needsBoundary = parts.length > 0 && (previousBlock || item.block)
      && !prior.endsWith("\n") && !item.text.startsWith("\n");
    parts.push(`${needsBoundary ? "\n" : ""}${item.text}`);
    previousBlock = item.block;
  }
  const joined = joinBounded(parts, "");
  return rendered(joined.text, complete && joined.complete, present, false);
}

function renderRichElement(value: unknown, state: ParseState, depth: number): Rendered {
  const guard = enter(state, depth);
  if (guard) return guard;
  const element = record(value);
  if (!element) return unsupported(false);
  switch (element.type) {
    case "rich_text_section":
      return renderRichElements(element.elements, state, depth + 1);
    case "rich_text_quote": {
      const child = renderRichElements(element.elements, state, depth + 1);
      const quoted = prefixLinesBounded(child.text, "> ", "> ");
      return fitConstruct(quoted.text, child.complete && quoted.complete, child.present, true);
    }
    case "rich_text_preformatted": {
      const child = renderRichElements(element.elements, state, depth + 1);
      return fitConstruct(child.text ? fencedCode(child.text) : "", child.complete, child.present, true);
    }
    case "rich_text_list":
      return renderRichList(element, state, depth + 1);
    case "text": {
      if (typeof element.text !== "string") return unsupported(false);
      return styledText(element.text, element.style, state);
    }
    case "link":
      return renderLink(element, state);
    case "user":
      return renderIdentity(element.user_id, (id) => `<@${id}>`, state);
    case "channel":
      return renderIdentity(element.channel_id, (id) => `<#${id}>`, state);
    case "usergroup":
      return renderIdentity(element.usergroup_id, (id) => `<!subteam^${id}>`, state);
    case "broadcast":
      return renderIdentity(element.range, (range) => `<!${range}>`, state);
    case "emoji": {
      const name = safeIdentifier(element.name);
      return name ? textValue(`:${name}:`, state) : unsupported(false);
    }
    case "date": {
      const fallback = nonEmptyString(element.fallback);
      if (!fallback) return unsupported(false);
      const url = nonEmptyString(element.url);
      return url ? linkValue(fallback, url, state) : textValue(fallback, state);
    }
    default:
      return unsupported(false);
  }
}

function renderRichList(element: Record<string, unknown>, state: ParseState, depth: number): Rendered {
  if (!Array.isArray(element.elements)) return unsupported(true);
  const ordered = element.style === "ordered";
  const indentValue = typeof element.indent === "number" && Number.isInteger(element.indent)
    ? Math.max(0, Math.min(8, element.indent))
    : 0;
  const indent = "  ".repeat(indentValue);
  const lines: string[] = [];
  let complete = true;
  let present = false;
  let ordinal = typeof element.offset === "number" && Number.isInteger(element.offset) ? Math.max(0, element.offset) + 1 : 1;
  for (let index = 0; index < element.elements.length; index += 1) {
    if (state.nodes >= MAX_NODES) {
      const marker = nodeLimitMarker(state);
      if (marker) lines.push(marker);
      complete = false;
      present = true;
      break;
    }
    const renderedChild = renderRichElement(element.elements[index], state, depth + 1);
    complete &&= renderedChild.complete;
    present ||= renderedChild.present;
    if (!renderedChild.text) continue;
    const marker = ordered ? `${ordinal}. ` : "- ";
    const continuation = `${indent}${" ".repeat(marker.length)}`;
    const item = prefixLinesBounded(renderedChild.text, `${indent}${marker}`, continuation);
    lines.push(item.text);
    complete &&= item.complete;
    ordinal += 1;
  }
  const joined = joinBounded(lines, "\n");
  return fitConstruct(joined.text, complete && joined.complete, present, true);
}

function renderLink(element: Record<string, unknown>, state: ParseState): Rendered {
  const url = nonEmptyString(element.url);
  if (!url) return unsupported(false);
  const label = typeof element.text === "string" && element.text.length > 0 ? element.text : undefined;
  return linkValue(label, url, state, element.style);
}

function linkValue(label: string | undefined, url: string, state: ParseState, style?: unknown): Rendered {
  const boundedLabel = label === undefined ? undefined : boundedText(label, state, false);
  if (boundedLabel === LIMIT_MARKER || (label !== undefined && !boundedLabel)) return rendered(LIMIT_MARKER, false, true, false);
  const boundedUrl = boundedText(url, state, false);
  if (!boundedUrl || boundedUrl === LIMIT_MARKER) return rendered(LIMIT_MARKER, false, true, false);
  const sanitizedUrl = sanitizeUrl(boundedUrl);
  const supported = supportedUrlScheme(sanitizedUrl);
  let value: string;
  if (supported) {
    value = boundedLabel ? `[${escapeLinkLabel(boundedLabel)}](<${sanitizedUrl}>)` : `<${sanitizedUrl}>`;
  } else {
    const visibleUrl = sanitizeInline(boundedUrl);
    value = boundedLabel ? `${sanitizeInline(boundedLabel)} (${visibleUrl})` : visibleUrl;
  }
  return styleBoundedValue(value, style);
}

function styledText(value: string, style: unknown, state: ParseState, splittable = true): Rendered {
  const flags = record(style);
  const bounded = boundedText(value, state, splittable && !flags);
  if (!bounded) return rendered("", false, true, false);
  if (bounded.includes(LIMIT_MARKER)) return rendered(bounded, false, true, false);
  return styleBoundedValue(bounded, flags);
}

function styleBoundedValue(value: string, style: unknown): Rendered {
  let output = value;
  const flags = record(style);
  if (flags?.code === true) output = inlineCode(output);
  if (flags?.bold === true) output = `**${output}**`;
  if (flags?.italic === true) output = `_${output}_`;
  if (flags?.strike === true) output = `~~${output}~~`;
  return fitConstruct(output, true, output.length > 0, false);
}

function renderIdentity(value: unknown, format: (id: string) => string, state: ParseState): Rendered {
  const id = safeIdentifier(value);
  return id ? textValue(format(id), state) : unsupported(false);
}

function normalizeFiles(value: unknown, state: ParseState, depth: number): { complete: boolean; marker?: string } {
  if (value === undefined) return { complete: true };
  if (!Array.isArray(value)) return { complete: false, marker: UNSUPPORTED_FILE };
  let complete = true;
  let invalid = false;
  const count = Math.min(value.length, MAX_FILES);
  for (let index = 0; index < count; index += 1) {
    if (state.nodes >= MAX_NODES) {
      complete = false;
      invalid = true;
      break;
    }
    const guard = enter(state, depth + 1);
    if (guard) {
      complete = false;
      invalid = true;
      break;
    }
    const file = record(value[index]);
    const slackFileId = safeIdentifier(file?.id);
    if (!file || !slackFileId) {
      complete = false;
      invalid = true;
      continue;
    }
    const name = nonEmptyString(file.name) ?? nonEmptyString(file.title);
    const mediaType = safeMediaType(nonEmptyString(file.mimetype));
    const declaredSize = typeof file.size === "number" && Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : undefined;
    const rawUrl = nonEmptyString(file.url_private_download) ?? nonEmptyString(file.url_private);
    const downloadUrl = trustedSlackFileUrl(rawUrl);
    const added = state.files.add({
      descriptor: {
        slackFileId,
        displayName: safeFileName(name ?? "attachment"),
        mediaType: mediaType ?? "application/octet-stream",
        ...(declaredSize === undefined ? {} : { declaredSize }),
        ...(downloadUrl === undefined ? {} : { downloadUrl }),
      },
      hasDisplayName: name !== undefined,
      hasMediaType: mediaType !== undefined,
      hasDeclaredSize: declaredSize !== undefined,
      hasDownloadUrl: downloadUrl !== undefined,
    });
    if (!added) {
      complete = false;
      invalid = true;
    }
  }
  if (value.length > MAX_FILES) {
    complete = false;
    invalid = true;
  }
  return { complete, ...(invalid ? { marker: value.length > MAX_FILES ? LIMIT_MARKER : UNSUPPORTED_FILE } : {}) };
}

function readFallback(source: Record<string, unknown>, key: string, state: ParseState): Rendered {
  if (!(key in source)) return empty();
  const value = source[key];
  if (value === "" || value === null || value === undefined) return empty();
  if (typeof value !== "string") return unsupported(false);
  return textValue(value, state);
}

function textValue(value: string, state: ParseState): Rendered {
  const text = boundedText(value, state, true);
  return rendered(text, !text.includes(LIMIT_MARKER), text.length > 0, false);
}

function boundedText(value: string, state: ParseState, splittable: boolean): string {
  const scanned = scanUtf8Prefix(value, state.inputTextBytesRemaining, state.inputTextCodePointsRemaining);
  if (scanned.complete) {
    state.inputTextBytesRemaining -= scanned.bytes;
    state.inputTextCodePointsRemaining -= scanned.codePoints;
    return scanned.text;
  }
  if (state.inputLimitMarkerEmitted) return "";
  state.inputLimitMarkerEmitted = true;
  const availableBytes = state.inputTextBytesRemaining;
  const availablePoints = state.inputTextCodePointsRemaining;
  const reserveBytes = Math.min(INPUT_TAIL_RESERVE_BYTES, availableBytes);
  const reservePoints = Math.min(INPUT_TAIL_RESERVE_CODE_POINTS, availablePoints);
  if (!splittable) {
    state.inputTextBytesRemaining = reserveBytes;
    state.inputTextCodePointsRemaining = reservePoints;
    return LIMIT_MARKER;
  }
  const suffix = `\n${LIMIT_MARKER}`;
  const budget = Math.max(0, availableBytes - reserveBytes - Buffer.byteLength(suffix));
  const pointBudget = Math.max(0, availablePoints - reservePoints - suffix.length);
  state.inputTextBytesRemaining = reserveBytes;
  state.inputTextCodePointsRemaining = reservePoints;
  return `${scanUtf8Prefix(value, budget, pointBudget).text}${suffix}`;
}

function boundFinalOutput(value: string): string {
  if (Buffer.byteLength(value) <= MAX_OUTPUT_BYTES) return value;
  return LIMIT_MARKER;
}

function scanUtf8Prefix(value: string, maxBytes: number, maxPoints: number): {
  text: string;
  bytes: number;
  codePoints: number;
  complete: boolean;
} {
  let bytes = 0;
  let codePoints = 0;
  const output: string[] = [];
  for (const point of value) {
    const next = Buffer.byteLength(point);
    if (bytes + next > maxBytes || codePoints >= maxPoints) {
      return { text: output.join(""), bytes, codePoints, complete: false };
    }
    output.push(point);
    bytes += next;
    codePoints += 1;
  }
  return { text: output.join(""), bytes, codePoints, complete: true };
}

function enter(state: ParseState, depth: number): Rendered | undefined {
  if (depth > MAX_DEPTH) return rendered(LIMIT_MARKER, false, true, false);
  if (state.nodes >= MAX_NODES) return rendered(nodeLimitMarker(state), false, true, false);
  state.nodes += 1;
  return undefined;
}

function nodeLimitMarker(state: ParseState): string {
  if (state.nodeLimitMarkerEmitted) return "";
  state.nodeLimitMarkerEmitted = true;
  return LIMIT_MARKER;
}

function rendered(text: string, complete: boolean, present: boolean, block: boolean): Rendered {
  return { text, complete, present, block };
}

function empty(): Rendered {
  return rendered("", true, false, false);
}

function unsupported(block: boolean): Rendered {
  return rendered(UNSUPPORTED, false, true, block);
}

function appendRendered(value: Rendered, text: string, complete: boolean): Rendered {
  const joined = joinBounded([value.text, text], "\n");
  return rendered(joined.text, value.complete && complete && joined.complete, true, value.block);
}

function combine(values: readonly Rendered[], separator: string, block: boolean): Rendered {
  const joined = joinBounded(values.map((value) => value.text).filter(Boolean), separator);
  return rendered(
    joined.text,
    values.every((value) => value.complete) && joined.complete,
    values.some((value) => value.present),
    block,
  );
}

function fitConstruct(text: string, complete: boolean, present: boolean, block: boolean): Rendered {
  return Buffer.byteLength(text) <= MAX_CONSTRUCT_BYTES
    ? rendered(text, complete, present, block)
    : rendered(LIMIT_MARKER, false, true, block);
}

function joinBounded(values: readonly string[], separator: string): { text: string; complete: boolean } {
  let text = "";
  let complete = true;
  let markerAdded = false;
  for (const value of values) {
    if (!value) continue;
    const prefix = text ? separator : "";
    const addition = `${prefix}${value}`;
    if (Buffer.byteLength(text) + Buffer.byteLength(addition) <= MAX_OUTPUT_BYTES) {
      text += addition;
      continue;
    }
    complete = false;
    if (markerAdded || value === LIMIT_MARKER) continue;
    const marker = `${text ? separator : ""}${LIMIT_MARKER}`;
    if (Buffer.byteLength(text) + Buffer.byteLength(marker) <= MAX_OUTPUT_BYTES) {
      text += marker;
      markerAdded = true;
    }
  }
  return { text, complete };
}

function textBudget(state: ParseState): TextBudget {
  return {
    bytes: state.inputTextBytesRemaining,
    codePoints: state.inputTextCodePointsRemaining,
    markerEmitted: state.inputLimitMarkerEmitted,
  };
}

function restoreTextBudget(state: ParseState, budget: TextBudget): void {
  state.inputTextBytesRemaining = budget.bytes;
  state.inputTextCodePointsRemaining = budget.codePoints;
  state.inputLimitMarkerEmitted = budget.markerEmitted;
}

function prefixLinesBounded(value: string, firstPrefix: string, continuationPrefix: string): { text: string; complete: boolean } {
  if (!value) return { text: "", complete: true };
  const output: string[] = [firstPrefix];
  let bytes = Buffer.byteLength(firstPrefix);
  for (const point of value) {
    const addition = point === "\n" ? `\n${continuationPrefix}` : point;
    bytes += Buffer.byteLength(addition);
    if (bytes > MAX_CONSTRUCT_BYTES) return { text: LIMIT_MARKER, complete: false };
    output.push(addition);
  }
  return { text: output.join(""), complete: true };
}

function fencedCode(value: string): string {
  const longest = longestBacktickRun(value);
  const fence = "`".repeat(Math.max(2, longest + 1));
  return `${fence}\n${value}\n${fence}`;
}

function inlineCode(value: string): string {
  const longest = longestBacktickRun(value);
  const fence = "`".repeat(longest + 1);
  return `${fence}${value}${fence}`;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const point of value) {
    if (point === "`") {
      current += 1;
      if (current > longest) longest = current;
    } else current = 0;
  }
  return longest;
}

function escapeLinkLabel(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/\[/gu, "\\[").replace(/\]/gu, "\\]");
}

function sanitizeUrl(value: string): string {
  let output = "";
  for (const point of value) {
    if (/[\u0000-\u0020\u007f<>\\]/u.test(point)) output += encodeURIComponent(point);
    else output += point;
  }
  return output;
}

function supportedUrlScheme(value: string): boolean {
  try {
    return new Set(["http:", "https:", "mailto:", "slack:"]).has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function sanitizeInline(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "�");
}

function sanitizeAuthor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const output: string[] = [];
  let priorSpace = false;
  for (const point of value) {
    const replacement = /[\u0000-\u001f\u007f\[\]\s]/u.test(point) ? " " : point;
    if (replacement === " ") {
      if (output.length > 0 && !priorSpace) output.push(" ");
      priorSpace = true;
    } else {
      output.push(replacement);
      priorSpace = false;
    }
    if (output.length >= 180) break;
  }
  const bounded = output.join("").trim();
  return bounded || undefined;
}

function trustedSlackFileUrl(value: string | undefined): string | undefined {
  if (!value || value.length > 4_096) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "files.slack.com" || url.hostname === "files.slack-edge.com")
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function safeFileName(value: string): string {
  let segment: string[] = [];
  for (const point of value) {
    if (point === "/") {
      segment = [];
      continue;
    }
    if (segment.length < 180) segment.push(/[\u0000-\u001f\u007f]/u.test(point) ? "_" : point);
  }
  return segment.join("").trim() || "attachment";
}

function safeMediaType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const output: string[] = [];
  for (const point of value) {
    if (/[\u0000-\u001f\u007f]/u.test(point)) return undefined;
    output.push(point);
    if (output.length >= 200) break;
  }
  return output.join("");
}

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || !/^[A-Za-z0-9._:+-]+$/u.test(value)) return undefined;
  return value;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

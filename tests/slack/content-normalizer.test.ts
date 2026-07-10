import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSlackMessageContent } from "../../src/chat-apps/slack/content-normalizer.ts";

test("normalizes a shared Slack forward with ordered inline semantics", () => {
  const result = normalizeSlackMessageContent({
    text: "",
    attachments: [{
      is_share: true,
      is_msg_unfurl: true,
      author_name: "Bob",
      text: "notification fallback",
      blocks: [{
        type: "rich_text",
        elements: [{
          type: "rich_text_section",
          elements: [
            { type: "text", text: "Read " },
            { type: "link", text: "the design", url: "https://example.com/design" },
            { type: "text", text: " with " },
            { type: "user", user_id: "U2" },
            { type: "text", text: " " },
            { type: "emoji", name: "wave" },
            { type: "text", text: "." },
          ],
        }],
      }],
    }],
  });

  assert.deepEqual(result, {
    kind: "content",
    text: "[Forwarded Slack message from Bob]\nRead [the design](<https://example.com/design>) with <@U2> :wave:.",
    files: [],
    complete: true,
  });
});

test("preserves rich-text structure and textual order", () => {
  const result = normalizeSlackMessageContent({
    text: "preview",
    blocks: [{
      type: "rich_text",
      elements: [
        { type: "rich_text_section", elements: [{ type: "text", text: "Before\n" }] },
        { type: "rich_text_list", style: "bullet", elements: [
          { type: "rich_text_section", elements: [{ type: "text", text: "first" }] },
          { type: "rich_text_section", elements: [{ type: "text", text: "second" }] },
        ] },
        { type: "rich_text_quote", elements: [{ type: "text", text: "quoted\nagain" }] },
        { type: "rich_text_preformatted", elements: [{ type: "text", text: "const x = `ok`;" }] },
        { type: "rich_text_section", elements: [{ type: "text", text: "\nAfter" }] },
      ],
    }],
  });

  assert.equal(result.kind, "content");
  if (result.kind !== "content") return;
  assert.equal(result.text, "Before\n- first\n- second\n> quoted\n> again\n``\nconst x = `ok`;\n``\nAfter");
  assert.equal(result.complete, true);
});

test("uses complete rich blocks over previews and empty complete blocks use fallback", () => {
  const rich = normalizeSlackMessageContent({
    text: "short preview",
    blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "complete body" }] }] }],
  });
  assert.equal(rich.kind === "content" ? rich.text : undefined, "complete body");

  for (const blocks of [[], [{ type: "divider" }]]) {
    const fallback = normalizeSlackMessageContent({ text: "fallback body", blocks });
    assert.equal(fallback.kind === "content" ? fallback.text : undefined, "fallback body");
  }
});

test("an oversized unselected fallback cannot suppress authoritative blocks", () => {
  const result = normalizeSlackMessageContent({
    text: "preview".repeat(30_000),
    blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "authoritative block" }] }] }],
  });
  assert.deepEqual(result, { kind: "content", text: "authoritative block", files: [], complete: true });
});

test("marks incomplete blocks once and uses fallback when available", () => {
  const withFallback = normalizeSlackMessageContent({ text: "fallback body", blocks: [{ type: "future_visible_block" }] });
  assert.deepEqual(withFallback, {
    kind: "content",
    text: "fallback body\n[Unsupported Slack content]",
    files: [],
    complete: false,
  });

  const withoutFallback = normalizeSlackMessageContent({ blocks: [{ type: "future_visible_block" }] });
  assert.deepEqual(withoutFallback, {
    kind: "content",
    text: "[Unsupported Slack content]",
    files: [],
    complete: false,
  });
});

test("distinguishes forwarded shares from ordinary message unfurls", () => {
  const topText = "See <https://example.com|the page>";
  for (const isShare of [undefined, false, "true", 1]) {
    const result = normalizeSlackMessageContent({
      text: topText,
      attachments: [{ is_share: isShare, is_msg_unfurl: true, text: "preview must not enter" }],
    });
    assert.equal(result.kind === "content" ? result.text : undefined, topText);
  }

  for (const attachment of [
    { is_share: true, text: "share only" },
    { is_share: true, is_msg_unfurl: true, text: "share and unfurl" },
  ]) {
    const result = normalizeSlackMessageContent({ attachments: [attachment] });
    assert.match(result.kind === "content" ? result.text : "", /^\[Forwarded Slack message\]\nshare/u);
  }
});

test("arbitrarily many non-share unfurls remain transport-only", () => {
  const result = normalizeSlackMessageContent({
    attachments: Array.from({ length: 2_001 }, () => ({ is_msg_unfurl: true, text: "preview must not enter" })),
  });
  assert.deepEqual(result, { kind: "empty" });
});

test("a supported share after many transport-only unfurls is still normalized", () => {
  const result = normalizeSlackMessageContent({
    attachments: [
      ...Array.from({ length: 2_000 }, () => ({ is_msg_unfurl: true, text: "preview must not enter" })),
      { is_share: true, author_name: "Late", text: "visible share" },
    ],
  });
  assert.deepEqual(result, {
    kind: "content",
    text: "[Forwarded Slack message from Late]\nvisible share",
    files: [],
    complete: true,
  });
});

test("an unexamined attachment tail is explicit instead of falsely empty", () => {
  const result = normalizeSlackMessageContent({
    attachments: Array.from({ length: 10_001 }, () => ({ is_msg_unfurl: true, text: "preview" })),
  });
  assert.deepEqual(result, {
    kind: "content",
    text: "[Slack content omitted: limit exceeded]",
    files: [],
    complete: false,
  });
});

test("keeps multiple forwarded messages ordered without deduplication", () => {
  const result = normalizeSlackMessageContent({
    text: "caption",
    attachments: [
      { is_share: true, author_name: "A", text: "same" },
      { is_share: true, author_name: "B", text: "same" },
    ],
  });
  assert.equal(result.kind === "content" ? result.text : undefined,
    "caption\n\n[Forwarded Slack message from A]\nsame\n\n[Forwarded Slack message from B]\nsame");
});

test("normalizes nested forwarded files once and fills missing metadata in place", () => {
  const result = normalizeSlackMessageContent({
    files: [{ id: "F1", name: "first.txt" }],
    attachments: [{
      is_share: true,
      text: "file forward",
      files: [
        { id: "F2", name: "nested.txt" },
        { id: "F1", mimetype: "text/plain", size: 12, url_private_download: "https://files.slack.com/F1" },
        { id: "F2", mimetype: "text/plain", size: 8, url_private: "https://files.slack-edge.com/F2" },
      ],
    }],
  });

  assert.equal(result.kind, "content");
  if (result.kind !== "content") return;
  assert.deepEqual(result.files, [
    { slackFileId: "F1", displayName: "first.txt", mediaType: "text/plain", declaredSize: 12, downloadUrl: "https://files.slack.com/F1" },
    { slackFileId: "F2", displayName: "nested.txt", mediaType: "text/plain", declaredSize: 8, downloadUrl: "https://files.slack-edge.com/F2" },
  ]);
});

test("sanitizes Markdown boundaries without moving inline links", () => {
  const result = normalizeSlackMessageContent({
    attachments: [{
      is_share: true,
      author_name: "Bad\n[name]".repeat(40),
      blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [
        { type: "link", text: "a[b]\\c", url: "https://example.com/a b>c" },
        { type: "text", text: " then " },
        { type: "link", text: "unsafe", url: "javascript:alert(1)" },
      ] }] }],
    }],
  });
  assert.equal(result.kind, "content");
  if (result.kind !== "content") return;
  assert.match(result.text, /^\[Forwarded Slack message from Bad name /u);
  assert.match(result.text, /\[a\\\[b\\\]\\\\c\]\(<https:\/\/example\.com\/a%20b%3Ec>\) then unsafe \(javascript:alert\(1\)\)$/u);
  assert.equal(result.text.split("\n")[0]!.length <= 212, true);
});

test("is total and bounded for malformed, deep, and oversized values", () => {
  const cyclic: Record<string, unknown> = { type: "rich_text_section" };
  cyclic.elements = [cyclic];
  const deep = normalizeSlackMessageContent({ blocks: [{ type: "rich_text", elements: [cyclic] }] });
  assert.equal(deep.kind, "content");
  assert.match(deep.kind === "content" ? deep.text : "", /Slack content omitted/u);

  const malformed = normalizeSlackMessageContent({ text: 42, blocks: "not-an-array", files: [{ nope: true }] });
  assert.equal(malformed.kind, "content");
  assert.match(malformed.kind === "content" ? malformed.text : "", /Unsupported Slack content/u);

  const oversized = normalizeSlackMessageContent({ text: "界".repeat(400_000) });
  assert.equal(oversized.kind, "content");
  if (oversized.kind !== "content") return;
  assert.equal(Buffer.byteLength(oversized.text) <= 1024 * 1024, true);
  assert.match(oversized.text, /Slack content omitted/u);
});

test("hard-stops untrusted arrays at the shared node limit", () => {
  const blocks = Array.from({ length: 2_500 }, () => ({ type: "future_visible_block" }));
  Object.defineProperty(blocks, 2_100, { get: () => { throw new Error("must not inspect beyond node limit"); } });
  const result = normalizeSlackMessageContent({ blocks });
  assert.equal(result.kind, "content");
  if (result.kind !== "content") return;
  assert.match(result.text, /Slack content omitted/u);
  assert.doesNotMatch(result.text, /^\[Unsupported Slack content\]$/u);

  const fields = Array.from({ length: 2_500 }, () => ({ type: "plain_text", text: "x" }));
  Object.defineProperty(fields, 2_100, { get: () => { throw new Error("must not map beyond node limit"); } });
  const section = normalizeSlackMessageContent({ blocks: [{ type: "section", fields }] });
  assert.equal(section.kind, "content");
  assert.match(section.kind === "content" ? section.text : "", /Slack content omitted/u);
});

test("output bounds omit a whole amplified construct and preserve later inline content", () => {
  let nested: Record<string, unknown> = { type: "rich_text_section", elements: [{ type: "text", text: "x\n".repeat(20_000) }] };
  for (let index = 0; index < 3; index += 1) nested = { type: "rich_text_list", style: "bullet", indent: 8, elements: [nested] };
  const result = normalizeSlackMessageContent({
    blocks: [{ type: "rich_text", elements: [
      nested,
      { type: "rich_text_section", elements: [
        { type: "text", text: "after " },
        { type: "link", text: "the limit", url: "https://example.com/after" },
      ] },
    ] }],
  });
  assert.equal(result.kind, "content");
  if (result.kind !== "content") return;
  assert.equal(Buffer.byteLength(result.text) <= 1024 * 1024, true);
  assert.match(result.text, /\[Slack content omitted: limit exceeded\]/u);
  assert.match(result.text, /after \[the limit\]\(<https:\/\/example\.com\/after>\)$/u);
});

test("bounds a huge code-styled scalar before formatting and preserves later content", () => {
  const result = normalizeSlackMessageContent({
    blocks: [{ type: "rich_text", elements: [
      { type: "rich_text_section", elements: [
        { type: "text", text: "`a".repeat(200_000), style: { code: true } },
        { type: "text", text: "after" },
      ] },
    ] }],
  });
  assert.equal(result.kind, "content");
  if (result.kind !== "content") return;
  assert.equal(result.text, "[Slack content omitted: limit exceeded]after");
  assert.equal(result.complete, false);
});

test("returns empty only when no semantic content or file identity exists", () => {
  assert.deepEqual(normalizeSlackMessageContent({ text: "", blocks: [], attachments: [] }), { kind: "empty" });
  const fileOnly = normalizeSlackMessageContent({ files: [{ id: "F1", name: "one.txt" }] });
  assert.equal(fileOnly.kind, "content");
  if (fileOnly.kind === "content") assert.equal(fileOnly.files.length, 1);
});

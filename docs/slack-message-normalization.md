# Slack message normalization

## Status

Proposed for the next Slack ingress revision.

## Problem

Slack does not expose every user-visible message as top-level `text`. A forwarded
message can arrive with empty `text` and no top-level blocks or files while its
visible content lives in an attachment marked `is_share` and `is_msg_unfurl`.
Rich messages can also carry their complete content in `blocks` while `text` is
only a notification preview.

QiYan currently projects a Socket Mode event down to top-level `text` and
`files` before classification. The projection drops blocks and attachments. In
the observed forwarding failure, Slack delivered 324 characters in a shared
message attachment, but QiYan persisted an empty source and submitted only the
`[slack dm]` origin marker to Codex.

The projection was intended to minimize the trusted and persisted Slack
surface. That remains useful, but it must not remove user-visible semantics.

## Goals

- Preserve user-visible textual Slack content in its original order.
- Preserve inline semantics. A labeled hyperlink stays at its original position
  as `[label](<url>)`; it is never collected and appended later.
- Support ordinary messages, rich-text blocks, mentions, forwarded/shared
  messages, and the existing file path through one normalizer.
- Keep transport metadata and raw Slack envelopes out of persistence.
- Distinguish an explicit forwarded message from an unrelated link preview.
- Avoid duplicate text when Slack supplies blocks plus fallback text.
- Never submit a semantically empty turn for a non-empty supported message.
- Keep owner, workspace, conversation, subtype, duplicate, and activation
  policy separate from content normalization.
- Preserve files through the existing canonical attachment channel. This
  revision does not claim to interleave file inputs with surrounding text.

## Non-goals

- Reproduce Slack's visual layout pixel-for-pixel.
- Interpret buttons or execute interactive Block Kit actions.
- Fetch URLs embedded in message text.
- Persist the complete Socket Mode envelope.
- Change Slack authorization, conversation activation, or delivery routing.

## Lessons from OpenClaw

OpenClaw keeps `text`, `blocks`, `attachments`, and files until its Slack content
preparation stage. It has a central rich-text walker, chooses complete rich text
over truncated top-level previews, treats `is_share` as the forwarding signal,
limits forwarded content and media, resolves mentions with bounded lookups, and
does not dispatch an empty body.

QiYan should follow the architecture, not copy the implementation. Two details
should be stricter here:

- OpenClaw may render a labeled link as only its label. QiYan must retain the URL
  inline using the canonical `[label](<url>)` form.
- Unknown user-visible nodes must produce an in-place unsupported-content marker
  rather than disappear silently.

## Proposed architecture

```text
Socket Mode envelope (memory only)
        |
        v
workspace/owner/event policy classifier
        |
        v
Slack semantic normalizer (pure and bounded)
        |                \
        |                 +--> normalized file descriptors
        v
canonical Markdown-like text
        |
        v
durable Slack inbox -> canonical source -> Codex
```

The Socket Mode adapter passes the event body to the classifier without first
deleting content fields. The classifier still reads only an explicit allowlist.
It never logs or persists the raw body. The normalizer is a pure module behind
the Slack adapter interface.

The normalizer has a total, non-throwing contract for every JavaScript value:

```ts
type SlackContentNormalization =
  | { kind: "content"; text: string; files: SlackFileDescriptor[]; complete: boolean }
  | { kind: "empty" };
```

Malformed nodes, exceeded limits, unsafe synthetic metadata, and unexpected
internal parser failures become bounded in-place markers in a `content` result;
they do not throw. `empty` means there was no top-level text, no visible or
unsupported content structure, and no file identity. Parser behavior is
deterministic and performs no I/O.

The envelope handler acknowledges policy discards, empty events, and all
successfully persisted canonical events. Only failure to durably persist an
accepted canonical event may prevent acknowledgment. A malformed Slack content
event therefore cannot become an unacknowledged poison-event retry loop.

The durable inbox schema does not change: it stores only normalized text and a
flat list of normalized file descriptors. The assistant API currently submits
all text before file inputs, so file position relative to surrounding forwarded
text is not preserved in this revision. File order relative to other files is
preserved, and no file is silently dropped. A future cross-adapter ordered-part
schema would be required for exact text/file interleaving. This explicit scope
keeps restart and exactly-once behavior unchanged.

## Normalized output

The output is Markdown-like canonical text intended for Codex. Plain text is
kept in place. Structural syntax is added only where Slack already represents a
structure.

| Slack content | Canonical rendering |
| --- | --- |
| text element | text at the same position |
| labeled link | `[label](<url>)` at the same position |
| unlabeled link | `<url>` at the same position |
| user mention | `<@USER_ID>` at the same position |
| channel mention | `<#CHANNEL_ID>` at the same position |
| user-group mention | `<!subteam^GROUP_ID>` at the same position |
| broadcast mention | `<!here>`, `<!channel>`, or the supplied range |
| emoji | `:name:` |
| line break | the original line break |
| unordered/ordered list | Markdown list in the original item order |
| quote | each line prefixed with `> ` |
| preformatted text | a fenced code block using a safe fence length |
| image/video block | alt text or title in place |
| unknown visible node | `[Unsupported Slack content]` in place |

Slack style flags may wrap the affected inline value with Markdown emphasis,
strikeout, or code syntax, but must not move it. The renderer must not create a
trailing links, mentions, or references section.

The supported block grammar is explicit:

- top-level `rich_text`, `section` (text and fields), `header`, `context`,
  `image`, `video`, and `markdown` blocks;
- rich-text containers `rich_text_section`, `rich_text_list`,
  `rich_text_quote`, and `rich_text_preformatted`;
- rich-text leaves `text`, `link`, `user`, `channel`, `usergroup`, `broadcast`,
  `emoji`, and `date` when a visible fallback is supplied.

Interactive blocks such as actions and inputs are not executed. If they occupy
a visible message position, they render the fixed unsupported marker.

### Primary text selection

Rendering a block collection returns text plus a separate `complete` flag.
Non-empty and complete are not interchangeable.

1. If blocks contain no semantic or unsupported content, use non-empty
   top-level `text` unchanged. This includes an empty array and complete
   layout-only collections such as divider-only blocks.
2. If top-level blocks render completely and are semantically non-empty, use
   their text. They are the authoritative message body.
3. If blocks are incomplete and non-empty top-level `text` exists, use that
   fallback followed immediately by one fixed
   `[Unsupported Slack content]` marker. This avoids treating a partial block
   rendering as complete while making loss visible.
4. If blocks are incomplete and no fallback exists, use the ordered partial
   rendering and its in-place markers.
5. Never concatenate complete, semantically non-empty top-level block text with
   its fallback merely
   because both exist; Slack commonly uses `text` as a duplicate or truncated
   preview.

### Forwarded messages

Only an attachment with `is_share === true` is a forwarded/shared message.
`is_msg_unfurl === true` alone is commonly a link preview and must not be
treated as user-authored forwarded content.

Forwarded attachments are processed in their original attachment order. Body
selection uses the same conditions: empty or layout-only blocks fall back to
`text`, then `fallback`; complete and semantically non-empty blocks are
authoritative; incomplete blocks fall back to `text`, then `fallback`, plus a
fixed unsupported marker; ordered partial blocks are used when no fallback
exists. A bounded metadata line is separate from, and precedes, the body:

```text
[Forwarded Slack message from Bob]
Please review [the design](<https://example.com/design>) before replying.
```

If the sender name is unavailable, use `[Forwarded Slack message]`. Sender
metadata is limited to 180 Unicode code points; CR, LF, controls, `[` and `]`
are replaced with safe single-line characters. This sanitization applies only
to synthetic metadata, never to the forwarded body.

Top-level message content precedes forwarded attachments because that matches
Slack's message/secondary-content ordering. Separate non-empty parts with one
blank line. Do not deduplicate two distinct forwards merely because their text
matches.

### Files and media

Top-level `files` continue through the existing attachment store. Files nested
in an explicit shared attachment are projected into the same normalized
file-descriptor path whenever they have a Slack file ID, even when the download
URL is absent. The existing worker then records `download_unavailable` instead
of silently losing the file.

Duplicate file IDs retain their first position. Later occurrences may fill
missing display name, media type, declared size, or trusted download URL, but
must not replace an already accepted value. This preserves order while allowing
a later, more complete descriptor to make the first occurrence downloadable.

Forwarded image URLs without a Slack file identity are not fetched in this
revision. If such an image has visible alt text, preserve the alt text. Otherwise
insert an explicit `[Unsupported Slack forwarded image]` marker. Supporting the
binary later requires the same trusted-host, size, timeout, checkpoint, and
retry guarantees as normal Slack files.

## Bounds and failure behavior

The normalizer must be iterative or depth-checked and apply explicit limits to
container depth, element count, attachment count, and normalized UTF-8 bytes.
The limits protect the bot from malformed events; they are not permission to
silently truncate ordinary messages. All counters are total across the event,
not reset for every subtree.

When a supported structure exceeds a bound, insert one fixed in-place marker
such as `[Slack content omitted: limit exceeded]` and continue with subsequent
top-level content when safe. Do not include attacker-controlled node types or
values in diagnostic markers. Unknown objects and malformed child values are
represented by the fixed unsupported-content marker when they occupy a
user-visible position. Transport-only fields remain ignored.

A truly empty event with no text, supported semantic content, or files is
discarded without starting a Codex turn. A non-empty but unsupported event must
not become an empty turn.

### Markdown and wrapper safety

Plain text stays at its original position. Link labels escape backslash, `[` and
`]` only as required to keep the label inside one Markdown link. URLs are
rendered inline as `[label](<url>)`; controls, CR, LF, `<`, `>`, and backslash in
the destination are percent-encoded. `http`, `https`, `mailto`, and `slack`
schemes remain clickable. Other schemes remain inline as `label (url)` rather
than becoming an active Markdown hyperlink. An unlabeled URL uses `<url>` for a
supported scheme and the literal URL for another scheme.

Code spans and fences choose a delimiter longer than any run in the value.
Wrapper and marker strings are fixed constants. Sender names, node types, and
other attacker-controlled metadata are never interpolated into diagnostic
markers. Normalized output has a total UTF-8 byte bound; crossing it emits one
fixed limit marker rather than splitting a Unicode code point or Markdown
construct.

## Mentions and activation

Mentions remain inline and ordered. The normalizer preserves Slack IDs because
classification and durable acceptance must not depend on additional Web API
calls. Optional display-name resolution can be added later as a bounded,
cached enrichment step without changing the canonical identity.

The existing removal of a leading QiYan mention is an explicit routing policy,
not generic normalization. It runs after semantic rendering and removes only
the leading activation token plus immediately following horizontal/line
whitespace. Mentions elsewhere remain unchanged.

## Security and privacy

- Continue accepting input only from the configured owner and workspace.
- Continue rejecting bot/app, hidden, edit, and unsupported subtype events.
- Do not log message text, block contents, attachment contents, URLs, tokens, or
  credentials.
- Do not persist raw Slack envelopes or unrecognized metadata.
- Do not fetch inline links.
- Accept download URLs only through the existing trusted Slack-host policy.
- Bound synthetic metadata so it cannot forge additional wrapper lines.

## Test plan

Add focused unit and adapter tests before implementation:

1. The captured forward shape (`text: ""`, one attachment with both
   `is_share: true` and `is_msg_unfurl: true`) produces a non-empty ordered body
   and is accepted.
2. A labeled link remains inline as `[label](<url>)`.
3. Rich text preserves the order of text, mentions, links, emoji, lists, quotes,
   and preformatted nodes.
4. Rich blocks win over a shorter or truncated top-level fallback without
   duplicating it.
5. Forward flag coverage includes share-only, share plus message-unfurl,
   message-unfurl-only, false, and non-boolean lookalikes. A top-level link stays
   present when its non-share unfurl attachment is ignored.
6. Multiple forwards remain ordered and are not deduplicated.
7. Unknown visible content yields an in-place marker instead of disappearing.
8. A forwarded nested Slack file joins the existing file pipeline once. Missing
   URL produces the existing durable unavailable warning; a later duplicate may
   fill missing metadata without moving the file.
9. A genuinely empty event is acknowledged without inbox activation, source
   creation, or a Codex turn. File-only and unsupported-only events remain
   visible and are not mistaken for empty.
10. The reduced/persisted inbox row contains canonical text and reduced
    `SlackFileDescriptor` records only. A descriptor may contain one trusted
    Slack download URL required for restart recovery. Raw blocks, attachments,
    unfurl URLs, author fields, and all other message metadata are absent.
11. Existing owner, subtype, activation, duplicate identity, attachment retry,
    and delivery tests remain green.
12. Deep, oversized, cyclic-looking, and malformed values exercise the envelope
    handler and prove bounded canonical persistence (or policy discard) plus
    acknowledgment, with no poison retry.
13. Restart after canonical inbox persistence drains the stored result without
    re-normalizing the raw Slack event.
14. Nested-file retry/checkpoint recovery performs no second successful
    download.
15. Overlapping `app_mention` and `message` copies retain native-source dedup
    after normalization.
16. Empty arrays and divider-only complete blocks use a non-empty fallback;
    incomplete blocks with and without fallback emit exactly one marker under
    the documented selection rules.
17. Adversarial link labels, brackets, controls, unsupported schemes, author
    controls/length, Unicode byte boundaries, and code-fence crossings preserve
    ordering and remain within the output bound.

Run the Slack-specific tests first, followed by `npm run check`.

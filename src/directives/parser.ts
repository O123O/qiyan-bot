const asciiWhitespace = new Set([" ", "\t", "\r", "\n", "\f", "\v"]);

export type ParsedDirective =
  | { kind: "none" }
  | { kind: "pass"; prefix: string; payload: string }
  | { kind: "to"; prefix: string; target: string; payload: string }
  | { kind: "collect"; prefix: string; count: number }
  | { kind: "malformed"; reason: string };

type CandidateKind = "pass" | "to" | "collect";
const markerLengths: Record<CandidateKind, number> = { pass: 5, to: 3, collect: 8 };
const nickname = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function firstCandidate(raw: string): { kind: CandidateKind; index: number } | undefined {
  for (let index = 0; index < raw.length; index += 1) {
    const kind: CandidateKind | undefined = raw.startsWith("/pass", index) ? "pass"
      : raw.startsWith("/collect", index) ? "collect" : raw.startsWith("/to", index) ? "to" : undefined;
    if (!kind) continue;
    const before = index === 0 ? undefined : raw[index - 1];
    const after = raw[index + markerLengths[kind]];
    if ((before === undefined || asciiWhitespace.has(before)) && (after === undefined || asciiWhitespace.has(after))) {
      return { kind, index };
    }
  }
  return undefined;
}

export function parseDirective(raw: string, attachmentIds: readonly string[], maxCollectCount: number): ParsedDirective {
  const candidate = firstCandidate(raw);
  if (!candidate) return { kind: "none" };
  const prefix = raw.slice(0, candidate.index);
  const suffix = raw.slice(candidate.index + markerLengths[candidate.kind]);

  // `/to <nickname> <verbatim payload>` — one required space, a nickname, one required space,
  // then the verbatim payload (empty only with attachments), mirroring /pass payload rules.
  if (candidate.kind === "to") {
    if (!suffix.startsWith(" ")) return { kind: "malformed", reason: "to_requires_ascii_space" };
    const rest = suffix.slice(1);
    const separator = rest.indexOf(" ");
    if (separator === -1) return { kind: "malformed", reason: "to_requires_nickname_and_space" };
    const target = rest.slice(0, separator);
    if (!nickname.test(target)) return { kind: "malformed", reason: "to_invalid_nickname" };
    const payload = rest.slice(separator + 1);
    // `/to` is text-only for now (the direct-ingress send has no attachment scope), so a
    // non-empty payload is required regardless of attachments.
    if (payload.length === 0) return { kind: "malformed", reason: "to_is_empty" };
    return { kind: "to", prefix, target, payload };
  }

  if (candidate.kind === "pass") {
    if (!suffix.startsWith(" ")) return { kind: "malformed", reason: "pass_requires_ascii_space" };
    const payload = suffix.slice(1);
    if (payload.length === 0 && attachmentIds.length === 0) return { kind: "malformed", reason: "pass_is_empty" };
    return { kind: "pass", prefix, payload };
  }

  if (/^[\t\r\n\f\v ]*$/.test(suffix)) return { kind: "collect", prefix, count: 1 };
  const match = /^ ([1-9][0-9]*)[\t\r\n\f\v ]*$/.exec(suffix);
  if (!match) return { kind: "malformed", reason: "invalid_collect_suffix" };
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count > maxCollectCount) return { kind: "malformed", reason: "collect_count_out_of_range" };
  return { kind: "collect", prefix, count };
}

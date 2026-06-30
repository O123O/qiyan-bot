const asciiWhitespace = new Set([" ", "\t", "\r", "\n", "\f", "\v"]);

export type ParsedDirective =
  | { kind: "none" }
  | { kind: "pass"; prefix: string; payload: string }
  | { kind: "collect"; prefix: string; count: number }
  | { kind: "malformed"; reason: string };

function firstCandidate(raw: string): { kind: "pass" | "collect"; index: number } | undefined {
  for (let index = 0; index < raw.length; index += 1) {
    const kind = raw.startsWith("/pass", index) ? "pass" : raw.startsWith("/collect", index) ? "collect" : undefined;
    if (!kind) continue;
    const length = kind === "pass" ? 5 : 8;
    const before = index === 0 ? undefined : raw[index - 1];
    const after = raw[index + length];
    if ((before === undefined || asciiWhitespace.has(before)) && (after === undefined || asciiWhitespace.has(after))) {
      return { kind, index };
    }
  }
  return undefined;
}

export function parseDirective(raw: string, attachmentIds: readonly string[], maxCollectCount: number): ParsedDirective {
  const candidate = firstCandidate(raw);
  if (!candidate) return { kind: "none" };
  const markerLength = candidate.kind === "pass" ? 5 : 8;
  const prefix = raw.slice(0, candidate.index);
  const suffix = raw.slice(candidate.index + markerLength);

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

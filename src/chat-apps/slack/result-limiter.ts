import type { SlackSearchCoverage } from "./clients.ts";

export interface TransientResults<T> {
  count: number;
  returned_count: number;
  truncated: boolean;
  order: "newest_first";
  complete: boolean;
  coverage: SlackSearchCoverage;
  warning?: string;
  results: T[];
}

interface ResultIdentity {
  channelId: string;
  timestamp: string;
  key: string;
}

interface Retained<T> {
  item: T;
  identity: ResultIdentity;
  words: number;
}

export class TransientResultLimiter<T> {
  private readonly maxItems: number;
  private readonly maxWords: number;
  private readonly identity: (item: T) => ResultIdentity;
  private readonly render: (item: T) => string;
  private retained: Retained<T>[] = [];
  private totalCount = 0;
  private wordCount = 0;

  constructor(options: {
    identity(item: T): ResultIdentity;
    render(item: T): string;
    maxItems?: number;
    maxWords?: number;
  }) {
    this.identity = options.identity;
    this.render = options.render;
    this.maxItems = options.maxItems ?? 30;
    this.maxWords = options.maxWords ?? 3_000;
    if (!Number.isInteger(this.maxItems) || this.maxItems < 1) throw new TypeError("result item limit must be a positive integer");
    if (!Number.isInteger(this.maxWords) || this.maxWords < 1) throw new TypeError("result word limit must be a positive integer");
  }

  get retainedCount(): number { return this.retained.length; }
  get retainedWords(): number { return this.wordCount; }

  addPage(page: readonly T[]): void {
    this.totalCount += page.length;
    const candidates = this.retained.concat(page.map((item) => ({
      item,
      identity: this.identity(item),
      words: countWords(this.render(item)),
    })));
    candidates.sort(compareRetained);
    const next: Retained<T>[] = [];
    let words = 0;
    for (const candidate of candidates) {
      if (next.length === this.maxItems || words + candidate.words > this.maxWords) break;
      next.push(candidate);
      words += candidate.words;
    }
    this.retained = next;
    this.wordCount = words;
  }

  finish(options: { complete: boolean; coverage: SlackSearchCoverage; warning?: string }): TransientResults<T> {
    const truncated = this.totalCount > this.retained.length;
    const warning = [
      options.warning,
      truncated ? "Results were truncated; narrow the query or date range to retrieve a more specific result." : undefined,
    ].filter((value): value is string => Boolean(value)).join(" ");
    return {
      count: this.totalCount,
      returned_count: this.retained.length,
      truncated,
      order: "newest_first",
      complete: options.complete,
      coverage: options.coverage,
      ...(warning ? { warning } : {}),
      results: this.retained.map(({ item }) => item),
    };
  }
}

function compareRetained<T>(left: Retained<T>, right: Retained<T>): number {
  const time = compareTimestamps(right.identity.timestamp, left.identity.timestamp);
  if (time !== 0) return time;
  const channel = left.identity.channelId.localeCompare(right.identity.channelId);
  return channel !== 0 ? channel : left.identity.key.localeCompare(right.identity.key);
}

function compareTimestamps(left: string, right: string): number {
  const leftMatch = /^(\d+)\.(\d+)$/u.exec(left);
  const rightMatch = /^(\d+)\.(\d+)$/u.exec(right);
  if (!leftMatch || !rightMatch) return left.localeCompare(right);
  const seconds = BigInt(leftMatch[1]!) - BigInt(rightMatch[1]!);
  if (seconds !== 0n) return seconds < 0n ? -1 : 1;
  return leftMatch[2]!.padEnd(9, "0").localeCompare(rightMatch[2]!.padEnd(9, "0"));
}

function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

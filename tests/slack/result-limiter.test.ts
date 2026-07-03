import assert from "node:assert/strict";
import test from "node:test";
import { TransientResultLimiter } from "../../src/slack/result-limiter.ts";
import type { SlackSearchCoverage } from "../../src/slack/clients.ts";

interface Match { channelId: string; messageTs: string; text: string; id: string }

const coverage: SlackSearchCoverage = {
  requested: ["public_channels", "private_channels", "im", "mpim", "files", "users"],
  authorization: "slack_enforced",
  searchAvailable: true,
  omitted: [],
  errors: [],
};

function match(index: number, words = 1, channelId = "C1", messageTs = `${1_000 - index}.000`): Match {
  return { channelId, messageTs, id: `m${index}`, text: Array.from({ length: words }, (_, word) => `w${word}`).join(" ") };
}

function limiter(options: { maxItems?: number; maxWords?: number } = {}) {
  return new TransientResultLimiter<Match>({
    identity: (item) => ({ channelId: item.channelId, timestamp: item.messageTs, key: item.id }),
    render: (item) => `${item.channelId} ${item.messageTs} ${item.text}`,
    ...options,
  });
}

test("the limiter returns 30 matches and truncates the 31st", () => {
  const exact = limiter();
  exact.addPage(Array.from({ length: 30 }, (_, index) => match(index)));
  assert.deepEqual(exact.finish({ complete: true, coverage }), {
    count: 30,
    returned_count: 30,
    truncated: false,
    order: "newest_first",
    complete: true,
    coverage,
    results: Array.from({ length: 30 }, (_, index) => match(index)),
  });

  const over = limiter();
  over.addPage(Array.from({ length: 31 }, (_, index) => match(index)));
  const result = over.finish({ complete: true, coverage });
  assert.equal(result.count, 31);
  assert.equal(result.returned_count, 30);
  assert.equal(result.truncated, true);
  assert.match(result.warning ?? "", /narrow.*query|date range/i);
  assert.equal("path" in result, false);
});

test("the Unicode-whitespace word budget accepts exactly 3000 and rejects a 3001-word prefix", () => {
  const wordLimiter = () => new TransientResultLimiter<Match>({
    identity: (item) => ({ channelId: item.channelId, timestamp: item.messageTs, key: item.id }),
    render: (item) => item.text,
  });
  const exact = wordLimiter();
  exact.addPage([match(0, 3_000)]);
  assert.equal(exact.finish({ complete: true, coverage }).returned_count, 1);

  const over = wordLimiter();
  over.addPage([match(0, 3_001)]);
  const result = over.finish({ complete: true, coverage });
  assert.equal(result.count, 1);
  assert.equal(result.returned_count, 0);
  assert.equal(result.truncated, true);

  const unicode = limiter({ maxWords: 5 });
  unicode.addPage([{ channelId: "C", messageTs: "1.000", id: "unicode", text: "one\u2003two\nthree" }]);
  assert.equal(unicode.finish({ complete: true, coverage }).returned_count, 1);
});

test("results are stabilized newest-first with channel and key tie breaks", () => {
  const value = limiter();
  value.addPage([
    { channelId: "C2", messageTs: "10.000", id: "b", text: "second" },
    { channelId: "C3", messageTs: "11.000", id: "z", text: "newest" },
  ]);
  value.addPage([
    { channelId: "C1", messageTs: "10.000", id: "c", text: "first" },
    { channelId: "C1", messageTs: "10.000", id: "a", text: "first-a" },
  ]);
  assert.deepEqual(value.finish({ complete: true, coverage }).results.map(({ id }) => id), ["z", "a", "c", "b"]);
});

test("hundreds of pages increase total count without retaining unbounded bodies", () => {
  const value = limiter();
  for (let page = 0; page < 500; page += 1) {
    value.addPage(Array.from({ length: 100 }, (_, offset) => match(page * 100 + offset, 10)));
    assert.ok(value.retainedCount <= 30);
    assert.ok(value.retainedWords <= 3_000);
  }
  const result = value.finish({ complete: false, coverage, warning: "Slack continuation was rate limited" });
  assert.equal(result.count, 50_000);
  assert.equal(result.returned_count, 30);
  assert.equal(result.complete, false);
  assert.match(result.warning ?? "", /rate limited/i);
  assert.match(result.warning ?? "", /narrow/i);
});

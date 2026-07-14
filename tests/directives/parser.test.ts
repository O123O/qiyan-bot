import assert from "node:assert/strict";
import test from "node:test";
import { parseDirective } from "../../src/directives/parser.ts";

test("parses pass without changing its payload", () => {
  assert.deepEqual(parseDirective("tell pay /pass  héllo\n/collect 9", [], 20), {
    kind: "pass", prefix: "tell pay ", payload: " héllo\n/collect 9",
  });
});

test("requires exactly an ASCII space after pass", () => {
  assert.equal(parseDirective("/pass\thello", [], 20).kind, "malformed");
  assert.equal(parseDirective("/pass", [], 20).kind, "malformed");
});

test("allows empty pass only with an attachment", () => {
  assert.equal(parseDirective("/pass ", [], 20).kind, "malformed");
  assert.deepEqual(parseDirective("/pass ", ["att_1"], 20), { kind: "pass", prefix: "", payload: "" });
});

test("parses collect count and trailing whitespace", () => {
  assert.deepEqual(parseDirective("report pay /collect 3\n", [], 20), { kind: "collect", prefix: "report pay ", count: 3 });
  assert.deepEqual(parseDirective("/collect", [], 20), { kind: "collect", prefix: "", count: 1 });
});

test("rejects malformed or excessive collect", () => {
  assert.equal(parseDirective("/collect 21", [], 20).kind, "malformed");
  assert.equal(parseDirective("/collect 3 /pass x", [], 20).kind, "malformed");
  assert.equal(parseDirective("/collect zero", [], 20).kind, "malformed");
});

test("uses ASCII whitespace boundaries only", () => {
  assert.equal(parseDirective("x\t/pass ok", [], 20).kind, "pass");
  assert.equal(parseDirective("x /pass ok", [], 20).kind, "none");
  assert.equal(parseDirective("x/pass ok", [], 20).kind, "none");
});

test("a malformed first marker is not rescued later", () => {
  assert.equal(parseDirective("/pass\tbad /pass good", [], 20).kind, "malformed");
});

test("parses /to with a target nickname and verbatim payload", () => {
  assert.deepEqual(parseDirective("/to payments  héllo\nworld", [], 20), {
    kind: "to", prefix: "", target: "payments", payload: " héllo\nworld",
  });
  // A prefix before the marker is preserved; the first token after the required space is the target.
  assert.deepEqual(parseDirective("hey /to build-1 run the build", [], 20), {
    kind: "to", prefix: "hey ", target: "build-1", payload: "run the build",
  });
});

test("/to requires a space, a valid nickname, and a separator space", () => {
  assert.equal(parseDirective("/to\tpayments hi", [], 20).kind, "malformed"); // no leading ASCII space
  assert.equal(parseDirective("/to payments", [], 20).kind, "malformed");     // no separator space
  assert.equal(parseDirective("/to  hi", [], 20).kind, "malformed");          // empty nickname
  assert.equal(parseDirective("/to UPPER hi", [], 20).kind, "malformed");     // nickname must be lowercase
  assert.equal(parseDirective("/to bad/name hi", [], 20).kind, "malformed");  // invalid nickname char
});

test("/to requires a non-empty payload (text-only for now, even with an attachment)", () => {
  assert.equal(parseDirective("/to payments ", [], 20).kind, "malformed");
  assert.equal(parseDirective("/to payments ", ["att_1"], 20).kind, "malformed");
});

test("/to does not false-match a longer word and yields to an earlier directive", () => {
  assert.equal(parseDirective("/tomorrow we ship", [], 20).kind, "none"); // /to must be followed by whitespace
  // The first directive marker in the string wins.
  assert.equal(parseDirective("/pass x /to payments y", [], 20).kind, "pass");
  assert.equal(parseDirective("/to payments do /pass x", [], 20).kind, "to");
});

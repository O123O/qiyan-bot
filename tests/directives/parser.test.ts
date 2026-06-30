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

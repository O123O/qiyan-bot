import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatGoalStatus, selectedWorkerGoal } from "../../webui-client/src/goal-presentation.ts";

const sessions = [
  { nickname: "with-goal", goal: { objective: "Ship the migration", status: "active" } },
  { nickname: "without-goal", goal: null },
];

test("shows a goal only for the selected worker that owns it", () => {
  assert.deepEqual(selectedWorkerGoal(sessions, "with-goal"), {
    objective: "Ship the migration",
    status: "active",
  });
  assert.equal(selectedWorkerGoal(sessions, "without-goal"), null);
  assert.equal(selectedWorkerGoal(sessions, null), null);
  assert.equal(selectedWorkerGoal(sessions, "missing"), null);
});

test("formats protocol goal statuses for display", () => {
  assert.equal(formatGoalStatus("active"), "active");
  assert.equal(formatGoalStatus("budgetLimited"), "budget limited");
  assert.equal(formatGoalStatus("usageLimited"), "usage limited");
});

test("renders the selected worker goal above the composer and reflows pinned chat on live changes", async () => {
  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  const row = source.indexOf('{goal && <div className="goal-row"');
  const composer = source.indexOf('<div className="composer">');

  assert.notEqual(row, -1, "goal row is conditionally rendered");
  assert.ok(row < composer, "goal row precedes the composer");
  assert.match(source, /className="goal-status"[^>]*>\{formatGoalStatus\(goal\.status\)\}<\/span>/u);
  assert.match(source, /className="goal-objective">\{goal\.objective\}<\/div>/u);
  assert.match(source, /\[rendered\.length, tailRevision, selected, loadingOlder, goal\?\.objective, goal\?\.status\]/u);

  const shipped = await readFile(new URL("../../assets/webui/index.html", import.meta.url), "utf8");
  assert.match(shipped, /goal-row/u, "the shipped client contains the goal row");
});

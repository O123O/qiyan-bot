import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  advanceWorkerScrollPreservation,
  nextWorkerHistoryAutoFill,
  releaseWorkerHistoryAutoFill,
  sameWorkerSubscriptionTarget,
  settleWorkerScrollPreservation,
  shouldFollowWorkerTail,
  workerViewportRevision,
} from "../../webui-client/src/worker-chat-policy.ts";

test("a sparse worker history page follows its cursor only while the viewport is underfilled", () => {
  const common = { hasOlder: true, historyInFlight: false, loadingOlder: false, cursor: "older", attempts: 0, recentBoundaryPending: false };
  assert.equal(nextWorkerHistoryAutoFill({ ...common, scrollHeight: 400, clientHeight: 600 }), "older");
  assert.equal(nextWorkerHistoryAutoFill({ ...common, scrollHeight: 601, clientHeight: 600 }), undefined);
  assert.equal(nextWorkerHistoryAutoFill({ ...common, historyInFlight: true, scrollHeight: 400, clientHeight: 600 }), undefined);
  assert.equal(nextWorkerHistoryAutoFill({ ...common, attempts: 8, scrollHeight: 400, clientHeight: 600 }), undefined);
  assert.equal(nextWorkerHistoryAutoFill({ ...common, hasOlder: false, scrollHeight: 400, clientHeight: 600 }), undefined);
});

test("an initial open-turn page crosses the latest completed-turn boundary even when scrollable", () => {
  const common = {
    hasOlder: true, historyInFlight: false, loadingOlder: false, cursor: "older",
    attempts: 0, recentBoundaryPending: true, scrollHeight: 900, clientHeight: 600,
  };
  assert.equal(nextWorkerHistoryAutoFill(common), "older");
  assert.equal(nextWorkerHistoryAutoFill({ ...common, attempts: 8 }), undefined, "boundary search stays capped");
  assert.equal(nextWorkerHistoryAutoFill({ ...common, hasOlder: false }), undefined);
});

test("a pinned panel follows body growth and auto-prepend but preserves manual prepend position", () => {
  const before = workerViewportRevision("worker", [{ id: "a:turn:item", body: "work" }]);
  const after = workerViewportRevision("worker", [{ id: "a:turn:item", body: "working" }]);
  assert.notEqual(after, before, "tail revision must change even when the row count and id do not");
  assert.equal(shouldFollowWorkerTail({ pinned: true, preservePending: false, previousRevision: before, nextRevision: after }), true);
  assert.equal(shouldFollowWorkerTail({ pinned: false, preservePending: false, previousRevision: before, nextRevision: after }), false);
  assert.equal(shouldFollowWorkerTail({ pinned: true, preservePending: true, previousRevision: before, nextRevision: after }), false);
  assert.equal(shouldFollowWorkerTail({ pinned: true, preservePending: false, previousRevision: after, nextRevision: after }), false);

  const prepended = workerViewportRevision("worker", [{ id: "older", body: "old" }, { id: "a:turn:item", body: "work" }]);
  assert.notEqual(prepended, before, "a pinned auto-fill prepend must follow the unchanged tail");
  assert.equal(shouldFollowWorkerTail({ pinned: true, preservePending: false, previousRevision: before, nextRevision: prepended }), true);
  assert.equal(shouldFollowWorkerTail({ pinned: true, preservePending: true, previousRevision: before, nextRevision: prepended }), false);

  const goalChanged = workerViewportRevision("worker", [{ id: "a:turn:item", body: "work" }], "active:new goal");
  assert.notEqual(goalChanged, before, "goal-row reflow must update the viewport revision");
});

test("a history admission loss releases the consumed cursor without resetting its retry budget", () => {
  const consumed = { attempts: 3, cursor: "older" };
  assert.deepEqual(releaseWorkerHistoryAutoFill(consumed, "older"), { attempts: 3, cursor: undefined });
  assert.deepEqual(releaseWorkerHistoryAutoFill(consumed, "different"), consumed);
  assert.equal(nextWorkerHistoryAutoFill({
    hasOlder: true, historyInFlight: false, loadingOlder: false, cursor: "older", attempts: 3,
    recentBoundaryPending: false, scrollHeight: 400, clientHeight: 600,
  }), "older");
});

test("manual prepend preservation survives live growth until the history read settles", () => {
  const live = advanceWorkerScrollPreservation({ height: 100, pending: true }, 130);
  assert.deepEqual(live, { scrollDelta: 30, state: { height: 130, pending: true } });

  const settled = settleWorkerScrollPreservation(live.state);
  assert.deepEqual(settled, { height: 130, pending: false });
  const prepended = advanceWorkerScrollPreservation(settled, 230);
  assert.deepEqual(prepended, { scrollDelta: 100, state: null });
});

test("same-socket worker subscriptions deduplicate but rejection invalidates the App guard", async () => {
  const socket = {};
  const target = { socket, nickname: "worker", mappingId: "mapping" };
  assert.equal(sameWorkerSubscriptionTarget(target, { ...target }), true);
  assert.equal(sameWorkerSubscriptionTarget(target, { ...target, socket: {} }), false);
  assert.equal(sameWorkerSubscriptionTarget(target, { ...target, nickname: "other" }), false);
  assert.equal(sameWorkerSubscriptionTarget(target, { ...target, mappingId: "replacement" }), false);

  const source = await readFile(new URL("../../webui-client/src/App.tsx", import.meta.url), "utf8");
  assert.match(source, /const streamNickname = nickname \?\? ASSIST_STREAM;/u);
  assert.match(source, /if \(!session\) \{[\s\S]{0,200}workerSubscriptionTargetRef\.current = null;/u);
  assert.match(source, /m\.type === "worker\/subscription-error"[\s\S]{0,500}workerSubscriptionTargetRef\.current = null;/u);
});

import assert from "node:assert/strict";
import { finalStateIsComplete, initialStudyAction, nextStudyAction, remainingBreakMs } from "../study-flow.js";

const config = {
  trialCount: 114,
  attentionChecks: [
    { afterTrial: 12, response: 1 },
    { afterTrial: 50, response: 3 },
    { afterTrial: 88, response: 1 }
  ],
  breakAfterTrials: [38, 76]
};
const passed = (afterTrial) => ({ afterTrial, passed: true });
const completedBreak = (afterTrial) => ({ afterTrial, startedAt: "2026-08-25T00:00:00.000Z", completedAt: "2026-08-25T00:01:00.000Z" });

assert.deepEqual(nextStudyAction({ trialCursor: 0, attentionChecks: [], breaks: [] }, config), {
  type: "trial", globalTrialIndex: 1
});
assert.deepEqual(nextStudyAction({ trialCursor: 12, attentionChecks: [], breaks: [] }, config), {
  type: "attention", afterTrial: 12
});
assert.deepEqual(nextStudyAction({ trialCursor: 38, attentionChecks: [passed(12)], breaks: [] }, config), {
  type: "break", afterTrial: 38
});
assert.deepEqual(nextStudyAction({ trialCursor: 38, attentionChecks: [passed(12)], breaks: [completedBreak(38)] }, config), {
  type: "trial", globalTrialIndex: 39
});
assert.deepEqual(nextStudyAction({ trialCursor: 50, attentionChecks: [passed(12)], breaks: [completedBreak(38)] }, config), {
  type: "attention", afterTrial: 50
});
assert.deepEqual(nextStudyAction({ trialCursor: 76, attentionChecks: [passed(12), passed(50)], breaks: [completedBreak(38)] }, config), {
  type: "break", afterTrial: 76
});
assert.deepEqual(nextStudyAction({ trialCursor: 88, attentionChecks: [passed(12), passed(50)], breaks: [completedBreak(38), completedBreak(76)] }, config), {
  type: "attention", afterTrial: 88
});
const complete = {
  trialCursor: 114,
  attentionChecks: [passed(12), passed(50), passed(88)],
  breaks: [completedBreak(38), completedBreak(76)]
};
assert.deepEqual(nextStudyAction(complete, config), { type: "post_study" });
assert.equal(finalStateIsComplete(complete, config), true);
assert.equal(finalStateIsComplete({ ...complete, trialCursor: 113 }, config), false);
assert.equal(finalStateIsComplete({ ...complete, breaks: [completedBreak(38)] }, config), false);

const startedAt = "2026-08-25T00:00:00.000Z";
assert.equal(remainingBreakMs(startedAt, Date.parse(startedAt) + 15000, 60000), 45000);
assert.equal(remainingBreakMs(startedAt, Date.parse(startedAt) + 60000, 60000), 0);
assert.equal(remainingBreakMs("invalid", Date.now(), 60000), 60000);

assert.equal(initialStudyAction(null), "start");
assert.equal(initialStudyAction({ status: "upload_error", slot: null }), "allocate");
assert.equal(initialStudyAction({ status: "upload_error", slot: 4 }), "resume");
assert.equal(initialStudyAction({ status: "in_progress", slot: 4 }), "resume");
assert.equal(initialStudyAction({ status: "complete" }), "complete");
assert.equal(initialStudyAction({ status: "screened_out", earlyExit: { reason: "eligibility_criteria" } }), "early_exit");

console.log("Startup recovery, three-set flow, attention gates, breaks, and completion verified.");


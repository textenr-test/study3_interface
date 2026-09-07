import assert from "node:assert/strict";
import { resolveEarlyExitRoute } from "../exit-routing.js";

assert.deepEqual(resolveEarlyExitRoute("eligibility_criteria"), {
  redirectKey: "screenedOut",
  status: "screened_out",
  heading: "This study is not a match for you.",
  message: "Thank you for completing the brief eligibility section. You will now return to Prolific, where the configured screen-out payment will be applied."
});
assert.throws(() => resolveEarlyExitRoute("color_vision_check"), /Unknown early-exit reason/);
assert.equal(resolveEarlyExitRoute("incompatible_device").redirectKey, "incompatibleDevice");
assert.equal(resolveEarlyExitRoute("incompatible_device").status, "return_requested_incompatible_device");
assert.equal(resolveEarlyExitRoute("failed_comprehension_twice").redirectKey, "failedComprehension");
assert.equal(resolveEarlyExitRoute("failed_comprehension_twice").status, "return_requested_failed_comprehension");
assert.throws(() => resolveEarlyExitRoute("unknown_reason"), /Unknown early-exit reason/);

console.log("Early-exit reasons map to the intended Prolific completion paths.");


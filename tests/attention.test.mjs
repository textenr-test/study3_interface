import assert from "node:assert/strict";
import { expectedAttentionResponse } from "../attention.js";

const schedule = [
  { afterTrial: 12, response: 1 },
  { afterTrial: 50, response: 3 },
  { afterTrial: 88, response: 1 }
];
assert.equal(expectedAttentionResponse(12, schedule), 1);
assert.equal(expectedAttentionResponse(50, schedule), 3);
assert.equal(expectedAttentionResponse(88, schedule), 1);
assert.throws(() => expectedAttentionResponse(19, schedule), /Unknown attention-check position/);

console.log("Attention-check answers verified: one per set (+1, +3, +1).");


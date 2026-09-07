import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { loadParticipantAssignment, validateAssignmentPayload } from "../assignment.js";

const allocationIndex = JSON.parse(fs.readFileSync(new URL("../assignments/index.json", import.meta.url), "utf8"));
const slotPayloads = Array.from({ length: 42 }, (_, index) => JSON.parse(fs.readFileSync(
  new URL(`../assignments/slots/slot-${String(index + 1).padStart(2, "0")}.json`, import.meta.url),
  "utf8"
)));
const records = slotPayloads.flatMap((payload) => payload.trials);
const conditions = ["D1_derived", "D2_derived", "W_writer_optimal", "D3_derived", "D4_derived", "D5_maximal", "M_model_optimal"];
const documents = Array.from({ length: 19 }, (_, index) => [
  `P${index + 1}_DOC_A`,
  `P${index + 1}_DOC_B`
]).flat();

function countBy(selected, keyOf) {
  const result = new Map();
  selected.forEach((record) => {
    const key = keyOf(record);
    result.set(key, (result.get(key) || 0) + 1);
  });
  return result;
}

function assertCounts(label, counts, accepted) {
  for (const [key, count] of counts) {
    assert.ok(accepted.includes(count), `${label} ${key}: ${count}`);
  }
}

assert.equal(allocationIndex.study_version, "2026-09-07-study3-v1");
assert.equal(allocationIndex.assignment_version, "n42-study3-fano-v1");
assert.equal(allocationIndex.participant_slots.length, 42);
assert.equal(records.length, 4788);
assert.equal(
  crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex"),
  allocationIndex.allocation_sha256
);

assertCounts("participant", countBy(records, (r) => r.participant_slot), [114]);
assertCounts("participant-set", countBy(records, (r) => `${r.participant_slot}:${r.set_id}`), [38]);
assertCounts("participant-document", countBy(records, (r) => `${r.participant_slot}:${r.document_id}`), [3]);
assertCounts("document-set", countBy(records, (r) => `${r.document_id}:${r.set_id}`), [42]);
assertCounts("participant-condition", countBy(records, (r) => `${r.participant_slot}:${r.condition_id}`), [16, 17]);
assertCounts("document-condition", countBy(records, (r) => `${r.document_id}:${r.condition_id}`), [18]);
assertCounts("document-condition-set", countBy(records, (r) => `${r.document_id}:${r.condition_id}:${r.set_id}`), [6]);
assertCounts("participant-set-condition", countBy(records, (r) => `${r.participant_slot}:${r.set_id}:${r.condition_id}`), [5, 6]);
assertCounts(
  "participant-set-baseline-left",
  countBy(records.filter((r) => r.baseline_side === "left"), (r) => `${r.participant_slot}:${r.set_id}`),
  [19]
);
assertCounts(
  "document-condition-baseline-left",
  countBy(records.filter((r) => r.baseline_side === "left"), (r) => `${r.document_id}:${r.condition_id}`),
  [9]
);

const cooccurrence = new Map();
for (let slot = 1; slot <= 42; slot += 1) {
  const slotUrl = new URL(`../assignments/slots/slot-${String(slot).padStart(2, "0")}.json`, import.meta.url);
  const slotPayload = slotPayloads[slot - 1];
  validateAssignmentPayload(slotPayload, {
    participantSlot: slot,
    studyVersion: allocationIndex.study_version,
    assignmentVersion: allocationIndex.assignment_version
  });
  const slotRows = records.filter((record) => record.participant_slot === slot);
  assert.equal(slotPayload.trials.length, 114);
  assert.deepEqual(slotPayload.trials, slotRows);
  assert.equal(
    crypto.createHash("sha256").update(JSON.stringify(slotRows)).digest("hex"),
    slotPayload.allocation_sha256
  );

  const setOrders = [1, 2, 3].map((setId) => slotRows
    .filter((record) => record.set_id === setId)
    .sort((a, b) => a.set_trial_index - b.set_trial_index)
    .map((record) => record.document_id));
  documents.forEach((documentId) => {
    const docRows = slotRows.filter((record) => record.document_id === documentId);
    assert.equal(new Set(docRows.map((record) => record.condition_id)).size, 3);
    assert.equal(new Set(setOrders.map((order) => order.indexOf(documentId))).size, 3);
    const docConditions = docRows.map((record) => record.condition_id).sort();
    for (let left = 0; left < 3; left += 1) {
      for (let right = left + 1; right < 3; right += 1) {
        const key = `${documentId}:${docConditions[left]}:${docConditions[right]}`;
        cooccurrence.set(key, (cooccurrence.get(key) || 0) + 1);
      }
    }
  });
  for (let setIndex = 0; setIndex < 2; setIndex += 1) {
    const previousLast = new Set(setOrders[setIndex].slice(-5));
    assert.equal(setOrders[setIndex + 1].slice(0, 5).some((doc) => previousLast.has(doc)), false);
  }
  assert.deepEqual(
    conditions.map((condition) => slotRows.filter((record) => record.condition_id === condition).length).sort((a, b) => a - b),
    [16, 16, 16, 16, 16, 17, 17]
  );
  assert.equal(slotPayload.attention_checks.length, 3);
}
assert.equal(cooccurrence.size, 38 * 21);
assertCounts("document-condition-pair", cooccurrence, [6]);

const slotOne = JSON.parse(fs.readFileSync(new URL("../assignments/slots/slot-01.json", import.meta.url), "utf8"));
globalThis.fetch = async () => ({ ok: true, json: async () => slotOne });
const loaded = await loadParticipantAssignment({
  participantSlot: 1,
  studyVersion: allocationIndex.study_version,
  assignmentVersion: allocationIndex.assignment_version
});
assert.equal(loaded.trials.length, 114);
assert.equal(loaded.trials[0].globalTrialIndex, 1);
assert.equal(loaded.trials[113].globalTrialIndex, 114);
assert.equal(loaded.trials[0].allocationId, "n42-study3-fano-v1-slot-01");
assert.equal(loaded.attentionChecks.length, 3);

console.log("Assignment verified: 42 slots × 3 sets × 38 trials = 4,788; exact Fano and marginal constraints pass.");

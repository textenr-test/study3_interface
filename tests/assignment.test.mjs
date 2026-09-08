import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { loadParticipantAssignment, validateAssignmentPayload } from "../assignment.js";

const participantCount = 35;
const conditions = [
  "D1_derived", "D2_derived", "W_writer_optimal", "D3_derived",
  "D4_derived", "D5_maximal", "M_model_optimal"
];
const documents = Array.from({ length: 19 }, (_, index) => [
  `P${index + 1}_DOC_A`,
  `P${index + 1}_DOC_B`
]).flat();
const allocationIndex = JSON.parse(fs.readFileSync(
  new URL("../assignments/index.json", import.meta.url), "utf8"
));
const slotPayloads = Array.from({ length: participantCount }, (_, index) => JSON.parse(
  fs.readFileSync(
    new URL(`../assignments/slots/slot-${String(index + 1).padStart(2, "0")}.json`, import.meta.url),
    "utf8"
  )
));
const records = slotPayloads.flatMap((payload) => payload.trials);

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

function unorderedPairs(values) {
  const ordered = [...values].sort();
  const result = [];
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      result.push([ordered[left], ordered[right]]);
    }
  }
  return result;
}

function maximumRun(values) {
  let maximum = values.length ? 1 : 0;
  let current = maximum;
  for (let index = 1; index < values.length; index += 1) {
    current = values[index] === values[index - 1] ? current + 1 : 1;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

assert.equal(allocationIndex.study_version, "2026-09-08-study3-v2");
assert.equal(allocationIndex.assignment_version, "n35-study3-carryover-v2");
assert.equal(allocationIndex.participant_slots.length, participantCount);
assert.equal(records.length, 3990);
assert.equal(
  crypto.createHash("sha256").update(JSON.stringify(records)).digest("hex"),
  allocationIndex.allocation_sha256
);
assert.equal(fs.existsSync(new URL("../assignments/slots/slot-36.json", import.meta.url)), false);

assertCounts("participant", countBy(records, (row) => row.participant_slot), [114]);
assertCounts("participant-set", countBy(records, (row) => `${row.participant_slot}:${row.set_id}`), [38]);
assertCounts("participant-document", countBy(records, (row) => `${row.participant_slot}:${row.document_id}`), [3]);
assertCounts("document-set", countBy(records, (row) => `${row.document_id}:${row.set_id}`), [35]);
assertCounts("participant-condition", countBy(records, (row) => `${row.participant_slot}:${row.condition_id}`), [16, 17]);
assertCounts("document-condition", countBy(records, (row) => `${row.document_id}:${row.condition_id}`), [15]);
assertCounts("document-condition-set", countBy(records, (row) => `${row.document_id}:${row.condition_id}:${row.set_id}`), [5]);
assertCounts("participant-set-condition", countBy(records, (row) => `${row.participant_slot}:${row.set_id}:${row.condition_id}`), [5, 6]);
assertCounts("condition-position", countBy(records, (row) => `${row.condition_id}:${row.global_trial_index}`), [5]);

const leftRecords = records.filter((row) => row.baseline_side === "left");
assertCounts("participant-set-left", countBy(leftRecords, (row) => `${row.participant_slot}:${row.set_id}`), [19]);
assertCounts("document-condition-set-left", countBy(leftRecords, (row) => `${row.document_id}:${row.condition_id}:${row.set_id}`), [2, 3]);
assertCounts("condition-position-left", countBy(leftRecords, (row) => `${row.condition_id}:${row.global_trial_index}`), [2, 3]);
assertCounts("global-position-left", countBy(leftRecords, (row) => row.global_trial_index), [17, 18]);

const pairCounts = new Map();
const orderedTransitions = new Map();
const withinSetTransitions = new Map();
const uniqueDocumentOrders = new Set();
const attentionBySetPosition = new Map();
const attentionAcrossSets = new Map();
let duplicateCases = 0;
let maximumSideRun = 0;

for (let slot = 1; slot <= participantCount; slot += 1) {
  const slotPayload = slotPayloads[slot - 1];
  validateAssignmentPayload(slotPayload, {
    participantSlot: slot,
    studyVersion: allocationIndex.study_version,
    assignmentVersion: allocationIndex.assignment_version
  });
  const slotRows = records
    .filter((record) => record.participant_slot === slot)
    .sort((left, right) => left.global_trial_index - right.global_trial_index);
  assert.deepEqual(slotPayload.trials, slotRows);
  assert.equal(
    crypto.createHash("sha256").update(JSON.stringify(slotRows)).digest("hex"),
    slotPayload.allocation_sha256
  );
  assert.deepEqual(
    conditions.map((condition) => slotRows.filter((row) => row.condition_id === condition).length).sort((a, b) => a - b),
    [16, 16, 16, 16, 16, 17, 17]
  );
  maximumSideRun = Math.max(maximumSideRun, maximumRun(slotRows.map((row) => row.baseline_side)));

  for (let index = 1; index < slotRows.length; index += 1) {
    const pair = `${slotRows[index - 1].condition_id}|${slotRows[index].condition_id}`;
    assert.notEqual(slotRows[index - 1].condition_id, slotRows[index].condition_id);
    orderedTransitions.set(pair, (orderedTransitions.get(pair) || 0) + 1);
  }

  const setOrders = [];
  for (let setId = 1; setId <= 3; setId += 1) {
    const setRows = slotRows.filter((row) => row.set_id === setId);
    const order = setRows.map((row) => row.document_id);
    setOrders.push(order);
    uniqueDocumentOrders.add(order.join("|"));
    assert.deepEqual(
      conditions.map((condition) => setRows.filter((row) => row.condition_id === condition).length).sort((a, b) => a - b),
      [5, 5, 5, 5, 6, 6, 6]
    );
    for (let index = 1; index < setRows.length; index += 1) {
      const pair = `${setRows[index - 1].condition_id}|${setRows[index].condition_id}`;
      withinSetTransitions.set(pair, (withinSetTransitions.get(pair) || 0) + 1);
      const previousWriter = Math.floor((setRows[index - 1].document_index - 1) / 2);
      const currentWriter = Math.floor((setRows[index].document_index - 1) / 2);
      assert.notEqual(previousWriter, currentWriter, `same-writer adjacency in slot ${slot}, set ${setId}`);
    }
  }
  for (let setIndex = 0; setIndex < 2; setIndex += 1) {
    const previousLast = new Set(setOrders[setIndex].slice(-5));
    assert.equal(setOrders[setIndex + 1].slice(0, 5).some((doc) => previousLast.has(doc)), false);
  }

  for (const documentId of documents) {
    const documentRows = slotRows.filter((row) => row.document_id === documentId);
    assert.equal(new Set(documentRows.map((row) => row.set_trial_index)).size, 3);
    const triple = [...new Set(documentRows.map((row) => row.condition_id))];
    assert.equal(triple.length, 3);
    const equivalent = documentRows[0].model_optimal_equivalent_condition_id;
    if (equivalent && triple.includes("M_model_optimal") && triple.includes(equivalent)) duplicateCases += 1;
    assert.equal(documentRows.some((row) => row.within_document_visual_duplicate), false);
    for (const [left, right] of unorderedPairs(triple)) {
      const key = `${documentId}:${left}:${right}`;
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    }
  }

  for (const check of slotPayload.attention_checks) {
    const setKey = `${check.set_id}:${check.within_set_after_trial}`;
    attentionBySetPosition.set(setKey, (attentionBySetPosition.get(setKey) || 0) + 1);
    attentionAcrossSets.set(
      check.within_set_after_trial,
      (attentionAcrossSets.get(check.within_set_after_trial) || 0) + 1
    );
  }
}

assert.equal(duplicateCases, 0);
assert.equal(maximumSideRun, 3);
assert.equal(uniqueDocumentOrders.size, 105);
assert.equal(orderedTransitions.size, 42);
assertCounts("ordered transition", orderedTransitions, [94, 95]);
assert.equal(withinSetTransitions.size, 42);
assertCounts("pooled within-set transition", withinSetTransitions, [92, 93]);
assertCounts("attention set-position", attentionBySetPosition, [1, 2]);
assert.equal(attentionBySetPosition.size, 63);
assertCounts("attention position across sets", attentionAcrossSets, [5]);

for (const documentId of documents) {
  const firstRow = records.find((row) => row.document_id === documentId);
  const equivalent = firstRow.model_optimal_equivalent_condition_id;
  for (const [left, right] of unorderedPairs(conditions)) {
    const frequency = pairCounts.get(`${documentId}:${left}:${right}`) || 0;
    if (!equivalent) {
      assert.equal(frequency, 5, `${documentId} ${left}/${right}`);
    } else if ([left, right].includes("M_model_optimal") && [left, right].includes(equivalent)) {
      assert.equal(frequency, 0, `${documentId} forbidden M/equivalent-D pair`);
    } else {
      assert.ok([4, 5, 6].includes(frequency), `${documentId} ${left}/${right}: ${frequency}`);
    }
  }
}

const slotOne = slotPayloads[0];
globalThis.fetch = async () => ({ ok: true, json: async () => slotOne });
const loaded = await loadParticipantAssignment({
  participantSlot: 1,
  studyVersion: allocationIndex.study_version,
  assignmentVersion: allocationIndex.assignment_version
});
assert.equal(loaded.trials.length, 114);
assert.equal(loaded.trials[0].globalTrialIndex, 1);
assert.equal(loaded.trials[113].globalTrialIndex, 114);
assert.equal(loaded.trials[0].allocationId, "n35-study3-carryover-v2-slot-01");
assert.equal(loaded.attentionChecks.length, 3);
await assert.rejects(
  () => loadParticipantAssignment({
    participantSlot: 36,
    studyVersion: allocationIndex.study_version,
    assignmentVersion: allocationIndex.assignment_version
  }),
  /1 to 35/
);

const flaggedPayload = structuredClone(slotOne);
flaggedPayload.trials[0].within_document_visual_duplicate = true;
assert.throws(
  () => validateAssignmentPayload(flaggedPayload),
  /must never share/
);

console.log("Assignment verified: 35 slots × 3 sets × 38 trials = 3,990; carryover, no-duplicate, marginal, order, side, and attention constraints pass.");

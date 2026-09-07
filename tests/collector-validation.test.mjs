import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { TRIAL_LOG_HEADERS } from "../log-schema.js";

const source = fs.readFileSync(new URL("../apps-script/Code.gs", import.meta.url), "utf8");
const context = { console, Set, Map, Date, JSON, Number, String, Object, Boolean, Math, RegExp, Array };
vm.runInNewContext(source + "\nglobalThis.__HEADERS = HEADERS; globalThis.__COLLECTOR_SERVICE = COLLECTOR_SERVICE; globalThis.__COLLECTOR_VERSION = COLLECTOR_VERSION; globalThis.__SCHEMA_VERSION = SCHEMA_VERSION; globalThis.__MAX_BATCH_SIZE = MAX_BATCH_SIZE;", context, { filename: "Code.gs" });
assert.deepEqual(Array.from(context.__HEADERS.Trials), TRIAL_LOG_HEADERS);
assert.deepEqual(Array.from(context.__HEADERS.TrialJSON), [
  "event_id", "participant_id", "session_id", "study_id", "global_trial_index", "record_json",
  "received_at", "study_version"
]);
assert.equal(context.__COLLECTOR_SERVICE, "text-enrichment-reader-study3");
assert.equal(context.__COLLECTOR_VERSION, "2026-09-07-study3-v1");
assert.equal(context.__SCHEMA_VERSION, "text-enrichment-trial-log-v3");
assert.equal(context.__MAX_BATCH_SIZE, 8);
assert.match(source, /payload\.kind === "batch" \? storePayloadBatch_\(payload\) : storePayload_\(payload\)/);
assert.match(source, /function recordSlotReservation_/);
assert.match(source, /type: "slot_reserved"/);
assert.match(source, /const exports = finalPayload \? exportStudyLogs\(\) : null/);
assert.doesNotMatch(source, /sheet\.appendRow\(/);

const participantRow = {
  participant_id: "P001",
  session_id: "S001",
  study_id: "STUDY01",
  participant_slot: 4,
  allocation_id: "n42-study3-fano-v1-slot-04"
};
const valid = {
  eventId: "trial_0123456789abcdef",
  participantSlot: 4,
  allocationId: participantRow.allocation_id,
  setId: 2,
  setTrialIndex: 12,
  globalTrialIndex: 50,
  documentId: "P19_DOC_B",
  conditionId: "D3_derived",
  enrichedFile: "D3_derived.html",
  degreeValue: 4,
  baselineSide: "left",
  enrichedSide: "right",
  documentExposureNumber: 2,
  randomizationSeed: "text-enrichment-reader-study3-n42-v1:slot:4:set:2:position-schedule-v1",
  fanoBlockId: "A",
  setPermutationId: "123",
  assignedConditionTriple: ["D1_derived", "D3_derived", "M_model_optimal"],
  withinDocumentVisualDuplicate: false,
  rating: 2,
  spatialRating: -2,
  responseTime: 840,
  sourceDocumentId: "doc-source",
  validationStatus: "pass",
  visualCoverage: 0.7,
  targetCoverage: 0.67,
  retainedFactorCount: 44,
  plannedFixationMs: 750,
  plannedExposureMs: 1000,
  actualExposureMs: 1002,
  preloadMs: 30,
  attemptCount: 1,
  stimulusScale: 0.55,
  sourceViewportWidth: 900,
  sourceViewportHeight: 2158,
  fittedContentHeight: 1500,
  leftContentHeight: 1490,
  rightContentHeight: 1500,
  trimmedBottomWhitespacePx: 658,
  fullscreen: true,
  displayInfo: { innerWidth: 1440, innerHeight: 900 },
  respondedAt: "2026-08-25T00:00:00.000Z"
};

const canonical = context.validateTrialRecord_(valid, "2026-09-07-study3-v1", participantRow);
assert.equal(canonical.global_trial_index, 50);
assert.equal(canonical.set_id, 2);
assert.equal(canonical.document_exposure_number, 2);
assert.equal(canonical.rating, 2);
assert.equal(canonical.response_time, 840);
assert.equal(canonical.study_version, "2026-09-07-study3-v1");

assert.throws(() => context.validateTrialRecord_({ ...valid, globalTrialIndex: 49 }, "2026-09-07-study3-v1", participantRow), /Global trial index mismatch/);
assert.throws(() => context.validateTrialRecord_({ ...valid, enrichedSide: "left" }, "2026-09-07-study3-v1", participantRow), /side allocation/);
assert.throws(() => context.validateTrialRecord_({ ...valid, rating: 4 }, "2026-09-07-study3-v1", participantRow), /rating/);
assert.throws(() => context.validateTrialRecord_({ ...valid, randomizationSeed: "wrong" }, "2026-09-07-study3-v1", participantRow), /Randomization seed mismatch/);
assert.equal(context.allocationIdForSlot_(42), "n42-study3-fano-v1-slot-42");

const identity = { participantId: "P001", sessionId: "S001", studyId: "STUDY01" };
const trialRows = Array.from({ length: 114 }, (_, index) => ({
  participant_id: identity.participantId,
  session_id: identity.sessionId,
  study_id: identity.studyId,
  global_trial_index: index + 1,
  set_id: Math.floor(index / 38) + 1
}));
const eventRows = [
  ...[12, 50, 88].map((afterTrial) => ({
    participant_id: identity.participantId,
    session_id: identity.sessionId,
    study_id: identity.studyId,
    event_type: "attention_check",
    detail_json: JSON.stringify({ afterTrial, passed: true })
  })),
  ...[1, 2].map((setId) => ({
    participant_id: identity.participantId,
    session_id: identity.sessionId,
    study_id: identity.studyId,
    event_type: "break_completed",
    detail_json: JSON.stringify({ setId })
  }))
];
context.getOrCreateSheet_ = (_spreadsheet, name) => ({ name });
context.ensureHeaders_ = () => {};
context.readTable_ = (sheet) => ({ rows: sheet.name === "Trials" ? trialRows : eventRows });
context.readSelectedTable_ = (sheet) => ({ rows: sheet.name === "Trials" ? trialRows : eventRows });
const audit = context.completionAudit_({}, identity);
assert.equal(audit.complete, true);
assert.deepEqual(Array.from(audit.setCounts), [38, 38, 38]);
assert.equal(audit.attentionChecksPassed, 3);
assert.equal(audit.completedBreaks, 2);
trialRows.pop();
assert.equal(context.completionAudit_({}, identity).complete, false);

let participantWrites = 0;
const headerValues = [["participant_id", "status", "completed_trials"]];
const participantValues = [["P001", "in_progress", 49]];
const participantSheet = {
  getLastColumn: () => 3,
  getRange: (row) => row === 1
    ? { getValues: () => headerValues }
    : {
        getValues: () => participantValues,
        setValues: (values) => {
          participantWrites += 1;
          participantValues[0] = values[0];
        }
      }
};
context.updateParticipantFields_(participantSheet, 2, { status: "complete", completed_trials: 114 });
assert.equal(participantWrites, 1);
assert.deepEqual(participantValues[0], ["P001", "complete", 114]);

let bulkWrite;
const bulkSheet = {
  getLastRow: () => 4,
  getRange: (row, column, rowCount, columnCount) => ({
    setValues: (values) => { bulkWrite = { row, column, rowCount, columnCount, values }; }
  })
};
context.appendObjectRows_(bulkSheet, ["event_id", "rating"], [
  { event_id: "trial_a", rating: 1 },
  { event_id: "trial_b", rating: -1 }
]);
assert.equal(bulkWrite.row, 5);
assert.equal(bulkWrite.rowCount, 2);
assert.deepEqual(bulkWrite.values, [["trial_a", 1], ["trial_b", -1]]);

const eventRow = context.eventObject_({ type: "screenout" }, {
  kind: "screenout",
  requestId: "screenout_0123456789abcdef",
  studyVersion: "2026-09-07-study3-v1",
  participant: { slot: "" },
  participantSummary: { completedTrials: 0 }
}, identity);
assert.equal(eventRow.event_id, "screenout_0123456789abcdef");

console.log("Collector health metadata, bulk writes, idempotency, canonicalization, and final audit verified.");

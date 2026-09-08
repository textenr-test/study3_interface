import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../apps-script/Code.gs", import.meta.url), "utf8");
const context = {
  console, Set, Map, Date, JSON, Number, String, Object, Boolean, Math, RegExp, Array,
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: (key) => key === "STUDY_VERSION" ? "2026-09-08-study3-v2" : "" })
  }
};
vm.runInNewContext(source, context, { filename: "Code.gs" });

const identity = { participantId: "P001", studyId: "STUDY01", sessionId: "S001" };
const allocationId = "n35-study3-carryover-v2-slot-04";
const participantRow = {
  _rowNumber: 2,
  participant_id: identity.participantId,
  study_id: identity.studyId,
  session_id: identity.sessionId,
  participant_slot: 4,
  allocation_id: allocationId,
  assignment_version: "n35-study3-carryover-v2",
  status: "in_progress",
  completed_trials: 49,
  attention_checks_passed: 1,
  study_version: "2026-09-08-study3-v2"
};
const sheets = new Map();
const writes = [];
let participantUpdates = 0;
let lockReleases = 0;

context.LockService = {
  getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => { lockReleases += 1; } })
};
context.getSpreadsheet_ = () => ({});
context.getOrCreateSheet_ = (_spreadsheet, name) => {
  if (!sheets.has(name)) sheets.set(name, { name, getLastRow: () => 1 });
  return sheets.get(name);
};
context.ensureHeaders_ = () => {};
context.readTable_ = (sheet) => ({ rows: sheet.name === "Participants" ? [participantRow] : [] });
context.identityEventIds_ = () => new Set();
context.appendObjectRows_ = (sheet, headers, objects) => {
  if (objects?.length) writes.push({ sheet: sheet.name, headers: Array.from(headers), objects });
};
context.updateParticipantFields_ = (_sheet, rowNumber, fields) => {
  participantUpdates += 1;
  assert.equal(rowNumber, 2);
  Object.assign(participantRow, fields);
};
context.rememberRecordConfirmation_ = () => {};

function trialPayload(globalTrialIndex, eventId) {
  const setId = Math.floor((globalTrialIndex - 1) / 38) + 1;
  const setTrialIndex = ((globalTrialIndex - 1) % 38) + 1;
  return {
    kind: "trial",
    studyVersion: "2026-09-08-study3-v2",
    confirmationMode: "per_record",
    requestId: eventId,
    participant: {
      participantId: identity.participantId,
      studyId: identity.studyId,
      sessionId: identity.sessionId,
      slot: 4,
      allocationId,
      assignmentVersion: "n35-study3-carryover-v2"
    },
    participantSummary: {
      status: "in_progress",
      lastSeenAt: "2026-08-26T00:00:00.000Z",
      completedTrials: globalTrialIndex,
      attentionChecksPassed: 1
    },
    resumeState: { version: "2026-09-08-study3-v2", status: "in_progress", trialCursor: globalTrialIndex },
    record: {
      eventId,
      participantSlot: 4,
      allocationId,
      setId,
      setTrialIndex,
      globalTrialIndex,
      documentId: globalTrialIndex === 50 ? "P19_DOC_B" : "P18_DOC_A",
      conditionId: "D3_derived",
      enrichedFile: "D3_derived.html",
      degreeValue: 4,
      baselineSide: "left",
      enrichedSide: "right",
      documentExposureNumber: setId,
      randomizationSeed: `text-enrichment-reader-study3-n35-v2:slot:4:set:${setId}:carryover-balanced-v2`,
      fanoBlockId: "A",
      setPermutationId: "123",
      assignedConditionTriple: ["D1_derived", "D3_derived", "M_model_optimal"],
      withinDocumentVisualDuplicate: false,
      rating: 2,
      spatialRating: -2,
      responseTime: 840,
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
      respondedAt: "2026-08-26T00:00:00.000Z"
    }
  };
}

const batch = {
  kind: "batch",
  batchId: "batch_0123456789abcdef",
  collectorVersion: "2026-09-08-study3-v2",
  studyVersion: "2026-09-08-study3-v2",
  participant: {
    participantId: identity.participantId,
    studyId: identity.studyId,
    sessionId: identity.sessionId
  },
  items: [
    trialPayload(50, "trial_1111111111111111"),
    trialPayload(51, "trial_2222222222222222")
  ]
};

const result = context.storePayloadBatch_(batch);
assert.equal(result.ok, true);
assert.equal(result.acceptedItems, 2);
assert.equal(writes.filter((write) => write.sheet === "Trials").length, 1);
assert.equal(writes.find((write) => write.sheet === "Trials").objects.length, 2);
assert.equal(writes.filter((write) => write.sheet === "TrialJSON").length, 1);
assert.equal(writes.find((write) => write.sheet === "TrialJSON").objects.length, 2);
assert.equal(participantUpdates, 1);
assert.equal(participantRow.completed_trials, 51);
assert.equal(lockReleases, 1);

assert.throws(() => context.storePayloadBatch_({ ...batch, collectorVersion: "old" }), /Collector release mismatch/);
assert.throws(() => context.storePayloadBatch_({ ...batch, items: Array(9).fill(batch.items[0]) }), /Invalid batch size/);

console.log("Collector batch writes two trials/JSON records in bulk and updates Participants once.");

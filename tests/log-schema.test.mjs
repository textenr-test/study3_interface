import assert from "node:assert/strict";
import fs from "node:fs";
import { TRIAL_LOG_HEADERS, TRIAL_LOG_SCHEMA_VERSION } from "../log-schema.js";

const csv = fs.readFileSync(new URL("../logs/final-trial-log-template.csv", import.meta.url), "utf8");
const json = JSON.parse(fs.readFileSync(new URL("../logs/final-trial-log-template.json", import.meta.url), "utf8"));
const collector = fs.readFileSync(new URL("../apps-script/Code.gs", import.meta.url), "utf8");
const requiredNotionFields = [
  "participant_id",
  "participant_slot",
  "set_id",
  "set_trial_index",
  "global_trial_index",
  "document_id",
  "condition_id",
  "enriched_file",
  "degree_value",
  "baseline_side",
  "document_exposure_number",
  "randomization_seed",
  "rating",
  "response_time"
];

assert.equal(csv, TRIAL_LOG_HEADERS.join(",") + "\n");
assert.equal(json.schema_version, TRIAL_LOG_SCHEMA_VERSION);
assert.equal(json.study_version, "2026-09-07-study3-v1");
assert.deepEqual(json.columns.map((column) => column.name), TRIAL_LOG_HEADERS);
assert.deepEqual(json.records, []);
requiredNotionFields.forEach((field) => assert.ok(TRIAL_LOG_HEADERS.includes(field), `Missing ${field}`));
assert.match(collector, /TrialJSON/);
assert.match(collector, /function exportStudyLogs\(/);
assert.match(collector, /action === "checkpoint"/);
assert.match(collector, /action === "confirm_record"/);
assert.doesNotMatch(collector, /if \(payload\.kind === "final"\) \{\s+try \{\s+exportStudyLogs\(\)/);
assert.match(collector, /rowRange\.setValues\(\[values\]\)/);

console.log("CSV/JSON trial-log templates and collector pipeline schema verified.");


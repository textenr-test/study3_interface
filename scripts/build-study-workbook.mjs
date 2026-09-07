import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { TRIAL_LOG_HEADERS } from "../log-schema.js";

const outputDir = process.argv[2];
if (!outputDir) throw new Error("Provide an output directory.");
await fs.mkdir(outputDir, { recursive: true });

const participantHeaders = [
  "participant_id", "session_id", "study_id", "participant_slot", "allocation_id",
  "assignment_version", "status", "consented_at", "started_at", "completed_at", "last_seen_at",
  "completed_trials", "attention_checks_passed", "eligibility_json", "color_test_json",
  "comprehension_json", "device_json", "state_json", "final_event_id", "study_version"
];
const trialHeaders = [...TRIAL_LOG_HEADERS];
const trialJsonHeaders = [
  "event_id", "participant_id", "session_id", "study_id", "global_trial_index", "record_json",
  "received_at", "study_version"
];
const eventHeaders = [
  "event_id", "participant_id", "session_id", "study_id", "participant_slot", "event_type",
  "event_timestamp", "completed_trials", "detail_json", "study_version"
];
const readmeRows = [
  ["Text Enrichment Reader Study — Study 3 Data Dictionary", "Value"],
  ["Purpose", "Raw pseudonymous study records. Participants, analyzed trial responses, and lifecycle/quality events are separated by tab."],
  ["Expected final trials", 4788],
  ["Expected unique document-condition pairs", 266],
  ["Expected ratings per pair", 18],
  ["Rating direction", "rating: −3 = enriched much less preferred; 0 = no difference; +3 = enriched much more preferred."],
  ["Participant identifiers", "Prolific participant, study, and session IDs only. Do not add direct identifiers."],
  ["Sets and breaks", "Three sets of 38; every row is confirmed, with full server checkpoints after trials 38, 76, and 114."],
  ["Attention checks", "One slot-specific explicit check per set requires +1, +3, then +1. Incorrect attempts are logged; only the instructed response advances."],
  ["Source warnings", "Review P6_DOC_A, P13_DOC_A, and P13_DOC_B before analysis; source pipeline status is warning."],
  ["Collector", "Deploy apps-script/Code.gs as a bound Google Apps Script web app."],
  ["Access", "Keep spreadsheet sharing restricted to authorized research personnel."],
  ["Study version", "2026-09-07-study3-v1"],
  ["Study 3 screening", "No color-vision plate is administered. color_test_json is retained as an intentionally blank compatibility column."]
];

const workbook = Workbook.create();
const readme = workbook.worksheets.add("README");
const participants = workbook.worksheets.add("Participants");
const trials = workbook.worksheets.add("Trials");
const trialJson = workbook.worksheets.add("TrialJSON");
const events = workbook.worksheets.add("Events");

function styleHeader(sheet, rangeAddress) {
  const range = sheet.getRange(rangeAddress);
  range.format = {
    fill: "#202020",
    font: { bold: true, color: "#FFFFFF", size: 10 },
    wrapText: true,
    verticalAlignment: "center",
    horizontalAlignment: "left",
    borders: { preset: "outside", style: "thin", color: "#202020" }
  };
  range.format.rowHeightPx = 44;
  sheet.freezePanes.freezeRows(1);
  sheet.showGridLines = false;
}

readme.getRange("A1:B14").values = readmeRows;
styleHeader(readme, "A1:B1");
readme.getRange("A2:A14").format.font = { bold: true, color: "#252525" };
readme.getRange("A2:B14").format = {
  verticalAlignment: "top",
  wrapText: true,
  borders: {
    insideHorizontal: { style: "thin", color: "#E1E1E1" },
    bottom: { style: "thin", color: "#E1E1E1" }
  }
};
readme.getRange("A1:A14").format.columnWidthPx = 245;
readme.getRange("B1:B14").format.columnWidthPx = 680;
readme.getRange("A2:B14").format.rowHeightPx = 42;

participants.getRangeByIndexes(0, 0, 1, participantHeaders.length).values = [participantHeaders];
styleHeader(participants, "A1:T1");
participants.getRange("A1:T1").format.columnWidthPx = 145;
participants.getRange("N1:R1").format.columnWidthPx = 230;

trials.getRangeByIndexes(0, 0, 1, trialHeaders.length).values = [trialHeaders];
styleHeader(trials, "A1:AP1");
trials.getRange("A1:AP1").format.columnWidthPx = 138;
trials.getRange("N1:N1").format.columnWidthPx = 155;
trials.getRange("AM1:AM1").format.columnWidthPx = 240;

trialJson.getRangeByIndexes(0, 0, 1, trialJsonHeaders.length).values = [trialJsonHeaders];
styleHeader(trialJson, "A1:H1");
trialJson.getRange("A1:H1").format.columnWidthPx = 155;
trialJson.getRange("F1:F1").format.columnWidthPx = 420;

events.getRangeByIndexes(0, 0, 1, eventHeaders.length).values = [eventHeaders];
styleHeader(events, "A1:J1");
events.getRange("A1:J1").format.columnWidthPx = 155;
events.getRange("I1:I1").format.columnWidthPx = 320;

const inspect = await workbook.inspect({
  kind: "sheet,table",
  include: "id,name,values",
  tableMaxRows: 12,
  tableMaxCols: 12,
  maxChars: 8000
});
console.log(inspect.ndjson);

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "formula error scan"
});
console.log(errors.ndjson);

for (const [sheetName, range] of [
  ["README", "A1:B14"],
  ["Participants", "A1:T1"],
  ["Trials", "A1:AP1"],
  ["TrialJSON", "A1:H1"],
  ["Events", "A1:J1"]
]) {
  const preview = await workbook.render({ sheetName, range, scale: 1, format: "png" });
  await fs.writeFile(
    path.join(outputDir, sheetName.toLowerCase() + ".png"),
    new Uint8Array(await preview.arrayBuffer())
  );
}

const output = await SpreadsheetFile.exportXlsx(workbook);
const outputPath = path.join(outputDir, "text-enrichment-reader-study3-data.xlsx");
await output.save(outputPath);
console.log(JSON.stringify({ outputPath }));

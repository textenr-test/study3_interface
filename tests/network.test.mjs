import assert from "node:assert/strict";
import { buildUploadBatch, collectorHealthProblems, postFormWithTimeout } from "../network.js";

const expected = {
  service: "text-enrichment-reader-study3",
  collectorVersion: "2026-09-07-study3-v1",
  studyVersion: "2026-09-07-study3-v1",
  assignmentVersion: "n42-study3-fano-v1",
  schemaVersion: "text-enrichment-trial-log-v3"
};
const health = { ok: true, ...expected };
assert.deepEqual(collectorHealthProblems(health, expected), []);
assert.match(collectorHealthProblems({ ...health, collectorVersion: "old" }, expected).join(" "), /release mismatch/i);
assert.match(collectorHealthProblems({ ok: true, service: expected.service }, expected).join(" "), /version mismatch/i);

const items = [
  { id: "trial_a", payload: { kind: "trial", requestId: "trial_a" } },
  { id: "event_b", payload: { kind: "event", requestId: "event_b" } }
];
const batch = buildUploadBatch(items, {
  batchId: "batch_ab",
  collectorVersion: expected.collectorVersion,
  studyVersion: expected.studyVersion,
  participant: { participantId: "P1", studyId: "STUDY1", sessionId: "S1" }
});
assert.equal(batch.kind, "batch");
assert.equal(batch.items.length, 2);
assert.equal(batch.items[0].requestId, "trial_a");

let postedOptions;
await postFormWithTimeout(async (_endpoint, options) => {
  postedOptions = options;
  return { type: "opaque" };
}, "https://example.test/exec", batch, 100);
assert.equal(postedOptions.method, "POST");
assert.ok(postedOptions.signal instanceof AbortSignal);
assert.deepEqual(JSON.parse(postedOptions.body.get("payload")), batch);

await assert.rejects(
  postFormWithTimeout((_endpoint, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
  }), "https://example.test/exec", batch, 5),
  /timed out after 5 ms/
);

console.log("Collector health validation, batching, and POST timeout verified.");


import fs from "node:fs";
import vm from "node:vm";

const configSource = fs.readFileSync(new URL("../study-config.js", import.meta.url), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(configSource, sandbox, { filename: "study-config.js" });

const config = sandbox.window.STUDY_CONFIG;
if (!config) throw new Error("study-config.js did not define window.STUDY_CONFIG.");

const endpoint = String(config.dataEndpoint || "");
if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(endpoint)) {
  throw new Error("Study 3 dataEndpoint must be a deployed Apps Script /exec URL.");
}

const healthUrl = new URL(endpoint);
healthUrl.searchParams.set("action", "health");

const response = await fetch(healthUrl, {
  headers: { accept: "application/json" },
  redirect: "follow",
  signal: AbortSignal.timeout(20000)
});
if (!response.ok) throw new Error(`Collector health request failed with HTTP ${response.status}.`);

const responseText = await response.text();
let health;
try {
  health = JSON.parse(responseText);
} catch {
  throw new Error(`Collector health response was not JSON: ${responseText.slice(0, 200)}`);
}

const expected = {
  ok: true,
  service: config.collector.service,
  collectorVersion: config.collector.version,
  studyVersion: config.version,
  assignmentVersion: config.assignmentVersion,
  schemaVersion: config.collector.schemaVersion
};

for (const [field, value] of Object.entries(expected)) {
  if (health[field] !== value) {
    throw new Error(`Collector health mismatch for ${field}: expected ${value}, received ${health[field]}.`);
  }
}

console.log(
  `Live collector verified: ${health.service} ${health.collectorVersion} ` +
  `(${health.assignmentVersion}; ${health.schemaVersion}).`
);

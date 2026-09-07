import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stimuliRoot = path.join(root, "stimuli");
const conditionFiles = [
  "D0_plain.html",
  "D1_derived.html",
  "D2_derived.html",
  "W_writer_optimal.html",
  "D3_derived.html",
  "D4_derived.html",
  "D5_maximal.html",
  "M_model_optimal.html"
];

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizedVisualHtml(value) {
  return value
    .replace(/(<meta\s+name=["']stimulus-derivation["']\s+content=["'])[^"']*(["']\s*\/?>)/gi, "$1condition=normalized$2")
    .replace(/\sdata-condition=["'][^"']*["']/gi, " data-condition=\"normalized\"")
    .replace(/\r\n/g, "\n")
    .trim();
}

function factorIds(value) {
  const ids = new Set();
  for (const match of value.matchAll(/data-factor-ids=["']([^"']+)["']/g)) {
    match[1].split(",").map((id) => id.trim()).filter(Boolean).forEach((id) => ids.add(id));
  }
  return ids;
}

const filenames = (await fs.readdir(stimuliRoot))
  .filter((name) => /^P\d+_DOC_[AB]\.json$/.test(name))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
if (filenames.length !== 38) throw new Error(`Expected 38 packaged documents; found ${filenames.length}.`);

const index = { generated_at: new Date().toISOString(), document_count: 38, condition_count: 8, documents: [] };
const equivalenceCounts = {};

for (const filename of filenames) {
  const filePath = path.join(stimuliRoot, filename);
  const payload = JSON.parse(await fs.readFile(filePath, "utf8"));
  for (const conditionFile of conditionFiles) {
    if (typeof payload.html?.[conditionFile] !== "string") throw new Error(`${filename} lacks ${conditionFile}.`);
  }

  payload.source_html_sha256 ||= {};
  payload.visual_html_sha256 = {};
  for (const conditionFile of conditionFiles) {
    const conditionId = conditionFile.replace(/\.html$/, "");
    const html = payload.html[conditionFile];
    const actual = sha256(html);
    const expected = payload.source_html_sha256[conditionId];
    if (conditionId !== "M_model_optimal" && expected && expected !== actual && expected !== sha256(html.replace(/\n$/, ""))) {
      throw new Error(`${filename}/${conditionFile} differs from the Drive manifest hash.`);
    }
    payload.source_html_sha256[conditionId] = actual;
    payload.visual_html_sha256[conditionId] = sha256(normalizedVisualHtml(html));
  }

  const modelHtml = payload.html["M_model_optimal.html"];
  const modelFactorIds = factorIds(modelHtml);
  const declaredCount = Number(payload.condition_meta?.M_model_optimal?.retained_factor_count);
  if (modelFactorIds.size !== declaredCount) {
    throw new Error(`${filename} M factor count ${modelFactorIds.size} != declared ${declaredCount}.`);
  }
  const modelVisualHash = payload.visual_html_sha256.M_model_optimal;
  const equivalentConditionId = Object.entries(payload.visual_html_sha256)
    .find(([conditionId, hash]) => conditionId !== "M_model_optimal" && hash === modelVisualHash)?.[0] || null;
  const declaredEquivalent = payload.condition_meta.M_model_optimal.equivalent_condition_id || null;
  if (declaredEquivalent && equivalentConditionId !== declaredEquivalent) {
    throw new Error(`${filename} M equivalence mismatch: metadata=${declaredEquivalent}, visual=${equivalentConditionId}.`);
  }
  payload.condition_meta.M_model_optimal.stimulus_sha256 = payload.source_html_sha256.M_model_optimal;
  payload.condition_meta.M_model_optimal.visual_sha256 = modelVisualHash;
  payload.condition_meta.M_model_optimal.factor_ids_sha256 = sha256([...modelFactorIds].sort().join("\n"));
  payload.condition_meta.M_model_optimal.equivalent_condition_id = equivalentConditionId;
  payload.condition_meta.M_model_optimal.is_novel_prefix = !equivalentConditionId;
  const equivalenceKey = equivalentConditionId || "novel_prefix";
  equivalenceCounts[equivalenceKey] = (equivalenceCounts[equivalenceKey] || 0) + 1;

  await fs.writeFile(filePath, `${JSON.stringify(payload)}\n`);
  index.documents.push({
    doc_id: payload.doc_id,
    file: `stimuli/${filename}`,
    source_document_id: payload.source_document_id,
    viewport_width: payload.viewport_width,
    viewport_height: payload.viewport_height,
    validation_status: payload.validation_status,
    source_html_sha256: payload.source_html_sha256,
    visual_html_sha256: payload.visual_html_sha256,
    condition_meta: payload.condition_meta
  });
}

const expectedEquivalence = {
  D2_derived: 1,
  D3_derived: 3,
  D4_derived: 11,
  D5_maximal: 12,
  novel_prefix: 11
};
if (Object.keys(expectedEquivalence).some((key) => equivalenceCounts[key] !== expectedEquivalence[key])
    || Object.keys(equivalenceCounts).some((key) => !(key in expectedEquivalence))) {
  throw new Error(`Unexpected model-optimal identity counts: ${JSON.stringify(equivalenceCounts)}.`);
}
index.model_optimal_equivalence_counts = equivalenceCounts;
index.source_inventory = "Google Drive/CHI Text Enrichment/(for CHI) final output";
await fs.writeFile(path.join(stimuliRoot, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
console.log(JSON.stringify({ documents: filenames.length, conditions: filenames.length * conditionFiles.length, equivalenceCounts }, null, 2));

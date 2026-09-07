import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const fonts = fs.readFileSync(new URL("../assets/fonts/local-fonts.css", import.meta.url), "utf8");
const stimulus = fs.readFileSync(new URL("../stimuli/P10_DOC_B.json", import.meta.url), "utf8");

for (const family of [
  "Inter", "Noto Sans KR", "Noto Serif KR", "Nanum Barun Gothic",
  "Nanum Gothic", "Nanum Myeongjo", "NanumSquare", "MaruBuri"
]) {
  assert.ok(fonts.includes(family), `Missing configured font family: ${family}`);
}
assert.match(stimulus, /data-reproducible-fonts=\\?"true\\?"/);
assert.match(app, /assets\/fonts\/local-fonts\.css\?v=/);
assert.match(app, /https:\/\/fonts\.googleapis\.com/);
assert.match(app, /https:\/\/fonts\.gstatic\.com/);
assert.match(app, /https:\/\/hangeul\.pstatic\.net/);
assert.match(app, /contentDocument\?\.fonts\?\.ready/);
assert.match(app, /stimulusCache\.delete\(docId\)/);
assert.match(app, /cache: "no-store"/);

console.log("Stimulus font injection, CSP allowlist, readiness wait, and retryable fetch verified.");


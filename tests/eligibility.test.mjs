import assert from "node:assert/strict";
import { containsKoreanLanguage, deviceIsEligible } from "../eligibility.js";

for (const value of ["Korean", "English, Korean", "한국어", "한국말", "Hangul"]) {
  assert.equal(containsKoreanLanguage(value), true, `Expected Korean-language match: ${value}`);
}

for (const value of ["English", "Spanish, French", "None", "Koreanic linguistics"]) {
  assert.equal(containsKoreanLanguage(value), false, `Expected no Korean-language match: ${value}`);
}

const requirements = { minimumWidth: 1024, minimumHeight: 600 };
const desktop = { userAgent: "Mozilla/5.0 Macintosh", innerWidth: 1024, innerHeight: 600, pointerFine: true };
assert.equal(deviceIsEligible(desktop, requirements), true);
assert.equal(deviceIsEligible({ ...desktop, innerWidth: 1023 }, requirements), false);
assert.equal(deviceIsEligible({ ...desktop, innerHeight: 599 }, requirements), false);
assert.equal(deviceIsEligible({ ...desktop, pointerFine: false }, requirements), false);
assert.equal(deviceIsEligible({ ...desktop, userAgent: "Mozilla/5.0 (iPad) Mobile" }, requirements), false);

console.log("Eligibility language and relaxed desktop viewport checks verified.");


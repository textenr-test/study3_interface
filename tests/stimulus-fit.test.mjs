import assert from "node:assert/strict";
import {
  calculateStimulusFit,
  choosePairContentHeight,
  resolveMeasuredHeight
} from "../stimulus-fit.js";

assert.equal(resolveMeasuredHeight(1040.2, 2158), 1041);
assert.equal(resolveMeasuredHeight(undefined, 2158), 2158);
assert.equal(resolveMeasuredHeight(80, 2158), 2158);

const trimmedHeight = choosePairContentHeight({
  leftMeasuredHeight: 1040,
  rightMeasuredHeight: 1120,
  sourceHeight: 2158,
  safetyPadding: 8
});
assert.equal(trimmedHeight, 1128);

const longerThanMetadata = choosePairContentHeight({
  leftMeasuredHeight: 2230,
  rightMeasuredHeight: 2190,
  sourceHeight: 2158,
  safetyPadding: 8
});
assert.equal(longerThanMetadata, 2238, "Measured content must never be clipped to the metadata height");

const fitWithWhitespace = calculateStimulusFit({
  sourceWidth: 900,
  contentHeight: 2158,
  availableWidth: 650,
  availableHeight: 800
});
const fitToContent = calculateStimulusFit({
  sourceWidth: 900,
  contentHeight: trimmedHeight,
  availableWidth: 650,
  availableHeight: 800
});
assert.ok(fitToContent.scale > fitWithWhitespace.scale, "Removing bottom whitespace should enlarge the document");
assert.ok(fitToContent.renderedHeight <= 800);
assert.ok(fitToContent.renderedWidth <= 650);

console.log("Stimulus content-height fitting verified.");


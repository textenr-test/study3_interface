const DEFAULT_MIN_CONTENT_HEIGHT = 180;

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function resolveMeasuredHeight(measuredHeight, sourceHeight, minimumHeight = DEFAULT_MIN_CONTENT_HEIGHT) {
  const fallback = positiveNumber(sourceHeight, 1200);
  const measured = Number(measuredHeight);
  if (!Number.isFinite(measured) || measured < minimumHeight) return fallback;
  return Math.ceil(measured);
}

export function choosePairContentHeight({
  leftMeasuredHeight,
  rightMeasuredHeight,
  sourceHeight,
  safetyPadding = 8
}) {
  const left = resolveMeasuredHeight(leftMeasuredHeight, sourceHeight);
  const right = resolveMeasuredHeight(rightMeasuredHeight, sourceHeight);
  return Math.ceil(Math.max(left, right) + Math.max(0, Number(safetyPadding) || 0));
}

export function calculateStimulusFit({ sourceWidth, contentHeight, availableWidth, availableHeight }) {
  const width = positiveNumber(sourceWidth, 900);
  const height = positiveNumber(contentHeight, 1200);
  const widthLimit = positiveNumber(availableWidth, width);
  const heightLimit = positiveNumber(availableHeight, height);
  const scale = Math.min(1, widthLimit / width, heightLimit / height);

  return {
    scale,
    renderedWidth: width * scale,
    renderedHeight: height * scale
  };
}


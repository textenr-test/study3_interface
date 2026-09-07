export function containsKoreanLanguage(value) {
  return /(^|[^a-z])(korean|hangul)([^a-z]|$)|한국어|한국말|조선말/i.test(String(value));
}

export function deviceIsEligible(info, requirements) {
  const mobileAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(String(info.userAgent || ""));
  return !mobileAgent
    && Number(info.innerWidth) >= Number(requirements.minimumWidth)
    && Number(info.innerHeight) >= Number(requirements.minimumHeight)
    && info.pointerFine === true;
}


import { hashString, loadParticipantAssignment } from "./assignment.js?v=2026-09-07-study3-v1";
import { containsKoreanLanguage, deviceIsEligible } from "./eligibility.js?v=2026-09-07-study3-v1";
import { expectedAttentionResponse } from "./attention.js?v=2026-09-07-study3-v1";
import { resolveEarlyExitRoute } from "./exit-routing.js?v=2026-09-07-study3-v1";
import { buildUploadBatch, collectorHealthProblems, postFormWithTimeout } from "./network.js?v=2026-09-07-study3-v1";
import { calculateStimulusFit, choosePairContentHeight, resolveMeasuredHeight } from "./stimulus-fit.js?v=2026-09-07-study3-v1";
import { finalStateIsComplete, initialStudyAction, nextStudyAction, remainingBreakMs } from "./study-flow.js?v=2026-09-07-study3-v1";

const CONFIG = window.STUDY_CONFIG;
const app = document.getElementById("app");
const siteHeader = document.getElementById("site-header");
const progressWrap = document.getElementById("progress-wrap");
const progress = document.getElementById("progress");
const progressLabel = document.getElementById("progress-label");
const params = new URLSearchParams(window.location.search);
const isPreview = params.get("preview") === "1";
const isFastPreview = isPreview && params.get("fast") === "1";
const timings = {
  fixationMs: isFastPreview ? 80 : CONFIG.timings.fixationMs,
  exposureMs: isFastPreview ? 120 : CONFIG.timings.exposureMs,
  redirectDelayMs: CONFIG.timings.redirectDelayMs
};
const recommendedBreakMs = isFastPreview ? 500 : CONFIG.recommendedBreakMs;

const prolific = {
  participantId: cleanIdentifier(params.get("PROLIFIC_PID")),
  studyId: cleanIdentifier(params.get("STUDY_ID")),
  sessionId: cleanIdentifier(params.get("SESSION_ID"))
};

const storageKey = [
  "te-reader-study",
  CONFIG.version,
  prolific.studyId || "preview-study",
  prolific.participantId || "preview-participant"
].join(":");

let state = createInitialState();
let assignment = null;
let activeFlush = null;
let scheduledFlush = null;
let collectorSupportsBatch = false;
let suppressUnloadSave = false;
const stimulusCache = new Map();

function cleanIdentifier(value) {
  if (!value) return "";
  return /^[A-Za-z0-9_-]{1,80}$/.test(value) ? value : "";
}

function createInitialState() {
  return {
    version: CONFIG.version,
    status: "new",
    participantId: prolific.participantId,
    studyId: prolific.studyId,
    sessionId: prolific.sessionId,
    consentedAt: null,
    startedAt: null,
    completedAt: null,
    slot: null,
    allocationId: null,
    assignmentVersion: null,
    eligibility: null,
    comprehension: { attempts: 0, passed: false },
    earlyExit: null,
    screen: null,
    practiceIndex: 0,
    practiceComplete: false,
    trialCursor: 0,
    attentionChecks: [],
    attentionAttempts: {},
    eventSequence: 0,
    breaks: [],
    checkpointedSets: [],
    postStudy: null,
    events: [],
    pendingUploads: [],
    unconfirmedTrials: []
  };
}

function saveLocal() {
  if (!state.consentedAt && state.status !== "complete") return;
  try {
    const recoveryState = { ...state, events: [] };
    localStorage.setItem(storageKey, JSON.stringify(recoveryState));
  } catch (error) {
    console.warn("Local save failed", error);
  }
}

function loadLocal() {
  try {
    const value = localStorage.getItem(storageKey);
    if (!value) return null;
    const parsed = JSON.parse(value);
    return parsed && parsed.version === CONFIG.version ? parsed : null;
  } catch (error) {
    return null;
  }
}

function resetPreview() {
  if (!isPreview) return;
  suppressUnloadSave = true;
  localStorage.removeItem(storageKey);
  window.location.reload();
}

function setView(html, options = {}) {
  app.innerHTML = html;
  app.className = options.fullBleed ? "full-bleed" : "";
  app.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function setHeader(status, showProgress = false) {
  siteHeader.hidden = !showProgress;
  progressWrap.hidden = !showProgress;
  if (showProgress) {
    progress.max = CONFIG.trialCount;
    progress.value = state.trialCursor;
    progressLabel.textContent = String(state.trialCursor) + " / " + String(CONFIG.trialCount);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function recordEvent(type, detail = {}) {
  state.eventSequence = Number(state.eventSequence || 0) + 1;
  const event = {
    eventId: makeEventId("event", type + ":" + state.eventSequence + ":" + Date.now()),
    participantId: state.participantId,
    sessionId: state.sessionId,
    type,
    timestamp: nowIso(),
    detail
  };
  state.events.push(event);
  if (state.events.length > 120) state.events = state.events.slice(-120);
  saveLocal();
  if (CONFIG.dataEndpoint && !isPreview) queueRemote("event", { event });
  return event;
}

function makeEventId(kind, suffix) {
  const base = [CONFIG.version, state.sessionId || "preview", kind, suffix].join(":");
  const first = hashString(base).toString(16).padStart(8, "0");
  const second = hashString("secondary:" + base).toString(16).padStart(8, "0");
  return kind + "_" + first + second;
}

function collectScreenInfo() {
  const viewport = window.visualViewport;
  return {
    userAgent: navigator.userAgent,
    platform: navigator.userAgentData?.platform || navigator.platform || "",
    language: navigator.language,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    availableWidth: window.screen.availWidth,
    availableHeight: window.screen.availHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    devicePixelRatio: window.devicePixelRatio,
    colorDepth: window.screen.colorDepth,
    visualViewportScale: viewport?.scale || null,
    approximateZoom: window.outerWidth && window.innerWidth ? window.outerWidth / window.innerWidth : null,
    pointerFine: matchMedia("(any-pointer: fine)").matches,
    hoverAvailable: matchMedia("(any-hover: hover)").matches,
    touchPoints: navigator.maxTouchPoints || 0,
    fullscreenSupported: Boolean(document.documentElement.requestFullscreen),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    capturedAt: nowIso()
  };
}

function configProblems() {
  const problems = [];
  if (!CONFIG || CONFIG.docIds.length !== 38 || CONFIG.conditionOrder.length !== 7
    || CONFIG.trialCount !== 114 || CONFIG.setCount !== 3 || CONFIG.trialsPerSet !== 38) {
    problems.push("The study manifest is incomplete.");
  }
  if (!isPreview) {
    if (!prolific.participantId || !prolific.studyId || !prolific.sessionId) {
      problems.push("The Prolific URL parameters are missing.");
    }
    if (!CONFIG.dataEndpoint) problems.push("The data endpoint has not been configured.");
    ["complete", "screenedOut", "incompatibleDevice", "failedComprehension", "noConsent"].forEach((key) => {
      if (!CONFIG.redirects[key]) problems.push("The Prolific " + key + " redirect has not been configured.");
    });
  }
  return problems;
}

function renderConfigurationError(problems) {
  setHeader("Researcher configuration required");
  setView(
    '<section class="card compact-card">' +
      '<h1>This study is not ready to start.</h1>' +
      '<p>Please return to Prolific and message the researcher. No response data has been collected.</p>' +
      '<div class="notice error">' + problems.map(escapeHtml).join("<br>") + "</div>" +
      '<p class="small muted mono">Use ?preview=1&slot=1 for researcher preview.</p>' +
    "</section>"
  );
}

async function init() {
  const problems = configProblems();
  if (problems.length) {
    renderConfigurationError(problems);
    return;
  }

  const saved = loadLocal();
  const initialAction = initialStudyAction(saved);
  if (initialAction === "early_exit") {
    state = Object.assign(createInitialState(), saved);
    renderEarlyExit(saved.earlyExit.reason);
    return;
  }
  if (initialAction === "allocate") {
    state = Object.assign(createInitialState(), saved);
    renderCollectorCheck();
    try {
      await detectCollectorCompatibility(true);
      await allocateParticipantSlot();
    } catch (error) {
      renderCollectorCompatibilityError(error, () => init());
    }
    return;
  }
  if (initialAction === "resume") {
    state = Object.assign(createInitialState(), saved);
    renderResume();
    detectCollectorCompatibility(false).catch(() => {});
    return;
  }
  if (initialAction === "complete") {
    state = Object.assign(createInitialState(), saved);
    renderAlreadyComplete();
    return;
  }
  if (isPreview) {
    renderWelcome();
    return;
  }
  renderCollectorCheck();
  try {
    await detectCollectorCompatibility(true);
    renderWelcome();
  } catch (error) {
    renderCollectorCompatibilityError(error, () => init());
  }
}

function renderCollectorCheck() {
  setHeader("Checking study service");
  setView(
    '<section class="card compact-card" aria-busy="true">' +
      '<h1>Preparing the study…</h1><p class="muted">Checking the secure data service.</p></section>'
  );
}

async function detectCollectorCompatibility(required) {
  if (isPreview) {
    collectorSupportsBatch = false;
    return true;
  }
  try {
    const health = await jsonp(CONFIG.dataEndpoint, {
      action: "health",
      release_version: CONFIG.releaseVersion,
      cache_bust: Date.now()
    }, CONFIG.network.healthCheckTimeoutMs);
    const problems = collectorHealthProblems(health, {
      service: CONFIG.collector.service,
      collectorVersion: CONFIG.collector.version,
      studyVersion: CONFIG.version,
      assignmentVersion: CONFIG.assignmentVersion,
      schemaVersion: CONFIG.collector.schemaVersion
    });
    collectorSupportsBatch = problems.length === 0;
    if (problems.length && required) throw new Error(problems.join(" "));
    return collectorSupportsBatch;
  } catch (error) {
    collectorSupportsBatch = false;
    if (required) throw error;
    console.warn("Collector compatibility check failed; using the legacy upload protocol.", error);
    return false;
  }
}

function renderCollectorCompatibilityError(error, retry) {
  setHeader("Study service unavailable");
  setView(
    '<section class="card compact-card"><h1>This study is temporarily unavailable.</h1>' +
      '<p>The study page and its data service are not running the same release. No response data has been collected. Try again shortly; if this continues, return the submission and message the researcher.</p>' +
      '<div class="notice error">' + escapeHtml(error.message || "The data service could not be verified.") + '</div>' +
      '<div class="actions"><button class="button" id="retry-health">Try again</button></div></section>'
  );
  document.getElementById("retry-health").addEventListener("click", retry);
}

function renderWelcome() {
  setHeader("Study information");
  setView(
    '<section class="card compact-card">' +
      '<h1>Study information</h1>' +
      '<p>You will complete 114 brief visual comparisons in three sets. The study takes about 20–25 minutes.</p>' +
      '<div class="device-requirement" role="note"><strong>Device requirement</strong>' +
        '<span>This study can only be completed on a laptop or desktop computer using a mouse or trackpad. Mobile phones and tablets are not supported.</span></div>' +
      '<h2>Before you agree</h2>' +
      '<ul class="consent-points">' +
        '<li>Participation is voluntary. You may stop at any time by closing this page and returning your submission on Prolific.</li>' +
        '<li>We record your Prolific participant, study, and session IDs.</li>' +
        '<li>We record your responses, response times, and study-quality checks.</li>' +
        '<li>We record display and browser information needed to evaluate timing quality.</li>' +
        '<li>We do not ask for your name, email address, or other direct identifiers.</li>' +
      '</ul>' +
      '<p>Your pseudonymous data will be used for research on online reading and text formatting. ' + escapeHtml(CONFIG.researcherContact) + "</p>" +
      '<hr class="rule">' +
      '<label class="check-row"><input id="consent-check" type="checkbox"><span><strong>I am at least 18 years old, I have read the information above, and I consent to participate.</strong></span></label>' +
      '<div class="actions">' +
        '<button class="button" id="consent-button" disabled>Continue</button>' +
        '<button class="button secondary" id="decline-button">I do not consent</button>' +
      "</div>" +
    "</section>"
  );
  const check = document.getElementById("consent-check");
  const button = document.getElementById("consent-button");
  check.addEventListener("change", () => { button.disabled = !check.checked; });
  button.addEventListener("click", acceptConsent);
  document.getElementById("decline-button").addEventListener("click", declineConsent);
}

function declineConsent() {
  setHeader("No consent");
  setView(
    '<section class="card compact-card">' +
      '<h1>No data was collected.</h1><p>Please return to Prolific. Your place will be reopened for another participant.</p>' +
      '<div class="actions"><button class="button" id="return-button">Return to Prolific</button></div></section>'
  );
  document.getElementById("return-button").addEventListener("click", () => redirectTo(CONFIG.redirects.noConsent));
  window.setTimeout(() => redirectTo(CONFIG.redirects.noConsent), timings.redirectDelayMs);
}

function acceptConsent() {
  state.consentedAt = nowIso();
  state.status = "consented";
  state.screen = collectScreenInfo();
  saveLocal();
  recordEvent("consent_given");
  const deviceEligible = isPreview || deviceIsEligible(state.screen, CONFIG.device);
  recordEvent("device_check", {
    passed: deviceEligible,
    minimumWidth: CONFIG.device.minimumWidth,
    minimumHeight: CONFIG.device.minimumHeight
  });
  if (!deviceEligible) {
    terminateEarly("incompatible_device");
    return;
  }
  renderEligibility();
}

function renderEligibility() {
  setHeader("Eligibility check");
  setView(
    '<section class="card compact-card">' +
      '<h1>Quick eligibility check</h1>' +
      '<p>Please answer the following questions before beginning the task.</p>' +
      '<form id="eligibility-form" class="question-stack">' +
        '<div class="question"><label for="frequency"><strong>How often do you voluntarily read creator-led newsletters, blogs, or similar text-based online publications?</strong></label>' +
          '<select id="frequency" required><option value="">Select one</option><option value="daily">Daily</option><option value="several_weekly">Several times a week</option><option value="weekly">About once a week</option><option value="less_weekly">Less than once a week</option><option value="never">Never</option></select></div>' +
        '<div class="question"><label for="native-language"><strong>What is your native language?</strong></label>' +
          '<input id="native-language" type="text" autocomplete="off" required placeholder="e.g., English"></div>' +
        '<div class="question"><label for="spoken-languages"><strong>What other languages can you use comfortably?</strong></label>' +
          '<input id="spoken-languages" type="text" autocomplete="off" required placeholder="List languages separated by commas, or enter None"></div>' +
        '<div class="question"><fieldset><legend>Do you have normal or corrected-to-normal vision?</legend>' +
          '<label class="radio-row"><input type="radio" name="vision" value="yes" required><span>Yes</span></label>' +
          '<label class="radio-row"><input type="radio" name="vision" value="no"><span>No</span></label></fieldset></div>' +
        '<div class="actions right"><button class="button" type="submit">Continue</button></div>' +
      "</form>" +
    "</section>"
  );
  document.getElementById("eligibility-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.eligibility = {
      readingFrequency: document.getElementById("frequency").value,
      nativeLanguage: document.getElementById("native-language").value.trim(),
      spokenLanguages: document.getElementById("spoken-languages").value.trim(),
      normalOrCorrectedVision: form.get("vision"),
      answeredAt: nowIso()
    };
    saveLocal();
    const eligibleFrequency = ["daily", "several_weekly", "weekly"].includes(state.eligibility.readingFrequency);
    const reportsKorean = containsKoreanLanguage(state.eligibility.nativeLanguage) || containsKoreanLanguage(state.eligibility.spokenLanguages);
    const passed = eligibleFrequency && !reportsKorean && state.eligibility.normalOrCorrectedVision === "yes";
    recordEvent("eligibility_check", {
      passed,
      eligibleFrequency,
      reportsKorean,
      normalOrCorrectedVision: state.eligibility.normalOrCorrectedVision
    });
    if (!passed) {
      terminateEarly("eligibility_criteria");
      return;
    }
    renderInstructions();
  });
}

function renderInstructions(errorMessage = "") {
  setHeader("Task instructions");
  setView(
    '<section class="card wide-card">' +
      '<h1>Instruction &amp; Comprehension Test</h1>' +
      '<p class="lede">For every trial, focus on the cross. Two versions of the same article will then appear side by side for ' +
        escapeHtml(String(CONFIG.timings.exposureMs)) + ' ms.</p>' +
      '<ol class="instruction-flow" aria-label="Trial sequence">' +
        '<li><strong>Focus on the cross</strong><span>750 ms</span></li>' +
        '<li><strong>View both versions</strong><span>1,000 ms</span></li>' +
        '<li><strong>Rate left versus right</strong><span>−3 to +3</span></li>' +
        '<li><strong>Continue</strong><span>Next trial</span></li>' +
      "</ol>" +
      '<div class="task-callout"><strong>Your task</strong><p>Which version would motivate you more to continue reading, based on its visual appearance? Do not try to read every word. There is no objectively correct preference.</p></div>' +
      '<p>Keep this page full screen, keep the tab active, and do not resize the window during a trial. If timing is interrupted, that trial will be repeated automatically.</p>' +
      '<hr class="rule">' +
      '<h2>Comprehension check</h2><p>The instructions remain visible above. You have two chances.</p>' +
      (errorMessage ? '<div class="notice error" role="alert">' + escapeHtml(errorMessage) + "</div>" : "") +
      '<form id="comprehension-form" class="question-stack">' +
        '<div class="question"><fieldset><legend>How long will the two article versions be visible?</legend>' +
          comprehensionOption("duration", "until_answer", "Until I answer") +
          comprehensionOption("duration", "one_second", "About one second") +
          comprehensionOption("duration", "ten_seconds", "About ten seconds") +
        "</fieldset></div>" +
        '<div class="question"><fieldset><legend>What should your rating represent?</legend>' +
          comprehensionOption("judgment", "accuracy", "Which version contains more accurate information") +
          comprehensionOption("judgment", "first_impression", "Which version would motivate me more to continue reading, based on its visual appearance") +
          comprehensionOption("judgment", "memory", "Which version I remember word for word") +
        "</fieldset></div>" +
        '<div class="actions right"><button class="button" type="submit">Check answers</button></div>' +
      "</form>" +
    "</section>"
  );
  document.getElementById("comprehension-form").addEventListener("submit", handleComprehension);
}

function comprehensionOption(name, value, label) {
  return '<label class="radio-row"><input type="radio" name="' + name + '" value="' + value + '" required><span>' +
    escapeHtml(label) + "</span></label>";
}

async function handleComprehension(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  state.comprehension.attempts += 1;
  state.comprehension.lastResponses = {
    duration: form.get("duration"),
    judgment: form.get("judgment")
  };
  state.comprehension.passed = form.get("duration") === "one_second" && form.get("judgment") === "first_impression";
  state.comprehension.answeredAt = nowIso();
  saveLocal();
  recordEvent("comprehension_attempt", {
    attempt: state.comprehension.attempts,
    passed: state.comprehension.passed
  });
  if (state.comprehension.passed) {
    await allocateParticipantSlot();
    return;
  }
  if (state.comprehension.attempts >= 2) {
    terminateEarly("failed_comprehension_twice");
    return;
  }
  renderInstructions("One or more answers were incorrect. Please re-read the instructions and try once more.");
}

async function allocateParticipantSlot() {
  setHeader("Assigning study materials");
  setView(
    '<section class="card compact-card" aria-busy="true">' +
      '<h1>Preparing your study set…</h1><p class="muted">Do not refresh this page.</p></section>'
  );
  try {
    let allocation;
    if (isPreview) {
      const requested = Number(params.get("slot") || "1");
      allocation = { ok: true, slot: Math.min(42, Math.max(1, Number.isInteger(requested) ? requested : 1)), existing: false };
    } else {
      allocation = await jsonp(CONFIG.dataEndpoint, {
        action: "reserve",
        participant_id: state.participantId,
        study_id: state.studyId,
        session_id: state.sessionId,
        study_version: CONFIG.version
      }, CONFIG.network.dataRequestTimeoutMs);
    }
    if (!allocation?.ok || !allocation.slot) {
      throw new Error(allocation?.error || "No study slot is available.");
    }
    state.slot = Number(allocation.slot);
    assignment = await loadCurrentAssignment(state.slot);
    if (allocation.allocationId && allocation.allocationId !== assignment.allocationId) {
      throw new Error("The server allocation does not match the pre-generated slot file.");
    }
    if (allocation.assignmentVersion && allocation.assignmentVersion !== assignment.assignmentVersion) {
      throw new Error("The server and browser assignment versions do not match.");
    }
    state.allocationId = assignment.allocationId;
    state.assignmentVersion = assignment.assignmentVersion;
    state.startedAt = state.startedAt || nowIso();
    state.status = "eligible";

    const backendState = parseBackendState(allocation.state);
    if (backendState && Number(backendState.trialCursor) > state.trialCursor) {
      state = Object.assign(state, backendState, {
        version: CONFIG.version,
        participantId: prolific.participantId,
        studyId: prolific.studyId,
        sessionId: prolific.sessionId,
        slot: Number(allocation.slot),
        allocationId: assignment.allocationId,
        assignmentVersion: assignment.assignmentVersion,
        pendingUploads: state.pendingUploads || [],
        unconfirmedTrials: state.unconfirmedTrials || [],
        events: state.events || []
      });
    }
    saveLocal();
    recordEvent("assignment_loaded", {
      participantSlot: state.slot,
      allocationId: state.allocationId,
      assignmentVersion: state.assignmentVersion,
      allocationSha256: assignment.allocationSha256,
      resumed: Boolean(allocation.existing)
    });
    queueRemote("snapshot", { reason: "eligible" });
    renderPracticeIntro();
  } catch (error) {
    renderBackendError(error);
  }
}

function loadCurrentAssignment(participantSlot) {
  return loadParticipantAssignment({
    participantSlot: Number(participantSlot),
    studyVersion: CONFIG.version,
    assignmentVersion: CONFIG.assignmentVersion
  });
}

function activeFlowConfig() {
  return { ...CONFIG, attentionChecks: assignment?.attentionChecks || CONFIG.attentionChecks || [] };
}

function parseBackendState(value) {
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch (error) {
    return null;
  }
}

function renderBackendError(error) {
  state.status = "upload_error";
  saveLocal();
  setHeader("Connection problem");
  setView(
    '<section class="card compact-card"><h1>We could not reserve your study materials.</h1>' +
      '<p>Your progress on this device is safe. Check your connection and try again. If this continues, return the submission and message the researcher.</p>' +
      '<div class="notice error">' + escapeHtml(error.message || "Unknown connection error") + "</div>" +
      '<div class="actions"><button class="button" id="retry-allocation">Try again</button></div></section>'
  );
  document.getElementById("retry-allocation").addEventListener("click", allocateParticipantSlot);
}

function renderPracticeIntro() {
  setHeader("Practice");
  setView(
    '<section class="card compact-card"><h1>Try two practice trials</h1>' +
      '<p>The practice uses the same timing and response scale as the main study. Practice responses are not included in the main analysis.</p>' +
      '<div class="notice">Please set browser zoom to 100%, maximize the window, and close unrelated tabs or programs that may interrupt the display.</div>' +
      '<div class="actions"><button class="button" id="start-practice">Enter full screen and begin</button></div></section>'
  );
  document.getElementById("start-practice").addEventListener("click", async () => {
    await requestStudyFullscreen();
    state.practiceIndex = state.practiceIndex || 0;
    saveLocal();
    if (state.practiceIndex === 0) recordEvent("practice_started", { practiceTrials: practiceDocs.length });
    runPracticeTrial();
  });
}

async function requestStudyFullscreen() {
  if (document.fullscreenElement || !document.documentElement.requestFullscreen) return;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    recordEvent("fullscreen_entered");
  } catch (error) {
    recordEvent("fullscreen_denied", { message: error.message });
  }
}

const practiceDocs = [
  makePracticeDoc("Small urban gardens", [
    "Small gardens can support pollinators while giving city residents a quiet place to pause.",
    "A mix of herbs, native flowers, and shallow water can attract a surprising variety of insects.",
    "Start with one sunny container, observe what visits, and adjust the planting over time."
  ], ["Small gardens", "pollinators", "Start with one sunny container"]),
  makePracticeDoc("Repair before replacement", [
    "Many household objects fail because one inexpensive component wears out before the rest.",
    "Repair guides and shared tool libraries can make a small fix practical even for beginners.",
    "Checking whether an item can be repaired first may save money and reduce unnecessary waste."
  ], ["one inexpensive component", "shared tool libraries", "save money"])
];

function makePracticeDoc(title, paragraphs, emphasizedPhrases) {
  const baseBody = "<h1>" + escapeHtml(title) + "</h1>" + paragraphs.map((p) => "<p>" + escapeHtml(p) + "</p>").join("");
  let enrichedBody = baseBody;
  emphasizedPhrases.forEach((phrase, index) => {
    const replacement = index === 0
      ? "<strong>" + escapeHtml(phrase) + "</strong>"
      : index === 1
        ? '<span class="marker">' + escapeHtml(phrase) + "</span>"
        : '<span class="underline">' + escapeHtml(phrase) + "</span>";
    enrichedBody = enrichedBody.replace(escapeHtml(phrase), replacement);
  });
  const wrap = (body) => '<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#fafafa;font-family:Arial,sans-serif;color:#191919}.doc{width:800px;margin:24px auto;background:#fff;border:1px solid #ddd;border-radius:8px;padding:52px 58px}h1{font-size:36px;line-height:1.15;margin:0 0 28px}p{font-size:22px;line-height:1.65;margin:0 0 22px}.marker{background:#e6dfae;padding:1px 3px}.underline{text-decoration:underline;text-decoration-thickness:3px;text-underline-offset:4px}</style></head><body><article class="doc">' + body + "</article></body></html>";
  return {
    doc_id: "PRACTICE_" + hashString(title).toString(16),
    viewport_width: 900,
    viewport_height: 950,
    html: { baseline: wrap(baseBody), enriched: wrap(enrichedBody) }
  };
}

function runPracticeTrial() {
  const index = state.practiceIndex;
  if (index >= practiceDocs.length) {
    state.practiceComplete = true;
    state.status = "in_progress";
    saveLocal();
    recordEvent("practice_completed", { practiceTrials: practiceDocs.length });
    renderMainIntro();
    return;
  }
  const baselineLeft = index % 2 === 0;
  const trial = {
    practice: true,
    docId: practiceDocs[index].doc_id,
    baselineSide: baselineLeft ? "left" : "right",
    enrichedSide: baselineLeft ? "right" : "left",
    trialOrder: index
  };
  runStimulusTrial(trial, practiceDocs[index], 1);
}

function renderMainIntro() {
  setHeader("Main study");
  setView(
    '<section class="card compact-card"><h1>Main Study</h1>' +
      '<p>You will complete 114 comparisons in three sets of 38. An optional 60-second break is offered after Set 1 and Set 2, and one clearly labeled attention check appears in each set. Every response is saved automatically.</p>' +
      '<div class="actions"><button class="button" id="begin-main">Begin main study</button></div></section>'
  );
  document.getElementById("begin-main").addEventListener("click", () => {
    state.status = "in_progress";
    saveLocal();
    recordEvent("main_study_started", { trialCount: CONFIG.trialCount, setCount: CONFIG.setCount });
    continueMain();
  });
}

async function fetchStimulus(docId) {
  if (stimulusCache.has(docId)) return stimulusCache.get(docId);
  const request = fetch("./stimuli/" + encodeURIComponent(docId) + ".json?v=" + encodeURIComponent(CONFIG.releaseVersion), { cache: "no-store" })
    .then((response) => {
      if (!response.ok) throw new Error("Could not load " + docId);
      return response.json();
    })
    .catch((error) => {
      stimulusCache.delete(docId);
      throw error;
    });
  stimulusCache.set(docId, request);
  return request;
}

function prefetchNext() {
  const next = assignment?.trials[state.trialCursor + 1];
  if (next) fetchStimulus(next.docId).catch(() => {});
}

async function continueMain() {
  if (!assignment && state.slot) {
    try {
      assignment = await loadCurrentAssignment(state.slot);
    } catch (error) {
      renderAssignmentLoadError(error);
      return;
    }
  }
  setHeader("Main study", true);
  const action = nextStudyAction(state, activeFlowConfig());
  if (action.type === "attention") return renderAttentionCheck(action.afterTrial);
  if (action.type === "break") return prepareSetBreak(action.afterTrial);
  if (action.type === "post_study") return renderPostStudy();

  const trial = assignment.trials[state.trialCursor];
  try {
    const doc = await fetchStimulus(trial.docId);
    prefetchNext();
    runStimulusTrial(trial, doc, 1);
  } catch (error) {
    renderStimulusLoadError(error);
  }
}

function renderAssignmentLoadError(error) {
  setHeader("Allocation problem", true);
  setView(
    '<section class="card compact-card"><h1>Your assigned study set could not be loaded.</h1>' +
      '<p>Your progress is safe. Check the connection and try again.</p>' +
      '<div class="notice error">' + escapeHtml(error.message) + '</div>' +
      '<div class="actions"><button class="button" id="retry-assignment">Try again</button></div></section>'
  );
  document.getElementById("retry-assignment").addEventListener("click", continueMain);
}

async function prepareSetBreak(afterTrial) {
  const setId = afterTrial / CONFIG.trialsPerSet;
  if (state.checkpointedSets.includes(setId)) {
    renderBreak(afterTrial);
    return;
  }
  setHeader("Saving set", true);
  setView(
    '<section class="card compact-card" aria-busy="true"><h1>Saving Set ' + escapeHtml(String(setId)) + '…</h1>' +
      '<p>Keep this page open while all ' + escapeHtml(String(afterTrial)) + ' submitted responses are confirmed.</p></section>'
  );
  try {
    await confirmTrialCheckpoint(afterTrial, CONFIG.network.dataRequestTimeoutMs);
    state.checkpointedSets.push(setId);
    saveLocal();
    renderBreak(afterTrial);
  } catch (error) {
    setHeader("Save interrupted", true);
    setView(
      '<section class="card compact-card"><h1>Set ' + escapeHtml(String(setId)) + ' is not fully saved yet.</h1>' +
        '<p>Check the connection and retry. The next set will remain locked until all responses are confirmed.</p>' +
        '<div class="notice error">' + escapeHtml(error.message) + '</div>' +
        '<div class="actions"><button class="button" id="retry-checkpoint">Retry save</button></div></section>'
    );
    document.getElementById("retry-checkpoint").addEventListener("click", () => prepareSetBreak(afterTrial));
  }
}

function renderStimulusLoadError(error) {
  recordEvent("stimulus_load_error", { message: error.message, trialCursor: state.trialCursor });
  setHeader("Connection problem", true);
  setView(
    '<section class="card compact-card"><h1>A document did not load.</h1>' +
      '<p>Your progress is saved. Check the connection, then try this trial again.</p>' +
      '<div class="notice error">' + escapeHtml(error.message) + "</div>" +
      '<div class="actions"><button class="button" id="retry-trial">Try again</button></div></section>'
  );
  document.getElementById("retry-trial").addEventListener("click", continueMain);
}

async function runStimulusTrial(trial, doc, attempt) {
  const baselineFile = CONFIG.conditionFiles.D0_plain;
  const enrichedFile = trial.practice ? null : CONFIG.conditionFiles[trial.conditionId];
  const baselineHtml = trial.practice ? doc.html.baseline : doc.html[baselineFile];
  const enrichedHtml = trial.practice ? doc.html.enriched : doc.html[enrichedFile];
  const leftHtml = trial.baselineSide === "left" ? baselineHtml : enrichedHtml;
  const rightHtml = trial.baselineSide === "right" ? baselineHtml : enrichedHtml;

  setView(
    '<div class="trial-shell">' +
      '<div class="stimulus-phase trial-phase" id="stimulus-phase" style="visibility:hidden" aria-hidden="true">' +
        stimulusPanel("left") + stimulusPanel("right") +
      "</div>" +
      '<div class="fixation-phase phase-overlay" id="preparation-phase"><p class="muted">Keep your eyes near the center.</p></div>' +
      '<div class="fixation-phase phase-overlay hidden" id="fixation-phase" aria-label="Fixation cross"><div class="fixation-cross">+</div></div>' +
    "</div>",
    { fullBleed: true }
  );

  const stimulusPhase = document.getElementById("stimulus-phase");
  const leftFrame = document.getElementById("frame-left");
  const rightFrame = document.getElementById("frame-right");
  const sourceWidth = doc.viewport_width || 900;
  const sourceHeight = doc.viewport_height || 1200;
  primeStimulusFrame(leftFrame, sourceWidth, sourceHeight);
  primeStimulusFrame(rightFrame, sourceWidth, sourceHeight);
  const preparationStarted = performance.now();
  const invalidation = { hidden: false, resized: false };
  let timingPhase = "preload";
  const visibilityListener = () => {
    if (document.visibilityState !== "visible" && ["fixation", "exposure"].includes(timingPhase)) invalidation.hidden = true;
  };
  const resizeListener = () => {
    if (["fixation", "exposure"].includes(timingPhase)) invalidation.resized = true;
  };
  document.addEventListener("visibilitychange", visibilityListener);
  window.addEventListener("resize", resizeListener);

  try {
    await Promise.all([
      loadFrame(leftFrame, prepareSrcdoc(leftHtml)),
      loadFrame(rightFrame, prepareSrcdoc(rightHtml))
    ]);
    await nextFrame();
    const leftMeasuredHeight = measureFrameContentHeight(leftFrame);
    const rightMeasuredHeight = measureFrameContentHeight(rightFrame);
    const leftContentHeight = resolveMeasuredHeight(leftMeasuredHeight, sourceHeight);
    const rightContentHeight = resolveMeasuredHeight(rightMeasuredHeight, sourceHeight);
    const fittedContentHeight = choosePairContentHeight({
      leftMeasuredHeight,
      rightMeasuredHeight,
      sourceHeight
    });
    const scale = fitStimuli(sourceWidth, fittedContentHeight);
    const preloadMs = performance.now() - preparationStarted;
    document.getElementById("preparation-phase").classList.add("hidden");
    const fixation = document.getElementById("fixation-phase");
    fixation.classList.remove("hidden");
    timingPhase = "fixation";
    await sleep(timings.fixationMs);
    if (invalidation.hidden || invalidation.resized) {
      throw new TrialTimingError("The window changed during fixation.", { ...invalidation, phase: "fixation" });
    }

    fixation.classList.add("hidden");
    stimulusPhase.style.visibility = "visible";
    stimulusPhase.setAttribute("aria-hidden", "false");
    await nextFrame();
    await nextFrame();
    const onset = performance.now();
    timingPhase = "exposure";
    await sleep(timings.exposureMs);
    const offset = performance.now();
    stimulusPhase.style.visibility = "hidden";
    stimulusPhase.setAttribute("aria-hidden", "true");
    timingPhase = "complete";
    const actualExposureMs = offset - onset;
    const metrics = {
      attempt,
      plannedFixationMs: timings.fixationMs,
      plannedExposureMs: timings.exposureMs,
      actualExposureMs,
      preloadMs,
      scale,
      fittedContentHeight,
      leftContentHeight,
      rightContentHeight,
      trimmedBottomWhitespacePx: Math.max(0, sourceHeight - fittedContentHeight),
      invalidation,
      fullscreen: Boolean(document.fullscreenElement),
      screen: collectScreenInfo()
    };
    if (invalidation.hidden || invalidation.resized || actualExposureMs > timings.exposureMs + 120) {
      throw new TrialTimingError("The timed display was interrupted.", metrics);
    }
    renderRating(trial, doc, metrics);
  } catch (error) {
    const detail = error.metrics || { message: error.message, attempt };
    recordEvent("trial_attempt_discarded", {
      docId: trial.docId,
      trialOrder: trial.trialOrder,
      practice: Boolean(trial.practice),
      detail
    });
    renderTrialRetry(trial, doc, attempt, error.message);
  } finally {
    document.removeEventListener("visibilitychange", visibilityListener);
    window.removeEventListener("resize", resizeListener);
  }
}

class TrialTimingError extends Error {
  constructor(message, metrics) {
    super(message);
    this.metrics = metrics;
  }
}

function stimulusPanel(side) {
  return '<div class="stimulus-panel" id="panel-' + side + '"><span class="stimulus-label">' + side.toUpperCase() +
    '</span><div class="stimulus-holder" id="holder-' + side + '"><iframe id="frame-' + side +
    '" title="' + side + ' article version" sandbox="allow-same-origin" tabindex="-1"></iframe></div></div>';
}

function prepareSrcdoc(html) {
  const clean = String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<link\b[^>]*data-reproducible-fonts=["'][^"']*["'][^>]*>/gi, "");
  const fontUrl = new URL(
    "./assets/fonts/local-fonts.css?v=" + encodeURIComponent(CONFIG.releaseVersion),
    window.location.href
  ).href;
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\' \'self\' https://fonts.googleapis.com; img-src data:; font-src \'self\' data: https://fonts.gstatic.com https://hangeul.pstatic.net">';
  const fontLink = '<link rel="stylesheet" href="' + escapeHtml(fontUrl) + '" data-reproducible-fonts="true">';
  const additions = policy + fontLink;
  return /<head(?:\s[^>]*)?>/i.test(clean)
    ? clean.replace(/<head(\s[^>]*)?>/i, (match) => match + additions)
    : additions + clean;
}

function loadFrame(frame, srcdoc) {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error("Stimulus rendering timed out.")), 12000);
    frame.addEventListener("load", async () => {
      try {
        await frame.contentDocument?.fonts?.ready;
      } catch (_) {
        // Font readiness is an enhancement; the iframe load event remains the fallback.
      }
      window.clearTimeout(timeout);
      resolve();
    }, { once: true });
    frame.srcdoc = srcdoc;
  });
}

function primeStimulusFrame(frame, width, height) {
  frame.style.width = String(width) + "px";
  frame.style.height = String(height) + "px";
  frame.style.transform = "none";
}

function measureFrameContentHeight(frame) {
  const frameDocument = frame.contentDocument;
  const frameWindow = frame.contentWindow;
  if (!frameDocument?.body || !frameWindow) return null;

  const preferred = Array.from(frameDocument.querySelectorAll(
    ".document-container, .doc, main, article, [role='document']"
  ));
  const candidates = preferred.length ? preferred : Array.from(frameDocument.body.children);
  let contentBottom = 0;

  candidates.forEach((element) => {
    const style = frameWindow.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return;
    const rect = element.getBoundingClientRect();
    if (!Number.isFinite(rect.bottom)) return;
    contentBottom = Math.max(contentBottom, rect.bottom);
  });

  return contentBottom > 0 ? Math.ceil(contentBottom) : null;
}

function fitStimuli(width, height) {
  const panels = ["left", "right"].map((side) => document.getElementById("panel-" + side));
  const availableWidth = Math.min(...panels.map((panel) => panel.clientWidth - 24));
  const availableHeight = Math.min(...panels.map((panel) => panel.clientHeight - 24));
  const fit = calculateStimulusFit({
    sourceWidth: width,
    contentHeight: height,
    availableWidth,
    availableHeight
  });
  ["left", "right"].forEach((side) => {
    const holder = document.getElementById("holder-" + side);
    const frame = document.getElementById("frame-" + side);
    holder.style.width = String(fit.renderedWidth) + "px";
    holder.style.height = String(fit.renderedHeight) + "px";
    frame.style.width = String(width) + "px";
    frame.style.height = String(height) + "px";
    frame.style.transform = "scale(" + String(fit.scale) + ")";
  });
  return fit.scale;
}

function renderTrialRetry(trial, doc, attempt, message) {
  setHeader(trial.practice ? "Practice" : "Main study", !trial.practice);
  setView(
    '<section class="card compact-card"><h1>The timed display was interrupted.</h1>' +
      '<p>This attempt will not be analyzed. Keep the tab active and the window unchanged, then repeat the same trial.</p>' +
      '<div class="notice">' + escapeHtml(message) + "</div>" +
      '<div class="actions"><button class="button" id="repeat-trial">Repeat trial</button></div></section>'
  );
  document.getElementById("repeat-trial").addEventListener("click", () => {
    runStimulusTrial(trial, doc, attempt + 1);
  });
}

function renderRating(trial, doc, metrics) {
  const ratingShownAt = performance.now();
  setView(
    '<div class="trial-shell"><div class="rating-phase"><section class="card rating-card">' +
      '<h1>Which version would motivate you more to continue reading, based on its visual appearance?</h1>' +
      '<p class="muted">Choose a direction and strength. Select 0 if there was no difference.</p>' +
      '<div class="rating-scale" role="group" aria-label="Preference from left to right">' +
        [-3, -2, -1, 0, 1, 2, 3].map((value) => '<button class="rating-option" data-value="' + value + '" aria-label="' +
          spatialLabel(value) + '">' + (value > 0 ? "+" : "") + value + "</button>").join("") +
      "</div>" +
      '<div class="rating-anchors"><span>LEFT much more</span><span>No difference</span><span>RIGHT much more</span></div>' +
      '<div class="actions center"><button class="button" id="submit-rating" disabled>Submit rating</button></div>' +
    "</section></div></div>",
    { fullBleed: true }
  );
  let selected = null;
  document.querySelectorAll(".rating-option").forEach((button) => {
    button.addEventListener("click", () => {
      selected = Number(button.dataset.value);
      document.querySelectorAll(".rating-option").forEach((item) => item.classList.toggle("selected", item === button));
      document.getElementById("submit-rating").disabled = false;
    });
  });
  document.getElementById("submit-rating").addEventListener("click", () => {
    const responseTimeMs = performance.now() - ratingShownAt;
    if (trial.practice) {
      recordEvent("practice_response", { practiceIndex: state.practiceIndex, spatialRating: selected, responseTimeMs });
      state.practiceIndex += 1;
      saveLocal();
      runPracticeTrial();
      return;
    }
    const normalizedRating = trial.enrichedSide === "right" ? selected : -selected;
    const conditionMeta = doc.condition_meta?.[trial.conditionId] || {};
    const record = {
      eventId: makeEventId("trial", trial.allocationId + ":" + trial.globalTrialIndex),
      participantId: state.participantId,
      studyId: state.studyId,
      sessionId: state.sessionId,
      participantSlot: state.slot,
      allocationId: trial.allocationId,
      setId: trial.setId,
      setTrialIndex: trial.setTrialIndex,
      globalTrialIndex: trial.globalTrialIndex,
      documentId: trial.docId,
      sourceDocumentId: doc.source_document_id || null,
      validationStatus: doc.validation_status || null,
      conditionId: trial.conditionId,
      enrichedFile: trial.enrichedFile,
      degreeValue: trial.degreeValue,
      visualCoverage: conditionMeta.ink_mass_ratio ?? null,
      targetCoverage: conditionMeta.target_ink_mass_ratio ?? null,
      retainedFactorCount: conditionMeta.retained_factor_count ?? null,
      stimulusSha256: conditionMeta.stimulus_sha256 ?? doc.source_html_sha256?.[trial.conditionId] ?? null,
      visualSha256: conditionMeta.visual_sha256 ?? doc.visual_html_sha256?.[trial.conditionId] ?? null,
      factorIdsSha256: conditionMeta.factor_ids_sha256 ?? null,
      modelOptimalEquivalentConditionId: trial.modelOptimalEquivalentConditionId ?? null,
      modelOptimalIsNovel: conditionMeta.is_novel_prefix ?? null,
      fanoBlockId: trial.fanoBlockId,
      setPermutationId: trial.setPermutationId,
      assignedConditionTriple: trial.assignedConditionTriple,
      withinDocumentVisualDuplicate: Boolean(trial.withinDocumentVisualDuplicate),
      baselineSide: trial.baselineSide,
      enrichedSide: trial.enrichedSide,
      documentExposureNumber: trial.documentExposureNumber,
      randomizationSeed: trial.randomizationSeed,
      spatialRating: selected,
      rating: normalizedRating,
      responseTime: responseTimeMs,
      plannedFixationMs: metrics.plannedFixationMs,
      plannedExposureMs: metrics.plannedExposureMs,
      actualExposureMs: metrics.actualExposureMs,
      preloadMs: metrics.preloadMs,
      attemptCount: metrics.attempt,
      stimulusScale: metrics.scale,
      sourceViewportWidth: doc.viewport_width,
      sourceViewportHeight: doc.viewport_height,
      fittedContentHeight: metrics.fittedContentHeight,
      leftContentHeight: metrics.leftContentHeight,
      rightContentHeight: metrics.rightContentHeight,
      trimmedBottomWhitespacePx: metrics.trimmedBottomWhitespacePx,
      fullscreen: metrics.fullscreen,
      displayInfo: metrics.screen,
      respondedAt: nowIso()
    };
    state.trialCursor += 1;
    state.status = "in_progress";
    queueRemote("trial", { record });
    saveLocal();
    continueMain();
  });
}

function spatialLabel(value) {
  if (value === 0) return "No difference";
  const direction = value < 0 ? "left" : "right";
  const strength = Math.abs(value) === 3 ? "much more" : Math.abs(value) === 2 ? "more" : "slightly more";
  return direction + " version " + strength;
}

function renderAttentionCheck(afterTrial) {
  const instructedResponse = expectedAttentionResponse(afterTrial, activeFlowConfig().attentionChecks);
  const displayResponse = (instructedResponse > 0 ? "+" : "") + String(instructedResponse);
  setHeader("Attention check", true);
  setView(
    '<section class="card compact-card"><h1>Please follow the instruction below.</h1>' +
      '<div class="attention-box"><strong>This is an attention check. To show that you are reading carefully, select “' + displayResponse + '” below.</strong></div>' +
      '<div class="rating-scale" role="group" aria-label="Attention-check response">' +
        [-3, -2, -1, 0, 1, 2, 3].map((value) => '<button class="rating-option" data-value="' + value + '">' +
          (value > 0 ? "+" : "") + value + "</button>").join("") +
      "</div>" +
      '<div class="rating-anchors"><span>LEFT much more</span><span>No difference</span><span>RIGHT much more</span></div>' +
      '<div class="notice error hidden" id="attention-error" role="alert"></div>' +
      '<div class="actions right"><button class="button" id="submit-attention" disabled>Submit</button></div></section>'
  );
  let selected = null;
  let attempt = Number(state.attentionAttempts[afterTrial] || 0);
  document.querySelectorAll(".rating-option").forEach((button) => {
    button.addEventListener("click", () => {
      selected = Number(button.dataset.value);
      document.querySelectorAll(".rating-option").forEach((item) => item.classList.toggle("selected", item === button));
      document.getElementById("submit-attention").disabled = false;
    });
  });
  document.getElementById("submit-attention").addEventListener("click", () => {
    attempt += 1;
    state.attentionAttempts[afterTrial] = attempt;
    saveLocal();
    const passed = selected === instructedResponse;
    const result = {
      eventId: makeEventId("attention", String(afterTrial) + ":" + String(attempt)),
      afterTrial,
      setId: Math.floor((afterTrial - 1) / CONFIG.trialsPerSet) + 1,
      attempt,
      instructedResponse,
      response: selected,
      passed,
      answeredAt: nowIso()
    };
    queueRemote("event", { event: Object.assign({ type: "attention_check" }, result) });
    if (!passed) {
      const error = document.getElementById("attention-error");
      error.textContent = "That response was incorrect. Please select " + displayResponse + " as instructed.";
      error.classList.remove("hidden");
      selected = null;
      document.querySelectorAll(".rating-option").forEach((item) => item.classList.remove("selected"));
      document.getElementById("submit-attention").disabled = true;
      return;
    }
    state.attentionChecks.push(result);
    saveLocal();
    continueMain();
  });
}

function renderBreak(afterTrial) {
  const setId = afterTrial / CONFIG.trialsPerSet;
  let breakRecord = state.breaks.find((item) => item.afterTrial === afterTrial);
  if (!breakRecord) {
    breakRecord = { afterTrial, setId, startedAt: nowIso(), completedAt: null };
    state.breaks.push(breakRecord);
    saveLocal();
    recordEvent("break_started", { setId, afterTrial, recommendedBreakMs: CONFIG.recommendedBreakMs });
  }
  setHeader("Break", true);
  setView(
    '<section class="card compact-card"><h1>Optional break</h1>' +
      '<p>You completed Set ' + escapeHtml(String(setId)) + ' of 3 (' + escapeHtml(String(afterTrial)) + ' of 114 comparisons). We recommend resting your eyes for 60 seconds, but you may continue whenever you are ready.</p>' +
      '<p class="break-countdown" id="break-countdown" aria-live="polite"></p>' +
      '<div class="actions"><button class="button" id="continue-after-break">Skip break and continue to Set ' + escapeHtml(String(setId + 1)) + '</button></div></section>'
  );
  const button = document.getElementById("continue-after-break");
  const countdown = document.getElementById("break-countdown");
  const started = Date.parse(breakRecord.startedAt);
  let timer = null;
  const update = () => {
    const remaining = remainingBreakMs(breakRecord.startedAt, Date.now(), recommendedBreakMs);
    countdown.textContent = remaining > 0
      ? `Recommended break: ${Math.ceil(remaining / 1000)} seconds remaining.`
      : "The recommended 60-second break is complete.";
    button.textContent = remaining > 0
      ? `Skip break and continue to Set ${setId + 1}`
      : `Continue to Set ${setId + 1}`;
    if (remaining <= 0 && timer) window.clearInterval(timer);
  };
  timer = window.setInterval(update, 250);
  update();
  button.addEventListener("click", () => {
    window.clearInterval(timer);
    const elapsedMs = Math.max(0, Date.now() - started);
    breakRecord.completedAt = nowIso();
    breakRecord.elapsedMs = elapsedMs;
    breakRecord.skipped = elapsedMs < CONFIG.recommendedBreakMs;
    saveLocal();
    recordEvent("break_completed", {
      setId,
      afterTrial,
      elapsedMs,
      recommendedBreakMs: CONFIG.recommendedBreakMs,
      skipped: breakRecord.skipped
    });
    queueRemote("snapshot", { reason: `break-${setId}-completed` });
    continueMain();
  });
}

function renderPostStudy() {
  setHeader("Final questions", true);
  setView(
    '<section class="card compact-card"><h1>Final check</h1>' +
      '<form id="post-form" class="question-stack">' +
        '<div class="question"><fieldset><legend>Did you experience a technical problem that may have affected the timed displays?</legend>' +
          '<label class="radio-row"><input type="radio" name="technical" value="no" required><span>No</span></label>' +
          '<label class="radio-row"><input type="radio" name="technical" value="yes"><span>Yes</span></label></fieldset></div>' +
        '<div class="question"><label for="comment"><strong>Optional comment</strong></label><textarea id="comment" rows="3" maxlength="800" placeholder="Briefly describe any issue or feedback."></textarea></div>' +
        '<div class="actions right"><button class="button" type="submit">Continue to submit</button></div>' +
      "</form></section>"
  );
  document.getElementById("post-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.postStudy = {
      technicalProblem: form.get("technical"),
      comment: document.getElementById("comment").value.trim(),
      answeredAt: nowIso()
    };
    state.status = "ready_to_submit";
    saveLocal();
    renderSubmit();
  });
}

function renderSubmit() {
  setHeader("Ready to submit", true);
  setView(
    '<section class="card compact-card"><h1>You completed the task.</h1>' +
      '<p>You completed ' + escapeHtml(String(state.trialCursor)) + ' comparisons. Select Submit to save the final record and return to Prolific.</p>' +
      '<div class="notice">Keep this page open until the Prolific page appears.</div>' +
      '<div class="actions"><button class="button" id="final-submit">Submit study</button></div></section>'
  );
  document.getElementById("final-submit").addEventListener("click", submitFinal);
}

async function submitFinal() {
  const button = document.getElementById("final-submit") || document.getElementById("retry-final");
  if (!finalStateIsComplete(state, activeFlowConfig())) {
    setView(
      '<section class="card compact-card"><h1>The study record is incomplete.</h1>' +
        '<p>The task cannot be submitted until all trials, attention checks, and both break screens are complete.</p>' +
        '<div class="actions"><button class="button" id="return-to-study">Return to study</button></div></section>'
    );
    document.getElementById("return-to-study").addEventListener("click", continueMain);
    return;
  }
  button.disabled = true;
  button.textContent = "Saving…";
  const outcome = "complete";
  const finalEventId = makeEventId("final", outcome);
  try {
    await confirmTrialCheckpoint(CONFIG.trialCount, CONFIG.network.dataRequestTimeoutMs);
    state.status = outcome;
    state.completedAt = nowIso();
    saveLocal();
    queueRemote("final", {
      finalEventId,
      outcome,
      summary: {
        completedTrials: state.trialCursor,
        attentionChecksPassed: state.attentionChecks.length,
        postStudy: state.postStudy,
        completedAt: state.completedAt
      }
    });
    await flushUploads();
    if (!isPreview) {
      const confirmation = await jsonp(CONFIG.dataEndpoint, {
        action: "confirm",
        participant_id: state.participantId,
        study_id: state.studyId,
        session_id: state.sessionId,
        event_id: finalEventId,
        study_version: CONFIG.version
      }, CONFIG.network.dataRequestTimeoutMs);
      if (!confirmation?.ok || !confirmation.confirmed || Number(confirmation.trialCount) !== CONFIG.trialCount) {
        throw new Error("The final save and all 114 trial rows could not be confirmed.");
      }
    }
    state.status = "complete";
    saveLocal();
    if (isPreview) {
      renderPreviewComplete();
      return;
    }
    redirectTo(CONFIG.redirects.complete);
  } catch (error) {
    state.status = "upload_error";
    saveLocal();
    setHeader("Save interrupted", true);
    setView(
      '<section class="card compact-card"><h1>Your final save was not confirmed.</h1>' +
        '<p>Your responses remain stored on this device. Check the connection and retry; do not close the page.</p>' +
        '<div class="notice error">' + escapeHtml(error.message) + "</div>" +
        '<div class="actions"><button class="button" id="retry-final">Retry final save</button></div></section>'
    );
    document.getElementById("retry-final").addEventListener("click", submitFinal);
  }
}

function renderPreviewComplete() {
  setHeader("Preview complete", true);
  setView(
    '<section class="card compact-card"><h1>Preview completed successfully.</h1>' +
      '<p>No Prolific redirect occurred, no remote data was written, and no participant-facing log is available in preview mode.</p>' +
      '<div class="actions"><button class="button" id="reset-preview">Reset preview</button></div></section>'
  );
  document.getElementById("reset-preview").addEventListener("click", resetPreview);
}

function renderResume() {
  setHeader("Saved progress found");
  setView(
    '<section class="card compact-card"><h1>Continue where you left off?</h1>' +
      '<p>This device has saved progress for ' + escapeHtml(String(state.trialCursor)) + ' of ' +
      escapeHtml(String(CONFIG.trialCount)) + ' main comparisons.</p>' +
      '<div class="actions"><button class="button" id="resume-button">Resume</button>' +
      (isPreview ? '<button class="button secondary" id="restart-button">Restart preview</button>' : "") +
      "</div></section>"
  );
  document.getElementById("resume-button").addEventListener("click", async () => {
    try {
      assignment = await loadCurrentAssignment(Number(state.slot));
      await requestStudyFullscreen();
      if (!state.practiceComplete) renderPracticeIntro();
      else continueMain();
    } catch (error) {
      renderAssignmentLoadError(error);
    }
  });
  document.getElementById("restart-button")?.addEventListener("click", resetPreview);
}

function renderAlreadyComplete() {
  setHeader("Already complete");
  setView(
    '<section class="card compact-card"><h1>This session was already completed.</h1>' +
      '<p>Return to Prolific to view the submission.</p>' +
      '<div class="actions"><button class="button" id="return-complete">Return to Prolific</button>' +
      (isPreview ? '<button class="button secondary" id="reset-preview">Reset preview</button>' : "") +
      "</div></section>"
  );
  document.getElementById("return-complete").addEventListener("click", () => redirectTo(CONFIG.redirects.complete));
  document.getElementById("reset-preview")?.addEventListener("click", resetPreview);
}

async function terminateEarly(reason) {
  const route = resolveEarlyExitRoute(reason);
  state.status = route.status;
  state.earlyExit = { reason, redirectKey: route.redirectKey, recordedAt: nowIso() };
  state.completedAt = nowIso();
  saveLocal();
  if (CONFIG.dataEndpoint && !isPreview) {
    queueRemote("screenout", { reason, outcome: route.status });
    try { await flushUploads(); } catch (error) { console.warn(error); }
  }
  renderEarlyExit(reason);
}

function renderEarlyExit(reason) {
  const route = resolveEarlyExitRoute(reason);
  setHeader("Eligibility result");
  setView(
    '<section class="card compact-card"><h1>' + escapeHtml(route.heading) + "</h1>" +
      "<p>" + escapeHtml(route.message) + "</p>" +
      '<div class="actions"><button class="button" id="screenout-return">Return to Prolific</button></div></section>'
  );
  const destination = CONFIG.redirects[route.redirectKey];
  document.getElementById("screenout-return").addEventListener("click", () => redirectTo(destination));
  window.setTimeout(() => redirectTo(destination), timings.redirectDelayMs);
}

function queueRemote(kind, body = {}) {
  if (!CONFIG.dataEndpoint || isPreview) return;
  const id = body.record?.eventId || body.event?.eventId || body.finalEventId || makeEventId(kind, String(Date.now()));
  if (state.pendingUploads.some((item) => item.id === id)) return;
  const payload = {
    kind,
    studyVersion: CONFIG.version,
    confirmationMode: "per_record",
    participant: {
      participantId: state.participantId,
      studyId: state.studyId,
      sessionId: state.sessionId,
      slot: state.slot,
      allocationId: state.allocationId,
      assignmentVersion: state.assignmentVersion
    },
    participantSummary: participantSummary(),
    resumeState: resumableState(),
    ...body,
    requestId: id
  };
  state.pendingUploads.push({ id, payload });
  saveLocal();
  const immediate = !collectorSupportsBatch
    || state.pendingUploads.length >= CONFIG.network.uploadBatchSize
    || ["final", "screenout"].includes(kind)
    || requiresImmediateConfirmation({ id, payload });
  scheduleUploadFlush(immediate);
}

function scheduleUploadFlush(immediate = false) {
  if (scheduledFlush) {
    window.clearTimeout(scheduledFlush);
    scheduledFlush = null;
  }
  if (immediate) {
    flushUploads().catch(() => {});
    return;
  }
  scheduledFlush = window.setTimeout(() => {
    scheduledFlush = null;
    flushUploads().catch(() => {});
  }, CONFIG.network.uploadFlushDelayMs);
}

function clearScheduledFlush() {
  if (!scheduledFlush) return;
  window.clearTimeout(scheduledFlush);
  scheduledFlush = null;
}

function participantSummary() {
  return {
    status: state.status,
    consentedAt: state.consentedAt,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    lastSeenAt: nowIso(),
    completedTrials: state.trialCursor,
    attentionChecksPassed: state.attentionChecks.length,
    eligibility: state.eligibility,
    comprehension: state.comprehension,
    device: state.screen
  };
}

function resumableState() {
  return {
    version: state.version,
    status: state.status,
    consentedAt: state.consentedAt,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    slot: state.slot,
    allocationId: state.allocationId,
    assignmentVersion: state.assignmentVersion,
    eligibility: state.eligibility,
    comprehension: state.comprehension,
    screen: state.screen,
    practiceIndex: state.practiceIndex,
    practiceComplete: state.practiceComplete,
    trialCursor: state.trialCursor,
    attentionChecks: state.attentionChecks,
    attentionAttempts: state.attentionAttempts,
    eventSequence: state.eventSequence || 0,
    breaks: state.breaks,
    checkpointedSets: state.checkpointedSets,
    postStudy: state.postStudy
  };
}

async function flushUploads() {
  if (!CONFIG.dataEndpoint || isPreview) return;
  clearScheduledFlush();
  if (activeFlush) return activeFlush;
  activeFlush = (async () => {
    let attempts = 0;
    while (state.pendingUploads.length) {
      const batchMode = collectorSupportsBatch;
      const chunkSize = batchMode ? CONFIG.network.uploadBatchSize : 1;
      const chunk = state.pendingUploads.slice(0, chunkSize);
      const uploadPayload = batchMode
        ? buildUploadBatch(chunk, {
            batchId: makeEventId("batch", chunk.map((item) => item.id).join(":")),
            collectorVersion: CONFIG.collector.version,
            studyVersion: CONFIG.version,
            participant: chunk[0].payload.participant
          })
        : chunk[0].payload;
      try {
        await postFormWithTimeout(
          (...requestArguments) => window.fetch(...requestArguments),
          CONFIG.dataEndpoint,
          uploadPayload,
          CONFIG.network.postRequestTimeoutMs
        );
        chunk.forEach((item) => {
          if (item.payload.kind === "trial") rememberUnconfirmedTrial(item);
        });
        for (const item of chunk.filter(requiresImmediateConfirmation)) {
          const confirmation = await jsonp(CONFIG.dataEndpoint, {
            action: "confirm_record",
            record_type: item.payload.kind,
            participant_id: state.participantId,
            study_id: state.studyId,
            session_id: state.sessionId,
            event_id: item.id,
            study_version: CONFIG.version
          }, CONFIG.network.dataRequestTimeoutMs);
          if (!confirmation?.ok || !confirmation.confirmed) {
            throw new Error(`The ${item.payload.kind} record was not confirmed.`);
          }
        }
        state.pendingUploads.splice(0, chunk.length);
        attempts = 0;
        saveLocal();
      } catch (error) {
        attempts += 1;
        if (attempts >= 3) throw error;
        await sleep(400 * attempts);
      }
    }
  })();
  try {
    await activeFlush;
  } finally {
    activeFlush = null;
  }
}

function rememberUnconfirmedTrial(item) {
  if (!state.unconfirmedTrials.some((trial) => trial.id === item.id)) {
    state.unconfirmedTrials.push(item);
  }
}

function requiresImmediateConfirmation(item) {
  if (item.payload.kind === "trial") return true;
  if (item.payload.kind !== "event") return false;
  return [
    "consent_given",
    "device_check",
    "eligibility_check",
    "comprehension_attempt",
    "assignment_loaded",
    "practice_started",
    "practice_completed",
    "main_study_started",
    "attention_check",
    "break_completed"
  ].includes(item.payload.event?.type);
}

function retryMissingTrials(missingIndices) {
  const missing = new Set(missingIndices.map(Number));
  const pendingIds = new Set(state.pendingUploads.map((item) => item.id));
  const retryItems = state.unconfirmedTrials.filter((item) => (
    missing.has(Number(item.payload.record?.globalTrialIndex)) && !pendingIds.has(item.id)
  ));
  if (retryItems.length !== missing.size) {
    throw new Error("A missing response could not be recovered from this device.");
  }
  state.pendingUploads.unshift(...retryItems);
  saveLocal();
}

function clearConfirmedTrials(expectedTrials) {
  state.unconfirmedTrials = state.unconfirmedTrials.filter((item) => (
    Number(item.payload.record?.globalTrialIndex) > expectedTrials
  ));
  saveLocal();
}

async function confirmTrialCheckpoint(expectedTrials, timeoutMs) {
  if (isPreview || !CONFIG.dataEndpoint) {
    clearConfirmedTrials(expectedTrials);
    return;
  }
  let confirmedTrials = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await flushUploads();
    const checkpoint = await jsonp(CONFIG.dataEndpoint, {
      action: "checkpoint",
      participant_id: state.participantId,
      study_id: state.studyId,
      session_id: state.sessionId,
      expected_trials: expectedTrials,
      study_version: CONFIG.version
    }, timeoutMs);
    confirmedTrials = Number(checkpoint?.confirmedTrials || 0);
    if (checkpoint?.ok && checkpoint.complete && confirmedTrials === expectedTrials) {
      clearConfirmedTrials(expectedTrials);
      return;
    }
    const missing = Array.isArray(checkpoint?.missingGlobalTrialIndices)
      ? checkpoint.missingGlobalTrialIndices.map(Number)
      : [];
    if (!checkpoint?.ok || !missing.length || attempt === 3) break;
    retryMissingTrials(missing);
    await sleep(400 * attempt);
  }
  throw new Error(`The server confirmed ${confirmedTrials} of ${expectedTrials} responses.`);
}

function jsonp(endpoint, query, timeoutMs = CONFIG.network.dataRequestTimeoutMs) {
  return new Promise((resolve, reject) => {
    const callback = "__te_callback_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The data service did not respond."));
    }, timeoutMs);
    function cleanup() {
      window.clearTimeout(timeout);
      script.remove();
      delete window[callback];
    }
    window[callback] = (value) => {
      cleanup();
      resolve(value);
    };
    const url = new URL(endpoint);
    Object.entries({ ...query, callback }).forEach(([key, value]) => url.searchParams.set(key, String(value ?? "")));
    script.src = url.toString();
    script.onerror = () => {
      cleanup();
      reject(new Error("The data service could not be reached."));
    };
    document.head.appendChild(script);
  });
}

function redirectTo(url) {
  if (isPreview) {
    renderPreviewComplete();
    return;
  }
  if (url) {
    window.location.assign(url);
    return;
  }
  renderConfigurationError(["The required Prolific redirect URL is missing."]);
}

window.addEventListener("online", () => {
  recordEvent("connection_online");
  flushUploads().catch(() => {});
});
window.addEventListener("offline", () => recordEvent("connection_offline"));
window.addEventListener("beforeunload", () => {
  if (!suppressUnloadSave) saveLocal();
});
document.addEventListener("fullscreenchange", () => {
  if (state.consentedAt) recordEvent(document.fullscreenElement ? "fullscreen_entered" : "fullscreen_exited");
});

init();

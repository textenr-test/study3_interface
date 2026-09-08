/*
 * Text Enrichment Reader Study — Study 3 Google Apps Script data collector
 *
 * 1. Bind this script to the private researcher Google Sheet.
 * 2. Run setupStudyWorkbook() once.
 * 3. Set STUDY_VERSION=2026-09-08-study3-v2 in Script Properties.
 * 4. Deploy as a web app, executing as the owner, accessible to anyone with the link.
 * 5. Put the /exec URL in study-config.js as dataEndpoint.
 *
 * The public endpoint supports append/checkpoint operations only. It has no export or
 * read-data route. Spreadsheet and Drive-file access remain controlled by the owner.
 */

const COLLECTOR_SERVICE = "text-enrichment-reader-study3";
const COLLECTOR_VERSION = "2026-09-08-study3-v2";
const SCHEMA_VERSION = "text-enrichment-trial-log-v3";
const MAX_BATCH_SIZE = 8;

const STUDY_DESIGN = Object.freeze({
  participants: 35,
  sets: 3,
  trialsPerSet: 38,
  trialsPerParticipant: 114,
  assignmentVersion: "n35-study3-carryover-v2",
  assignmentSeed: "text-enrichment-reader-study3-n35-v2",
  conditions: ["D1_derived", "D2_derived", "W_writer_optimal", "D3_derived", "D4_derived", "D5_maximal", "M_model_optimal"]
});

const SHEET_NAMES = Object.freeze({
  participants: "Participants",
  trials: "Trials",
  trialJson: "TrialJSON",
  events: "Events",
  readme: "README"
});

const HEADERS = Object.freeze({
  Participants: [
    "participant_id", "session_id", "study_id", "participant_slot", "allocation_id",
    "assignment_version", "status", "consented_at", "started_at", "completed_at",
    "last_seen_at", "completed_trials", "attention_checks_passed", "eligibility_json",
    "color_test_json", "comprehension_json", "device_json", "state_json", "final_event_id",
    "study_version"
  ],
  Trials: [
    "event_id", "participant_id", "participant_slot", "set_id", "set_trial_index",
    "global_trial_index", "document_id", "condition_id", "enriched_file", "degree_value",
    "baseline_side", "document_exposure_number", "randomization_seed", "rating", "response_time",
    "session_id", "study_id", "allocation_id", "enriched_side", "source_document_id",
    "stimulus_validation_status", "visual_coverage", "target_coverage", "retained_factor_count",
    "stimulus_sha256", "visual_sha256", "factor_ids_sha256",
    "model_optimal_equivalent_condition_id", "model_optimal_is_novel", "fano_block_id",
    "set_permutation_id", "assigned_condition_triple_json", "within_document_visual_duplicate",
    "spatial_rating", "planned_fixation_ms", "planned_exposure_ms", "actual_exposure_ms",
    "preload_ms", "attempt_count", "stimulus_scale", "source_viewport_width",
    "source_viewport_height", "fitted_content_height", "left_content_height",
    "right_content_height", "trimmed_bottom_whitespace_px", "fullscreen", "display_info_json",
    "responded_at", "study_version", "received_at"
  ],
  TrialJSON: [
    "event_id", "participant_id", "session_id", "study_id", "global_trial_index", "record_json",
    "received_at", "study_version"
  ],
  Events: [
    "event_id", "participant_id", "session_id", "study_id", "participant_slot", "event_type",
    "event_timestamp", "completed_trials", "detail_json", "study_version"
  ],
  README: ["Text Enrichment Reader Study — Study 3 Data Dictionary", "Value"]
});

function setupStudyWorkbook() {
  const spreadsheet = getSpreadsheet_();
  Object.keys(HEADERS).forEach(function(name) {
    const sheet = getOrCreateSheet_(spreadsheet, name);
    ensureHeaders_(sheet, HEADERS[name]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS[name].length)
      .setFontWeight("bold")
      .setBackground("#202020")
      .setFontColor("#ffffff");
    sheet.setHiddenGridlines(true);
  });

  const readme = spreadsheet.getSheetByName(SHEET_NAMES.readme);
  if (readme.getLastRow() <= 1) {
    const rows = [
      ["Purpose", "Pseudonymous study records. One participant per Participants row; one analyzed response per Trials row; one parallel JSON record per TrialJSON row; quality and lifecycle records in Events."],
      ["Trial balance", "35 valid completed allocation slots × 114 trials = 3,990 rows. Each participant completes three sets of 38 and sees three distinct enriched versions of every document."],
      ["Condition balance", "Each participant sees two conditions 17 times and five conditions 16 times; each document-condition pair has 15 readers; each document-condition-set cell has 5 readers."],
      ["Carryover balance", "Across all complete slots, every ordered pair of distinct conditions occurs 94 or 95 times (92 or 93 within sets); each condition occurs five times at every global position."],
      ["M-equivalent-D rule", "If M is visually identical to a D condition for a document, M and that D condition never occur in the same participant-document triple."],
      ["Side balance", "Within every participant-set, D0 appears left 19 times and right 19 times. Every document-condition-set and condition-position cell is crossed 2/3, each global position is 17/18, and side runs are at most three."],
      ["Model-optimal audit", "M records realized ink mass, retained-factor count, exact/visual/factor hashes, and its visually equivalent D condition when one exists."],
      ["Rating direction", "rating: −3 means enriched much less preferred, 0 no difference, +3 enriched much more preferred. spatial_rating is the raw left-to-right response."],
      ["Timing", "750 ms fixation, 1,000 ms simultaneous display, three attention checks (+1, +3, +1), and 60-second breaks after trials 38 and 76."],
      ["Checkpoint policy", "Trials are appended idempotently. The interface confirms each row, checks all 38/76 rows before each break, and confirms all 114 rows before completion."],
      ["Exports", "text-enrichment-final-log.csv and text-enrichment-final-log.json are created at setup and refreshed after each completed participant. Run exportStudyLogs() for an on-demand refresh."],
      ["Slot policy", "The exact balance is guaranteed when every slot 1–35 has one valid completion. Use releaseIncompleteSlot() for non-completers or releaseInvalidCompletedSlot() after a documented post-hoc invalidation, retain all rows for audit, and refill the released slot."],
      ["Stimulus warnings", "P6_DOC_A, P13_DOC_A, and P13_DOC_B have source-pipeline validation_status=warning and require analysis review."],
      ["Privacy", "Keep the spreadsheet and exported files restricted to authorized research personnel. The web endpoint has no public export route."],
      ["Study version", configuredStudyVersion_()],
      ["Study 3 screening", "The color-vision plate is not administered. Weekly creator-led reading, language, normal/corrected vision, device, and comprehension checks remain in place. color_test_json is retained as an intentionally blank compatibility column."]
    ];
    readme.getRange(2, 1, rows.length, 2).setValues(rows);
  }
  spreadsheet.getSheets().forEach(function(sheet) {
    sheet.autoResizeColumns(1, Math.max(sheet.getLastColumn(), 1));
  });
  const exports = exportStudyLogs();
  return { spreadsheetId: spreadsheet.getId(), url: spreadsheet.getUrl(), exports: exports };
}

function doGet(e) {
  try {
    const action = String(e.parameter.action || "health");
    let result;
    if (action === "health") {
      result = {
        ok: true,
        service: COLLECTOR_SERVICE,
        collectorVersion: COLLECTOR_VERSION,
        studyVersion: configuredStudyVersion_(),
        assignmentVersion: STUDY_DESIGN.assignmentVersion,
        schemaVersion: SCHEMA_VERSION,
        timestamp: new Date().toISOString()
      };
    } else if (action === "reserve") {
      result = reserveSlot_(e.parameter);
    } else if (action === "confirm") {
      result = confirmFinal_(e.parameter);
    } else if (action === "checkpoint") {
      result = checkpoint_(e.parameter);
    } else if (action === "confirm_record") {
      result = confirmRecord_(e.parameter);
    } else {
      result = { ok: false, error: "Unsupported action." };
    }
    return output_(result, e.parameter.callback);
  } catch (error) {
    return output_({ ok: false, error: String(error && error.message || error) }, e.parameter.callback);
  }
}

function doPost(e) {
  try {
    const raw = e.parameter.payload || (e.postData && e.postData.contents) || "";
    if (!raw || raw.length > 500000) throw new Error("Invalid or oversized payload.");
    const payload = JSON.parse(raw);
    return output_(payload.kind === "batch" ? storePayloadBatch_(payload) : storePayload_(payload), "");
  } catch (error) {
    return output_({ ok: false, error: String(error && error.message || error) }, "");
  }
}

function reserveSlot_(parameters) {
  const identity = validateIdentity_(parameters);
  const studyVersion = verifyStudyVersion_(parameters.study_version);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = getSpreadsheet_();
    const sheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.participants);
    ensureHeaders_(sheet, HEADERS.Participants);
    let table = readTable_(sheet);
    let existing = table.rows.find(function(row) {
      return row.participant_id === identity.participantId
        && row.study_id === identity.studyId
        && row.study_version === studyVersion;
    });
    if (existing && existing.session_id !== identity.sessionId) {
      return { ok: false, error: "The Prolific session does not match the existing study record." };
    }
    if (existing && Number(existing.participant_slot)) {
      const reservationEventId = recordSlotReservation_(
        spreadsheet,
        identity,
        studyVersion,
        Number(existing.participant_slot),
        existing.allocation_id,
        true
      );
      updateParticipantFields_(sheet, existing._rowNumber, { last_seen_at: new Date().toISOString() });
      return {
        ok: true,
        existing: true,
        slot: Number(existing.participant_slot),
        allocationId: existing.allocation_id,
        assignmentVersion: existing.assignment_version,
        status: existing.status,
        state: existing.state_json || "",
        reservationEventId: reservationEventId
      };
    }

    const usedSlots = new Set(table.rows
      .filter(function(row) {
        return row.study_version === studyVersion
          && Number(row.participant_slot)
          && !["released", "released_with_partial_data", "released_invalid_complete"].includes(String(row.status));
      })
      .map(function(row) { return Number(row.participant_slot); }));
    let slot = null;
    for (let candidate = 1; candidate <= STUDY_DESIGN.participants; candidate += 1) {
      if (!usedSlots.has(candidate)) {
        slot = candidate;
        break;
      }
    }
    if (!slot) return { ok: false, error: "All " + STUDY_DESIGN.participants + " pre-generated allocation slots are assigned." };

    const allocationId = allocationIdForSlot_(slot);
    const fields = {
      participant_id: identity.participantId,
      session_id: identity.sessionId,
      study_id: identity.studyId,
      participant_slot: slot,
      allocation_id: allocationId,
      assignment_version: STUDY_DESIGN.assignmentVersion,
      status: "eligible",
      last_seen_at: new Date().toISOString(),
      completed_trials: 0,
      attention_checks_passed: 0,
      study_version: studyVersion
    };
    if (existing) {
      updateParticipantFields_(sheet, existing._rowNumber, fields);
    } else {
      const row = blankRow_(HEADERS.Participants);
      Object.assign(row, fields);
      appendObjectRow_(sheet, HEADERS.Participants, row);
    }
    const reservationEventId = recordSlotReservation_(
      spreadsheet,
      identity,
      studyVersion,
      slot,
      allocationId,
      false
    );
    return {
      ok: true,
      existing: Boolean(existing),
      slot: slot,
      allocationId: allocationId,
      assignmentVersion: STUDY_DESIGN.assignmentVersion,
      status: "eligible",
      state: existing ? existing.state_json || "" : "",
      reservationEventId: reservationEventId
    };
  } finally {
    lock.releaseLock();
  }
}

function recordSlotReservation_(spreadsheet, identity, studyVersion, slot, allocationId, existing) {
  const eventId = deterministicEventId_("slot_reserved", [
    studyVersion,
    identity.participantId,
    identity.studyId,
    identity.sessionId,
    slot
  ]);
  appendEvent_(spreadsheet, {
    eventId: eventId,
    type: "slot_reserved",
    timestamp: new Date().toISOString(),
    detail: {
      participantSlot: slot,
      allocationId: allocationId,
      assignmentVersion: STUDY_DESIGN.assignmentVersion,
      resumed: existing
    }
  }, {
    kind: "event",
    requestId: eventId,
    studyVersion: studyVersion,
    participant: { slot: slot, allocationId: allocationId },
    participantSummary: { completedTrials: 0 }
  }, identity);
  rememberRecordConfirmation_("event", eventId, identity);
  return eventId;
}

function confirmRecord_(parameters) {
  const identity = validateIdentity_(parameters);
  verifyStudyVersion_(parameters.study_version);
  const eventId = safeIdentifier_(parameters.event_id, "event_id");
  const type = String(parameters.record_type || "");
  if (!["trial", "event"].includes(type)) throw new Error("Invalid record_type.");
  if (recordConfirmationCache_().get(recordConfirmationKey_(type, eventId, identity)) === "1") {
    return { ok: true, confirmed: true, eventId: eventId, recordType: type, cached: true };
  }
  const spreadsheet = getSpreadsheet_();
  const sheet = getOrCreateSheet_(spreadsheet, type === "trial" ? SHEET_NAMES.trials : SHEET_NAMES.events);
  ensureHeaders_(sheet, type === "trial" ? HEADERS.Trials : HEADERS.Events);
  const match = findIdentityEvent_(sheet, eventId, identity);
  let jsonConfirmed = true;
  if (type === "trial") {
    const jsonSheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.trialJson);
    ensureHeaders_(jsonSheet, HEADERS.TrialJSON);
    jsonConfirmed = Boolean(findIdentityEvent_(jsonSheet, eventId, identity));
  }
  return { ok: true, confirmed: Boolean(match) && jsonConfirmed, eventId: eventId, recordType: type };
}

function checkpoint_(parameters) {
  const identity = validateIdentity_(parameters);
  verifyStudyVersion_(parameters.study_version);
  const expected = Number(parameters.expected_trials);
  if (![38, 76, 114].includes(expected)) throw new Error("Invalid checkpoint size.");
  const result = trialCompleteness_(identity, expected);
  return {
    ok: true,
    expectedTrials: expected,
    confirmedTrials: result.confirmedTrials,
    missingGlobalTrialIndices: result.missing,
    complete: result.missing.length === 0
  };
}

function confirmFinal_(parameters) {
  const identity = validateIdentity_(parameters);
  verifyStudyVersion_(parameters.study_version);
  const eventId = safeIdentifier_(parameters.event_id, "event_id");
  const spreadsheet = getSpreadsheet_();
  const eventSheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.events);
  ensureHeaders_(eventSheet, HEADERS.Events);
  const event = findIdentityEvent_(eventSheet, eventId, identity);
  const eventDetail = event ? parseJsonCell_(event.detail_json) : {};
  const complete = eventDetail.serverAudit && eventDetail.serverAudit.complete
    ? eventDetail.serverAudit
    : completionAudit_(spreadsheet, identity);
  return {
    ok: true,
    confirmed: Boolean(event) && complete.complete,
    eventId: eventId,
    trialCount: complete.trialCount,
    setCounts: complete.setCounts,
    attentionChecksPassed: complete.attentionChecksPassed,
    completedBreaks: complete.completedBreaks,
    missingGlobalTrialIndices: complete.missing
  };
}

function storePayload_(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Payload must be an object.");
  const participant = payload.participant || {};
  const identity = validateIdentity_({
    participant_id: participant.participantId,
    study_id: participant.studyId,
    session_id: participant.sessionId
  });
  const studyVersion = verifyStudyVersion_(payload.studyVersion);
  const allowedKinds = new Set(["snapshot", "trial", "event", "final", "screenout"]);
  if (!allowedKinds.has(payload.kind)) throw new Error("Unsupported payload kind.");

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = getSpreadsheet_();
    const participantSheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.participants);
    ensureHeaders_(participantSheet, HEADERS.Participants);
    let participantTable = readTable_(participantSheet);
    let participantRow = participantTable.rows.find(function(row) {
      return row.participant_id === identity.participantId
        && row.study_id === identity.studyId
        && row.study_version === studyVersion;
    });

    if (!participantRow) {
      if (["trial", "final"].includes(payload.kind)) throw new Error("Participant slot has not been reserved.");
      const blank = blankRow_(HEADERS.Participants);
      Object.assign(blank, {
        participant_id: identity.participantId,
        session_id: identity.sessionId,
        study_id: identity.studyId,
        status: payload.kind === "screenout" ? "screened_out" : "pre_allocation",
        last_seen_at: new Date().toISOString(),
        completed_trials: 0,
        attention_checks_passed: 0,
        study_version: studyVersion
      });
      appendObjectRow_(participantSheet, HEADERS.Participants, blank);
      participantTable = readTable_(participantSheet);
      participantRow = participantTable.rows[participantTable.rows.length - 1];
    }
    if (participantRow.session_id !== identity.sessionId) throw new Error("Session mismatch.");
    validateParticipantAllocation_(participantRow, participant, payload.kind);

    if (payload.kind === "trial") {
      appendTrial_(spreadsheet, payload, identity, participantRow);
      if (payload.confirmationMode !== "checkpoint") {
        rememberRecordConfirmation_("trial", payload.record && payload.record.eventId, identity);
      }
    }
    if (payload.kind === "event") {
      appendEvent_(spreadsheet, payload.event || {}, payload, identity);
      rememberRecordConfirmation_("event", payload.event && payload.event.eventId, identity);
    }
    if (payload.kind === "screenout") {
      appendEvent_(spreadsheet, {
        eventId: payload.finalEventId || payload.requestId || eventIdFromPayload_(payload, "screenout"),
        type: "screenout",
        timestamp: new Date().toISOString(),
        detail: { reason: payload.reason || "", outcome: payload.outcome || "screened_out" }
      }, payload, identity);
    }
    if (payload.kind === "final") {
      const audit = completionAudit_(spreadsheet, identity);
      if (!audit.complete) {
        throw new Error("Final submission rejected: 114 trials, three attention checks, and two breaks were not all confirmed.");
      }
      appendEvent_(spreadsheet, {
        eventId: payload.finalEventId,
        type: "final",
        timestamp: payload.participantSummary?.completedAt || new Date().toISOString(),
        detail: Object.assign({}, payload.summary || {}, { serverAudit: audit })
      }, payload, identity);
    }

    const summary = payload.participantSummary || {};
    const update = {
      participant_slot: participant.slot ?? participantRow.participant_slot,
      allocation_id: participant.allocationId || participantRow.allocation_id,
      assignment_version: participant.assignmentVersion || participantRow.assignment_version,
      status: payload.outcome || summary.status || participantRow.status,
      consented_at: summary.consentedAt || participantRow.consented_at,
      started_at: summary.startedAt || participantRow.started_at,
      completed_at: summary.completedAt || participantRow.completed_at,
      last_seen_at: summary.lastSeenAt || new Date().toISOString(),
      completed_trials: summary.completedTrials ?? participantRow.completed_trials,
      attention_checks_passed: summary.attentionChecksPassed ?? participantRow.attention_checks_passed,
      eligibility_json: jsonCell_(summary.eligibility),
      color_test_json: jsonCell_(summary.colorTest),
      comprehension_json: jsonCell_(summary.comprehension),
      device_json: jsonCell_(summary.device),
      state_json: jsonCell_(payload.resumeState),
      study_version: studyVersion
    };
    if (payload.kind === "final") {
      update.status = "complete";
      update.completed_at = summary.completedAt || new Date().toISOString();
      update.final_event_id = payload.finalEventId || "";
    }
    if (payload.kind === "screenout") update.status = payload.outcome || "screened_out";
    updateParticipantFields_(participantSheet, participantRow._rowNumber, update);

    const exports = payload.kind === "final" ? exportStudyLogs() : null;
    return { ok: true, kind: payload.kind, exports: exports };
  } finally {
    lock.releaseLock();
  }
}

function storePayloadBatch_(batch) {
  if (!batch || typeof batch !== "object") throw new Error("Batch payload must be an object.");
  if (batch.collectorVersion !== COLLECTOR_VERSION) throw new Error("Collector release mismatch.");
  const batchId = safeIdentifier_(batch.batchId, "batch_id");
  const items = Array.isArray(batch.items) ? batch.items : [];
  if (!items.length || items.length > MAX_BATCH_SIZE) throw new Error("Invalid batch size.");

  const batchParticipant = batch.participant || {};
  const identity = validateIdentity_({
    participant_id: batchParticipant.participantId,
    study_id: batchParticipant.studyId,
    session_id: batchParticipant.sessionId
  });
  const studyVersion = verifyStudyVersion_(batch.studyVersion);
  const allowedKinds = new Set(["snapshot", "trial", "event", "final", "screenout"]);
  items.forEach(function(payload) {
    if (!payload || typeof payload !== "object" || !allowedKinds.has(payload.kind)) {
      throw new Error("Unsupported payload kind in batch.");
    }
    if (verifyStudyVersion_(payload.studyVersion) !== studyVersion) throw new Error("Batch study version mismatch.");
    const participant = payload.participant || {};
    const itemIdentity = validateIdentity_({
      participant_id: participant.participantId,
      study_id: participant.studyId,
      session_id: participant.sessionId
    });
    if (itemIdentity.participantId !== identity.participantId
      || itemIdentity.studyId !== identity.studyId
      || itemIdentity.sessionId !== identity.sessionId) {
      throw new Error("Mixed participant identities are not allowed in one batch.");
    }
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = getSpreadsheet_();
    const participantSheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.participants);
    ensureHeaders_(participantSheet, HEADERS.Participants);
    const participantTable = readTable_(participantSheet);
    let participantRow = participantTable.rows.find(function(row) {
      return row.participant_id === identity.participantId
        && row.study_id === identity.studyId
        && row.study_version === studyVersion;
    });

    if (!participantRow) {
      if (items.some(function(payload) { return ["trial", "final", "snapshot"].includes(payload.kind); })) {
        throw new Error("Participant slot has not been reserved.");
      }
      const blank = blankRow_(HEADERS.Participants);
      Object.assign(blank, {
        participant_id: identity.participantId,
        session_id: identity.sessionId,
        study_id: identity.studyId,
        status: items.some(function(payload) { return payload.kind === "screenout"; }) ? "screened_out" : "pre_allocation",
        last_seen_at: new Date().toISOString(),
        completed_trials: 0,
        attention_checks_passed: 0,
        study_version: studyVersion
      });
      appendObjectRow_(participantSheet, HEADERS.Participants, blank);
      blank._rowNumber = participantSheet.getLastRow();
      participantRow = blank;
    }
    if (participantRow.session_id !== identity.sessionId) throw new Error("Session mismatch.");
    items.forEach(function(payload) {
      validateParticipantAllocation_(participantRow, payload.participant || {}, payload.kind);
    });

    const hasTrials = items.some(function(payload) { return payload.kind === "trial"; });
    const hasEvents = items.some(function(payload) {
      return ["event", "screenout", "final"].includes(payload.kind);
    });
    const trialSheet = hasTrials ? getOrCreateSheet_(spreadsheet, SHEET_NAMES.trials) : null;
    const jsonSheet = hasTrials ? getOrCreateSheet_(spreadsheet, SHEET_NAMES.trialJson) : null;
    const eventSheet = hasEvents ? getOrCreateSheet_(spreadsheet, SHEET_NAMES.events) : null;
    if (trialSheet) ensureHeaders_(trialSheet, HEADERS.Trials);
    if (jsonSheet) ensureHeaders_(jsonSheet, HEADERS.TrialJSON);
    if (eventSheet) ensureHeaders_(eventSheet, HEADERS.Events);

    const knownTrialIds = trialSheet ? identityEventIds_(trialSheet, identity) : new Set();
    const knownJsonIds = jsonSheet ? identityEventIds_(jsonSheet, identity) : new Set();
    const knownEventIds = eventSheet ? identityEventIds_(eventSheet, identity) : new Set();
    const trialRows = [];
    const jsonRows = [];
    const eventRows = [];
    const finalPayloads = [];
    const confirmations = [];

    items.forEach(function(payload) {
      if (payload.kind === "trial") {
        const canonical = validateTrialRecord_(payload.record || {}, studyVersion, participantRow);
        let stored = canonical;
        if (!knownTrialIds.has(canonical.event_id)) {
          trialRows.push(canonical);
          knownTrialIds.add(canonical.event_id);
        } else if (!knownJsonIds.has(canonical.event_id)) {
          stored = findIdentityEvent_(trialSheet, canonical.event_id, identity) || canonical;
        }
        if (!knownJsonIds.has(canonical.event_id)) {
          jsonRows.push({
            event_id: canonical.event_id,
            participant_id: identity.participantId,
            session_id: identity.sessionId,
            study_id: identity.studyId,
            global_trial_index: canonical.global_trial_index,
            record_json: JSON.stringify(objectFromHeaders_(HEADERS.Trials, stored)),
            received_at: stored.received_at,
            study_version: studyVersion
          });
          knownJsonIds.add(canonical.event_id);
        }
        if (payload.confirmationMode !== "checkpoint") {
          confirmations.push({ type: "trial", eventId: canonical.event_id });
        }
      }
      if (payload.kind === "event") {
        const eventRow = eventObject_(payload.event || {}, payload, identity);
        if (!knownEventIds.has(eventRow.event_id)) {
          eventRows.push(eventRow);
          knownEventIds.add(eventRow.event_id);
        }
        confirmations.push({ type: "event", eventId: eventRow.event_id });
      }
      if (payload.kind === "screenout") {
        const screenoutRow = eventObject_({
          eventId: payload.finalEventId || payload.requestId || eventIdFromPayload_(payload, "screenout"),
          type: "screenout",
          timestamp: new Date().toISOString(),
          detail: { reason: payload.reason || "", outcome: payload.outcome || "screened_out" }
        }, payload, identity);
        if (!knownEventIds.has(screenoutRow.event_id)) {
          eventRows.push(screenoutRow);
          knownEventIds.add(screenoutRow.event_id);
        }
      }
      if (payload.kind === "final") finalPayloads.push(payload);
    });

    appendObjectRows_(trialSheet, HEADERS.Trials, trialRows);
    appendObjectRows_(jsonSheet, HEADERS.TrialJSON, jsonRows);
    appendObjectRows_(eventSheet, HEADERS.Events, eventRows);

    const finalRows = [];
    finalPayloads.forEach(function(payload) {
      const audit = completionAudit_(spreadsheet, identity);
      if (!audit.complete) {
        throw new Error("Final submission rejected: 114 trials, three attention checks, and two breaks were not all confirmed.");
      }
      const finalRow = eventObject_({
        eventId: payload.finalEventId,
        type: "final",
        timestamp: payload.participantSummary && payload.participantSummary.completedAt || new Date().toISOString(),
        detail: Object.assign({}, payload.summary || {}, { serverAudit: audit })
      }, payload, identity);
      if (!knownEventIds.has(finalRow.event_id)) {
        finalRows.push(finalRow);
        knownEventIds.add(finalRow.event_id);
      }
    });
    appendObjectRows_(eventSheet, HEADERS.Events, finalRows);

    const latestPayload = items[items.length - 1];
    const latestParticipant = latestPayload.participant || {};
    const summary = latestPayload.participantSummary || {};
    const update = {
      participant_slot: latestParticipant.slot != null ? latestParticipant.slot : participantRow.participant_slot,
      allocation_id: latestParticipant.allocationId || participantRow.allocation_id,
      assignment_version: latestParticipant.assignmentVersion || participantRow.assignment_version,
      status: latestPayload.outcome || summary.status || participantRow.status,
      consented_at: summary.consentedAt || participantRow.consented_at,
      started_at: summary.startedAt || participantRow.started_at,
      completed_at: summary.completedAt || participantRow.completed_at,
      last_seen_at: summary.lastSeenAt || new Date().toISOString(),
      completed_trials: summary.completedTrials != null ? summary.completedTrials : participantRow.completed_trials,
      attention_checks_passed: summary.attentionChecksPassed != null ? summary.attentionChecksPassed : participantRow.attention_checks_passed,
      eligibility_json: jsonCell_(summary.eligibility),
      color_test_json: jsonCell_(summary.colorTest),
      comprehension_json: jsonCell_(summary.comprehension),
      device_json: jsonCell_(summary.device),
      state_json: jsonCell_(latestPayload.resumeState),
      study_version: studyVersion
    };
    const finalPayload = finalPayloads.length ? finalPayloads[finalPayloads.length - 1] : null;
    const screenoutPayload = items.slice().reverse().find(function(payload) { return payload.kind === "screenout"; });
    if (finalPayload) {
      update.status = "complete";
      update.completed_at = finalPayload.participantSummary && finalPayload.participantSummary.completedAt || new Date().toISOString();
      update.final_event_id = finalPayload.finalEventId || "";
    } else if (screenoutPayload) {
      update.status = screenoutPayload.outcome || "screened_out";
    }
    updateParticipantFields_(participantSheet, participantRow._rowNumber, update);
    confirmations.forEach(function(item) {
      rememberRecordConfirmation_(item.type, item.eventId, identity);
    });

    const exports = finalPayload ? exportStudyLogs() : null;

    return {
      ok: true,
      kind: "batch",
      batchId: batchId,
      acceptedItems: items.length,
      writes: { trials: trialRows.length, trialJson: jsonRows.length, events: eventRows.length + finalRows.length },
      exports: exports
    };
  } finally {
    lock.releaseLock();
  }
}

function appendTrial_(spreadsheet, payload, identity, participantRow) {
  const record = payload.record || {};
  const canonical = validateTrialRecord_(record, payload.studyVersion, participantRow);
  const sheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.trials);
  ensureHeaders_(sheet, HEADERS.Trials);
  const existingEvent = findIdentityEvent_(sheet, canonical.event_id, identity);
  const stored = existingEvent || canonical;
  if (!existingEvent) appendObjectRow_(sheet, HEADERS.Trials, canonical);

  const jsonSheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.trialJson);
  ensureHeaders_(jsonSheet, HEADERS.TrialJSON);
  if (!findIdentityEvent_(jsonSheet, canonical.event_id, identity)) {
    appendObjectRow_(jsonSheet, HEADERS.TrialJSON, {
      event_id: canonical.event_id,
      participant_id: identity.participantId,
      session_id: identity.sessionId,
      study_id: identity.studyId,
      global_trial_index: canonical.global_trial_index,
      record_json: JSON.stringify(objectFromHeaders_(HEADERS.Trials, stored)),
      received_at: stored.received_at,
      study_version: payload.studyVersion
    });
  }
}

function validateTrialRecord_(record, studyVersion, participantRow) {
  const eventId = safeIdentifier_(record.eventId, "trial event_id");
  const slot = integerInRange_(record.participantSlot, 1, STUDY_DESIGN.participants, "participant_slot");
  if (slot !== Number(participantRow.participant_slot)) throw new Error("Trial participant slot mismatch.");
  const allocationId = safeIdentifier_(record.allocationId, "allocation_id");
  if (allocationId !== participantRow.allocation_id || allocationId !== allocationIdForSlot_(slot)) {
    throw new Error("Trial allocation mismatch.");
  }
  const setId = integerInRange_(record.setId, 1, 3, "set_id");
  const setTrialIndex = integerInRange_(record.setTrialIndex, 1, 38, "set_trial_index");
  const globalTrialIndex = integerInRange_(record.globalTrialIndex, 1, 114, "global_trial_index");
  if (globalTrialIndex !== (setId - 1) * 38 + setTrialIndex) throw new Error("Global trial index mismatch.");
  const documentId = String(record.documentId || "");
  if (!/^P(?:[1-9]|1\d)_DOC_[AB]$/.test(documentId)) throw new Error("Invalid document_id.");
  const conditionId = String(record.conditionId || "");
  const degreeValue = STUDY_DESIGN.conditions.indexOf(conditionId) + 1;
  if (!degreeValue || Number(record.degreeValue) !== degreeValue) throw new Error("Invalid condition or degree_value.");
  if (conditionId === "M_model_optimal" && (
    record.retainedFactorCount === undefined || record.retainedFactorCount === null
    || !record.stimulusSha256 || !record.visualSha256 || !record.factorIdsSha256
  )) throw new Error("Model-optimal trials require realized factor count and stimulus hashes.");
  if (record.enrichedFile !== conditionId + ".html") throw new Error("Enriched filename mismatch.");
  if (!["left", "right"].includes(record.baselineSide) || !["left", "right"].includes(record.enrichedSide)
    || record.baselineSide === record.enrichedSide) throw new Error("Invalid side allocation.");
  if (Number(record.documentExposureNumber) !== setId) throw new Error("Document exposure number mismatch.");
  const expectedSeed = STUDY_DESIGN.assignmentSeed + ":slot:" + slot + ":set:" + setId
    + ":carryover-balanced-v2";
  if (record.randomizationSeed !== expectedSeed) throw new Error("Randomization seed mismatch.");
  const rating = numberInRange_(record.rating, -3, 3, "rating");
  const spatialRating = numberInRange_(record.spatialRating, -3, 3, "spatial_rating");
  if (!Number.isInteger(rating) || !Number.isInteger(spatialRating)) throw new Error("Ratings must be integers.");
  const responseTime = nonnegativeNumber_(record.responseTime, "response_time");
  const equivalentCondition = nullableCondition_(record.modelOptimalEquivalentConditionId);
  const assignedConditionTripleJson = validatedConditionTriple_(record.assignedConditionTriple);
  const assignedConditionTriple = JSON.parse(assignedConditionTripleJson);
  if (!assignedConditionTriple.includes(conditionId)) {
    throw new Error("Trial condition is absent from assigned_condition_triple.");
  }
  if (record.withinDocumentVisualDuplicate !== false) {
    throw new Error("M and its visually identical D condition cannot share an allocation.");
  }
  if (equivalentCondition
      && assignedConditionTriple.includes("M_model_optimal")
      && assignedConditionTriple.includes(equivalentCondition)) {
    throw new Error("M and its visually identical D condition cannot share an allocation.");
  }
  const receivedAt = new Date().toISOString();
  return {
    event_id: eventId,
    participant_id: participantRow.participant_id,
    participant_slot: slot,
    set_id: setId,
    set_trial_index: setTrialIndex,
    global_trial_index: globalTrialIndex,
    document_id: documentId,
    condition_id: conditionId,
    enriched_file: record.enrichedFile,
    degree_value: degreeValue,
    baseline_side: record.baselineSide,
    document_exposure_number: setId,
    randomization_seed: record.randomizationSeed,
    rating: rating,
    response_time: responseTime,
    session_id: participantRow.session_id,
    study_id: participantRow.study_id,
    allocation_id: allocationId,
    enriched_side: record.enrichedSide,
    source_document_id: record.sourceDocumentId || "",
    stimulus_validation_status: record.validationStatus || "",
    visual_coverage: nullableNumber_(record.visualCoverage, "visual_coverage"),
    target_coverage: nullableNumber_(record.targetCoverage, "target_coverage"),
    retained_factor_count: nullableNumber_(record.retainedFactorCount, "retained_factor_count"),
    stimulus_sha256: nullableHash_(record.stimulusSha256, "stimulus_sha256"),
    visual_sha256: nullableHash_(record.visualSha256, "visual_sha256"),
    factor_ids_sha256: nullableHash_(record.factorIdsSha256, "factor_ids_sha256"),
    model_optimal_equivalent_condition_id: equivalentCondition,
    model_optimal_is_novel: nullableBoolean_(record.modelOptimalIsNovel, "model_optimal_is_novel"),
    fano_block_id: enumValue_(record.fanoBlockId, ["A", "B", "C", "D", "E", "F", "G"], "fano_block_id"),
    set_permutation_id: enumValue_(record.setPermutationId, ["123", "132", "213", "231", "312", "321"], "set_permutation_id"),
    assigned_condition_triple_json: assignedConditionTripleJson,
    within_document_visual_duplicate: false,
    spatial_rating: spatialRating,
    planned_fixation_ms: nonnegativeNumber_(record.plannedFixationMs, "planned_fixation_ms"),
    planned_exposure_ms: nonnegativeNumber_(record.plannedExposureMs, "planned_exposure_ms"),
    actual_exposure_ms: nonnegativeNumber_(record.actualExposureMs, "actual_exposure_ms"),
    preload_ms: nonnegativeNumber_(record.preloadMs, "preload_ms"),
    attempt_count: integerInRange_(record.attemptCount, 1, 100, "attempt_count"),
    stimulus_scale: nonnegativeNumber_(record.stimulusScale, "stimulus_scale"),
    source_viewport_width: nonnegativeNumber_(record.sourceViewportWidth, "source_viewport_width"),
    source_viewport_height: nonnegativeNumber_(record.sourceViewportHeight, "source_viewport_height"),
    fitted_content_height: nonnegativeNumber_(record.fittedContentHeight, "fitted_content_height"),
    left_content_height: nonnegativeNumber_(record.leftContentHeight, "left_content_height"),
    right_content_height: nonnegativeNumber_(record.rightContentHeight, "right_content_height"),
    trimmed_bottom_whitespace_px: nonnegativeNumber_(record.trimmedBottomWhitespacePx, "trimmed_bottom_whitespace_px"),
    fullscreen: Boolean(record.fullscreen),
    display_info_json: jsonCell_(record.displayInfo),
    responded_at: String(record.respondedAt || ""),
    study_version: studyVersion,
    received_at: receivedAt
  };
}

function appendEvent_(spreadsheet, event, payload, identity) {
  const sheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.events);
  ensureHeaders_(sheet, HEADERS.Events);
  const row = eventObject_(event, payload, identity);
  if (findIdentityEvent_(sheet, row.event_id, identity)) return;
  appendObjectRow_(sheet, HEADERS.Events, row);
}

function eventObject_(event, payload, identity) {
  const eventId = safeIdentifier_(event.eventId || payload.requestId || eventIdFromPayload_(payload, event.type || "event"), "event_id");
  return {
    event_id: eventId,
    participant_id: identity.participantId,
    session_id: identity.sessionId,
    study_id: identity.studyId,
    participant_slot: payload.participant && payload.participant.slot,
    event_type: event.type || payload.kind,
    event_timestamp: event.timestamp || event.answeredAt || new Date().toISOString(),
    completed_trials: payload.participantSummary && payload.participantSummary.completedTrials,
    detail_json: jsonCell_(event.detail || event),
    study_version: payload.studyVersion
  };
}

function trialCompleteness_(identity, expected) {
  const sheet = getOrCreateSheet_(getSpreadsheet_(), SHEET_NAMES.trials);
  ensureHeaders_(sheet, HEADERS.Trials);
  const indices = new Set(readSelectedTable_(sheet, [
    "participant_id", "session_id", "study_id", "global_trial_index"
  ]).rows
    .filter(function(row) {
      return row.participant_id === identity.participantId
        && row.session_id === identity.sessionId
        && row.study_id === identity.studyId
        && Number(row.global_trial_index) <= expected;
    })
    .map(function(row) { return Number(row.global_trial_index); }));
  const missing = [];
  for (let index = 1; index <= expected; index += 1) {
    if (!indices.has(index)) missing.push(index);
  }
  return { confirmedTrials: expected - missing.length, missing: missing };
}

function completionAudit_(spreadsheet, identity) {
  const trialSheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.trials);
  ensureHeaders_(trialSheet, HEADERS.Trials);
  const rows = readSelectedTable_(trialSheet, [
    "participant_id", "session_id", "study_id", "global_trial_index", "set_id"
  ]).rows.filter(function(row) {
    return row.participant_id === identity.participantId
      && row.session_id === identity.sessionId
      && row.study_id === identity.studyId;
  });
  const indexSet = new Set(rows.map(function(row) { return Number(row.global_trial_index); }));
  const missing = [];
  for (let index = 1; index <= 114; index += 1) if (!indexSet.has(index)) missing.push(index);
  const setCounts = [1, 2, 3].map(function(setId) {
    return rows.filter(function(row) { return Number(row.set_id) === setId; }).length;
  });

  const eventSheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.events);
  ensureHeaders_(eventSheet, HEADERS.Events);
  const events = readTable_(eventSheet).rows.filter(function(row) {
    return row.participant_id === identity.participantId
      && row.session_id === identity.sessionId
      && row.study_id === identity.studyId;
  });
  const passedAttentionPositions = new Set();
  const completedBreaks = new Set();
  events.forEach(function(row) {
    const detail = parseJsonCell_(row.detail_json);
    if (row.event_type === "attention_check" && detail.passed === true) {
      passedAttentionPositions.add(Number(detail.afterTrial));
    }
    if (row.event_type === "break_completed") {
      completedBreaks.add(Number(detail.setId || (detail.detail && detail.detail.setId)));
    }
  });
  const attentionChecksPassed = passedAttentionPositions.size;
  const completedBreakCount = completedBreaks.size;
  return {
    complete: rows.length === 114
      && missing.length === 0
      && setCounts.every(function(count) { return count === 38; })
      && attentionChecksPassed === 3
      && completedBreakCount === 2,
    trialCount: rows.length,
    setCounts: setCounts,
    missing: missing,
    attentionChecksPassed: attentionChecksPassed,
    completedBreaks: completedBreakCount
  };
}

function exportStudyLogs() {
  const spreadsheet = getSpreadsheet_();
  const sheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.trials);
  ensureHeaders_(sheet, HEADERS.Trials);
  const table = readTable_(sheet);
  const records = table.rows.map(function(row) {
    const object = {};
    HEADERS.Trials.forEach(function(header) { object[header] = serializable_(row[header]); });
    return object;
  });
  const csv = [HEADERS.Trials].concat(records.map(function(record) {
    return HEADERS.Trials.map(function(header) { return record[header]; });
  })).map(function(row) { return row.map(csvCell_).join(","); }).join("\n") + "\n";
  const json = JSON.stringify({
    schema_version: SCHEMA_VERSION,
    study_version: configuredStudyVersion_(),
    exported_at: new Date().toISOString(),
    record_count: records.length,
    columns: HEADERS.Trials,
    records: records
  }, null, 2) + "\n";
  const folder = getExportFolder_(spreadsheet);
  const csvFile = upsertTextFile_(folder, "text-enrichment-final-log.csv", csv, MimeType.CSV);
  const jsonFile = upsertTextFile_(folder, "text-enrichment-final-log.json", json, MimeType.PLAIN_TEXT);
  return { csvFileId: csvFile.getId(), jsonFileId: jsonFile.getId(), recordCount: records.length };
}

function releaseIncompleteSlot(participantId, studyId) {
  const identityParticipant = safeIdentifier_(participantId, "participant_id");
  const identityStudy = safeIdentifier_(studyId, "study_id");
  const studyVersion = configuredStudyVersion_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = getSpreadsheet_();
    const sheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.participants);
    ensureHeaders_(sheet, HEADERS.Participants);
    const row = readTable_(sheet).rows.find(function(item) {
      return item.participant_id === identityParticipant
        && item.study_id === identityStudy
        && item.study_version === studyVersion;
    });
    if (!row) throw new Error("Participant record not found.");
    if (row.status === "complete") throw new Error("A completed slot cannot be released.");
    const trialSheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.trials);
    ensureHeaders_(trialSheet, HEADERS.Trials);
    const partialCount = readTable_(trialSheet).rows.filter(function(trial) {
      return trial.participant_id === identityParticipant && trial.study_id === identityStudy;
    }).length;
    updateParticipantFields_(sheet, row._rowNumber, {
      participant_slot: "",
      status: partialCount ? "released_with_partial_data" : "released",
      last_seen_at: new Date().toISOString()
    });
    return { released: true, allocationId: row.allocation_id, partialTrialCount: partialCount };
  } finally {
    lock.releaseLock();
  }
}

function releaseInvalidCompletedSlot(participantId, studyId, invalidReason) {
  const identityParticipant = safeIdentifier_(participantId, "participant_id");
  const identityStudy = safeIdentifier_(studyId, "study_id");
  const reason = String(invalidReason || "").trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new Error("A 3–500 character invalidation reason is required.");
  }
  const studyVersion = configuredStudyVersion_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = getSpreadsheet_();
    const participantSheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.participants);
    ensureHeaders_(participantSheet, HEADERS.Participants);
    const row = readTable_(participantSheet).rows.find(function(item) {
      return item.participant_id === identityParticipant
        && item.study_id === identityStudy
        && item.study_version === studyVersion;
    });
    if (!row) throw new Error("Participant record not found.");
    if (row.status !== "complete") {
      throw new Error("Only a completed participant can use releaseInvalidCompletedSlot().");
    }
    const releasedSlot = Number(row.participant_slot);
    if (!releasedSlot) throw new Error("Completed participant has no allocation slot.");
    const releasedAllocationId = row.allocation_id;
    const timestamp = new Date().toISOString();
    updateParticipantFields_(participantSheet, row._rowNumber, {
      participant_slot: "",
      status: "released_invalid_complete",
      last_seen_at: timestamp
    });

    const eventSheet = getOrCreateSheet_(spreadsheet, SHEET_NAMES.events);
    ensureHeaders_(eventSheet, HEADERS.Events);
    appendObjectRow_(eventSheet, HEADERS.Events, {
      event_id: "slot_invalidated_" + Utilities.getUuid().replace(/-/g, ""),
      participant_id: row.participant_id,
      session_id: row.session_id,
      study_id: row.study_id,
      participant_slot: releasedSlot,
      event_type: "slot_invalidated_after_completion",
      event_timestamp: timestamp,
      completed_trials: Number(row.completed_trials) || STUDY_DESIGN.trialsPerParticipant,
      detail_json: JSON.stringify({
        allocationId: releasedAllocationId,
        invalidReason: reason,
        priorStatus: "complete"
      }),
      study_version: studyVersion
    });
    return {
      released: true,
      invalidatedCompletedParticipant: true,
      slot: releasedSlot,
      allocationId: releasedAllocationId,
      reason: reason
    };
  } finally {
    lock.releaseLock();
  }
}

function validateParticipantAllocation_(participantRow, participant, kind) {
  if (!["trial", "final", "snapshot"].includes(kind)) return;
  if (!Number(participantRow.participant_slot)) throw new Error("Participant slot has not been reserved.");
  if (Number(participant.slot) !== Number(participantRow.participant_slot)) throw new Error("Participant slot mismatch.");
  if (participant.allocationId !== participantRow.allocation_id) throw new Error("Allocation identifier mismatch.");
  if (participant.assignmentVersion !== STUDY_DESIGN.assignmentVersion) throw new Error("Assignment version mismatch.");
}

function allocationIdForSlot_(slot) {
  return STUDY_DESIGN.assignmentVersion + "-slot-" + String(slot).padStart(2, "0");
}

function identityEventIds_(sheet, identity) {
  if (sheet.getLastRow() < 2) return new Set();
  // Event IDs include the study/session identity and are the idempotency key. Reading
  // column A once avoids scanning the wide Trials table for every item in a batch.
  return new Set(sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
    .map(function(row) { return String(row[0]); })
    .filter(Boolean));
}

function findIdentityEvent_(sheet, eventId, identity) {
  if (sheet.getLastRow() < 2) return null;
  const matches = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
    .createTextFinder(eventId)
    .matchEntireCell(true)
    .findAll();
  if (!matches.length) return null;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  for (let index = 0; index < matches.length; index += 1) {
    const values = sheet.getRange(matches[index].getRow(), 1, 1, headers.length).getValues()[0];
    const row = {};
    headers.forEach(function(header, column) { row[header] = values[column]; });
    if (row.participant_id === identity.participantId
      && (!row.study_id || row.study_id === identity.studyId)
      && (!row.session_id || row.session_id === identity.sessionId)) return row;
  }
  return null;
}

function eventIdFromPayload_(payload, label) {
  const participant = payload.participant || {};
  const value = [payload.studyVersion, participant.sessionId, label, new Date().getTime()].join(":");
  return deterministicEventId_(label, [value]);
}

function deterministicEventId_(label, values) {
  const value = values.join(":");
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value);
  const hex = digest.map(function(byte) { return (byte + 256).toString(16).slice(-2); }).join("");
  return label + "_" + hex.slice(0, 16);
}

function getSpreadsheet_() {
  const propertyId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (propertyId) return SpreadsheetApp.openById(propertyId);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error("Bind this script to the study spreadsheet or set SPREADSHEET_ID.");
  return active;
}

function getExportFolder_(spreadsheet) {
  const folderId = PropertiesService.getScriptProperties().getProperty("EXPORT_FOLDER_ID");
  if (folderId) return DriveApp.getFolderById(folderId);
  const parents = DriveApp.getFileById(spreadsheet.getId()).getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}

function upsertTextFile_(folder, name, content, mimeType) {
  const matches = folder.getFilesByName(name);
  if (matches.hasNext()) {
    const file = matches.next();
    file.setContent(content);
    return file;
  }
  return folder.createFile(name, content, mimeType);
}

function getOrCreateSheet_(spreadsheet, name) {
  return spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
}

function ensureHeaders_(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return;
  }
  const existing = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  for (let index = 0; index < existing.length; index += 1) {
    if (existing[index] !== headers[index]) {
      throw new Error("Unexpected header order in " + sheet.getName() + " at column " + String(index + 1) + ". Use the Study 3 workbook schema.");
    }
  }
  if (existing.length < headers.length) {
    sheet.getRange(1, existing.length + 1, 1, headers.length - existing.length)
      .setValues([headers.slice(existing.length)]);
  }
}

function readTable_(sheet) {
  if (sheet.getLastRow() < 1) return { headers: [], rows: [] };
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const rows = values.slice(1).map(function(valuesRow, index) {
    const row = { _rowNumber: index + 2 };
    headers.forEach(function(header, column) { row[header] = valuesRow[column]; });
    return row;
  });
  return { headers: headers, rows: rows };
}

function readSelectedTable_(sheet, selectedHeaders) {
  if (sheet.getLastRow() < 1) return { headers: selectedHeaders, rows: [] };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const columns = selectedHeaders.map(function(header) {
    const column = headers.indexOf(header);
    if (column < 0) throw new Error("Missing required column " + header + " in " + sheet.getName() + ".");
    return column;
  });
  if (sheet.getLastRow() < 2) return { headers: selectedHeaders, rows: [] };
  const width = Math.max.apply(null, columns) + 1;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
  const rows = values.map(function(valuesRow, index) {
    const row = { _rowNumber: index + 2 };
    selectedHeaders.forEach(function(header, selectedIndex) {
      row[header] = valuesRow[columns[selectedIndex]];
    });
    return row;
  });
  return { headers: selectedHeaders, rows: rows };
}

function appendObjectRow_(sheet, headers, object) {
  appendObjectRows_(sheet, headers, [object]);
}

function appendObjectRows_(sheet, headers, objects) {
  if (!sheet || !objects || !objects.length) return;
  const values = objects.map(function(object) {
    return headers.map(function(header) { return safeCell_(object[header]); });
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, headers.length).setValues(values);
}

function updateParticipantFields_(sheet, rowNumber, fields) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  const rowRange = sheet.getRange(rowNumber, 1, 1, headers.length);
  const values = rowRange.getValues()[0];
  let changed = false;
  Object.keys(fields).forEach(function(key) {
    const column = headers.indexOf(key);
    if (column >= 0 && fields[key] !== undefined) {
      values[column] = safeCell_(fields[key]);
      changed = true;
    }
  });
  if (changed) rowRange.setValues([values]);
}

function recordConfirmationCache_() {
  return CacheService.getScriptCache();
}

function recordConfirmationKey_(type, eventId, identity) {
  return ["record", type, identity.participantId, identity.studyId, identity.sessionId, eventId].join(":");
}

function rememberRecordConfirmation_(type, eventId, identity) {
  if (!eventId) return;
  recordConfirmationCache_().put(recordConfirmationKey_(type, eventId, identity), "1", 21600);
}

function validateIdentity_(parameters) {
  return {
    participantId: safeIdentifier_(parameters.participant_id, "participant_id"),
    studyId: safeIdentifier_(parameters.study_id, "study_id"),
    sessionId: safeIdentifier_(parameters.session_id, "session_id")
  };
}

function safeIdentifier_(value, field) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(text)) throw new Error("Invalid " + field + ".");
  return text;
}

function verifyStudyVersion_(version) {
  const text = safeIdentifier_(version, "study_version");
  const expected = configuredStudyVersion_();
  if (expected && expected !== text) throw new Error("Study version mismatch.");
  return text;
}

function configuredStudyVersion_() {
  return PropertiesService.getScriptProperties().getProperty("STUDY_VERSION") || "2026-09-08-study3-v2";
}

function integerInRange_(value, minimum, maximum, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error("Invalid " + field + ".");
  return number;
}

function numberInRange_(value, minimum, maximum, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new Error("Invalid " + field + ".");
  return number;
}

function nonnegativeNumber_(value, field) {
  return numberInRange_(value, 0, Number.MAX_SAFE_INTEGER, field);
}

function nullableNumber_(value, field) {
  if (value === undefined || value === null || value === "") return "";
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Invalid " + field + ".");
  return number;
}

function nullableHash_(value, field) {
  if (value === undefined || value === null || value === "") return "";
  const text = String(value);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error("Invalid " + field + ".");
  return text;
}

function nullableBoolean_(value, field) {
  if (value === undefined || value === null || value === "") return "";
  if (value !== true && value !== false) throw new Error("Invalid " + field + ".");
  return value;
}

function nullableCondition_(value) {
  if (value === undefined || value === null || value === "") return "";
  const text = String(value);
  if (!STUDY_DESIGN.conditions.includes(text) || text === "M_model_optimal") {
    throw new Error("Invalid model_optimal_equivalent_condition_id.");
  }
  return text;
}

function enumValue_(value, allowed, field) {
  const text = String(value || "");
  if (!allowed.includes(text)) throw new Error("Invalid " + field + ".");
  return text;
}

function validatedConditionTriple_(value) {
  if (!Array.isArray(value) || value.length !== 3 || new Set(value).size !== 3
      || value.some(function(condition) { return !STUDY_DESIGN.conditions.includes(condition); })) {
    throw new Error("Invalid assigned_condition_triple.");
  }
  return JSON.stringify(value);
}

function jsonCell_(value) {
  if (value === undefined || value === null) return "";
  const text = JSON.stringify(value);
  return text.length > 49000 ? JSON.stringify({ truncated: true, prefix: text.slice(0, 48000) }) : text;
}

function parseJsonCell_(value) {
  if (!value) return {};
  try { return typeof value === "string" ? JSON.parse(value) : value; } catch (error) { return {}; }
}

function safeCell_(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" && /^[=+@]/.test(value)) return "'" + value;
  return value;
}

function blankRow_(headers) {
  return Object.fromEntries(headers.map(function(header) { return [header, ""]; }));
}

function objectFromHeaders_(headers, object) {
  const result = {};
  headers.forEach(function(header) { result[header] = serializable_(object[header]); });
  return result;
}

function serializable_(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function csvCell_(value) {
  if (value === undefined || value === null) return "";
  const text = String(serializable_(value));
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function output_(object, callback) {
  const json = JSON.stringify(object).replace(/</g, "\\u003c");
  if (callback && /^[A-Za-z_$][A-Za-z0-9_$]{0,100}$/.test(callback)) {
    return ContentService.createTextOutput(callback + "(" + json + ");")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

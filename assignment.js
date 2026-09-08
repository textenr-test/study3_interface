export function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const MAX_PARTICIPANT_SLOT = 35;

export function mulberry32(seed) {
  return function random() {
    let t = seed += 0x6d2b79f5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(items, seedText) {
  const output = [...items];
  const random = mulberry32(hashString(seedText));
  for (let i = output.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [output[i], output[j]] = [output[j], output[i]];
  }
  return output;
}

export function validateAssignmentPayload(payload, expectations = {}) {
  const participantSlot = Number(payload?.participant_slot);
  if (!Number.isInteger(participantSlot) || participantSlot < 1 || participantSlot > MAX_PARTICIPANT_SLOT) {
    throw new Error("The pre-generated participant slot is invalid.");
  }
  if (expectations.participantSlot && participantSlot !== Number(expectations.participantSlot)) {
    throw new Error("The requested participant slot does not match the allocation file.");
  }
  if (expectations.studyVersion && payload.study_version !== expectations.studyVersion) {
    throw new Error("The allocation study version does not match this deployment.");
  }
  if (expectations.assignmentVersion && payload.assignment_version !== expectations.assignmentVersion) {
    throw new Error("The allocation version does not match this deployment.");
  }
  if (!Array.isArray(payload.trials) || payload.trials.length !== 114) {
    throw new Error("The pre-generated allocation must contain 114 trials.");
  }
  if (!Array.isArray(payload.attention_checks) || payload.attention_checks.length !== 3) {
    throw new Error("The allocation must contain three slot-specific attention checks.");
  }
  const seenGlobal = new Set();
  const perSet = new Map();
  const perDocument = new Map();
  for (const row of payload.trials) {
    if (Number(row.participant_slot) !== participantSlot) throw new Error("Allocation slot changed within the file.");
    if (!Number.isInteger(row.set_id) || row.set_id < 1 || row.set_id > 3) throw new Error("Invalid set identifier.");
    if (!Number.isInteger(row.set_trial_index) || row.set_trial_index < 1 || row.set_trial_index > 38) {
      throw new Error("Invalid within-set trial index.");
    }
    const expectedGlobal = (row.set_id - 1) * 38 + row.set_trial_index;
    if (row.global_trial_index !== expectedGlobal || seenGlobal.has(row.global_trial_index)) {
      throw new Error("Invalid or repeated global trial index.");
    }
    seenGlobal.add(row.global_trial_index);
    perSet.set(row.set_id, (perSet.get(row.set_id) || 0) + 1);
    if (!Array.isArray(row.assigned_condition_triple)
      || row.assigned_condition_triple.length !== 3
      || new Set(row.assigned_condition_triple).size !== 3
      || !row.assigned_condition_triple.includes(row.condition_id)) {
      throw new Error("Invalid assigned condition triple.");
    }
    if (row.within_document_visual_duplicate !== false) {
      throw new Error("M and its visually identical D condition must never share a participant-document allocation.");
    }
    const tripleKey = [...row.assigned_condition_triple].sort().join("|");
    const equivalent = row.model_optimal_equivalent_condition_id || "";
    const documentSummary = perDocument.get(row.document_id) || {
      conditions: new Set(),
      tripleKey,
      equivalent
    };
    if (documentSummary.tripleKey !== tripleKey || documentSummary.equivalent !== equivalent) {
      throw new Error("Document allocation metadata changed across sets.");
    }
    documentSummary.conditions.add(row.condition_id);
    perDocument.set(row.document_id, documentSummary);
    if (!/^(left|right)$/.test(row.baseline_side) || row.baseline_side === row.enriched_side) {
      throw new Error("Invalid left/right allocation.");
    }
  }
  if ([1, 2, 3].some((setId) => perSet.get(setId) !== 38)) throw new Error("Each set must contain 38 trials.");
  if (perDocument.size !== 38 || [...perDocument.values()].some((summary) => summary.conditions.size !== 3)) {
    throw new Error("Each document must use three distinct enriched conditions.");
  }
  for (const summary of perDocument.values()) {
    const observedKey = [...summary.conditions].sort().join("|");
    if (observedKey !== summary.tripleKey) throw new Error("Document conditions do not match the assigned triple.");
    const triple = summary.tripleKey.split("|");
    if (summary.equivalent && triple.includes("M_model_optimal") && triple.includes(summary.equivalent)) {
      throw new Error("M and its visually identical D condition must never share a participant-document allocation.");
    }
  }
  return payload;
}

export async function loadParticipantAssignment({ participantSlot, studyVersion, assignmentVersion }) {
  if (!Number.isInteger(participantSlot) || participantSlot < 1 || participantSlot > MAX_PARTICIPANT_SLOT) {
    throw new Error("participantSlot must be an integer from 1 to 35");
  }
  const filename = `slot-${String(participantSlot).padStart(2, "0")}.json`;
  const response = await fetch(`./assignments/slots/${filename}?v=${encodeURIComponent(studyVersion)}`, { cache: "force-cache" });
  if (!response.ok) throw new Error(`Could not load the pre-generated allocation for slot ${participantSlot}.`);
  const payload = validateAssignmentPayload(await response.json(), {
    participantSlot,
    studyVersion,
    assignmentVersion
  });
  return {
    allocationId: payload.allocation_id,
    participantSlot,
    assignmentVersion: payload.assignment_version,
    assignmentSeed: payload.assignment_seed,
    allocationSha256: payload.allocation_sha256,
    attentionChecks: payload.attention_checks.map((check) => ({
      setId: check.set_id,
      withinSetAfterTrial: check.within_set_after_trial,
      afterTrial: check.after_trial,
      response: check.response
    })),
    trials: payload.trials.map((row) => ({
      allocationId: row.allocation_id,
      participantSlot: row.participant_slot,
      setId: row.set_id,
      setTrialIndex: row.set_trial_index,
      globalTrialIndex: row.global_trial_index,
      docId: row.document_id,
      documentIndex: row.document_index,
      conditionId: row.condition_id,
      enrichedFile: row.enriched_file,
      degreeValue: row.degree_value,
      baselineSide: row.baseline_side,
      enrichedSide: row.enriched_side,
      documentExposureNumber: row.document_exposure_number,
      randomizationSeed: row.randomization_seed,
      fanoBlockId: row.fano_block_id,
      setPermutationId: row.set_permutation_id,
      setPermutationParity: row.set_permutation_parity,
      assignedConditionTriple: row.assigned_condition_triple,
      modelOptimalEquivalentConditionId: row.model_optimal_equivalent_condition_id,
      withinDocumentVisualDuplicate: row.within_document_visual_duplicate,
      assignmentVersion: row.assignment_version,
      studyVersion: row.study_version,
      trialOrder: row.global_trial_index - 1
    }))
  };
}

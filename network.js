export function collectorHealthProblems(health, expected) {
  const problems = [];
  if (!health?.ok) problems.push(health?.error || "The data service health check failed.");
  if (health?.service !== expected.service) problems.push("Unexpected data service.");
  if (health?.collectorVersion !== expected.collectorVersion) problems.push("Collector release mismatch.");
  if (health?.studyVersion !== expected.studyVersion) problems.push("Study version mismatch.");
  if (health?.assignmentVersion !== expected.assignmentVersion) problems.push("Assignment version mismatch.");
  if (health?.schemaVersion !== expected.schemaVersion) problems.push("Data schema mismatch.");
  return problems;
}

export function buildUploadBatch(items, options) {
  return {
    kind: "batch",
    batchId: options.batchId,
    collectorVersion: options.collectorVersion,
    studyVersion: options.studyVersion,
    participant: options.participant,
    items: items.map((item) => item.payload)
  };
}

export async function postFormWithTimeout(fetchImplementation, endpoint, payload, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const body = new URLSearchParams({ payload: JSON.stringify(payload) });
  try {
    return await fetchImplementation(endpoint, {
      method: "POST",
      mode: "no-cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`The data upload timed out after ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}


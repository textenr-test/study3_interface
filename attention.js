export function expectedAttentionResponse(afterTrial, attentionChecks) {
  const check = attentionChecks.find((item) => item.afterTrial === afterTrial);
  if (check && Number.isInteger(check.response) && check.response >= -3 && check.response <= 3) {
    return check.response;
  }
  throw new Error("Unknown attention-check position");
}


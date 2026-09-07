const ROUTES = Object.freeze({
  eligibility_criteria: Object.freeze({
    redirectKey: "screenedOut",
    status: "screened_out",
    heading: "This study is not a match for you.",
    message: "Thank you for completing the brief eligibility section. You will now return to Prolific, where the configured screen-out payment will be applied."
  }),
  incompatible_device: Object.freeze({
    redirectKey: "incompatibleDevice",
    status: "return_requested_incompatible_device",
    heading: "This device is not compatible with the study.",
    message: "This task must be completed on a compatible laptop or desktop computer. You will now return to Prolific, where you will be asked to return your submission."
  }),
  failed_comprehension_twice: Object.freeze({
    redirectKey: "failedComprehension",
    status: "return_requested_failed_comprehension",
    heading: "The instruction check was not passed.",
    message: "You have used both attempts for the instruction check. You will now return to Prolific, where you will be asked to return your submission."
  })
});

export function resolveEarlyExitRoute(reason) {
  const route = ROUTES[reason];
  if (!route) throw new Error(`Unknown early-exit reason: ${reason}`);
  return route;
}


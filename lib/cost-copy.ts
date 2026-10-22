// Plain-language explanations for the reason/blocker codes the cost API returns.
// The server decides WHETHER a figure may be stated; this only says why not.
export const PROFIT_REASON: Record<string, string> = {
  no_revenue: "this job has no quote to measure against",
  mixed_currencies: "costs are in more than one currency, and margin is never blended across currencies",
  no_actual_cost: "no cost has been recorded against this job",
  no_good_output: "no good output has been recorded, so there is nothing to divide the cost by",
  job_not_completed: "margin is only stated once the job is completed; until then cost is still accumulating",
  uncosted_issues: "some material movements have no recorded cost",
  no_material_cost: "no material cost has been recorded",
  no_labour_recorded: "no labour has been recorded, so cost is incomplete",
};

export const VARIANCE_REASON: Record<string, string> = {
  job_in_progress: "after completion",
  estimate_incomplete: "estimate incomplete",
  no_estimate: "no estimate",
  no_estimate_in_currency: "not estimated in this currency",
  uncosted_issues: "uncosted issues",
  no_material_cost: "no material recorded",
};

export const EXPLANATION_REASON: Record<string, string> = {
  unpriced: "no standard cost, so the estimate can't be compared",
  unit_mismatch: "the BOM unit differs from the stock unit",
  currency_differs: "stock was costed in a different currency from the standard",
  multiple_currencies: "issued from stock costed in more than one currency",
};

export const COMPONENT_LABEL: Record<string, string> = {
  job: "Job",
  estimate: "Estimate",
  material: "Material",
  labour: "Labour",
  overhead: "Overhead",
};

export const RATE_BASIS_LABEL: Record<string, string> = {
  as_of_completion: "Rate in force at completion (and already on record then)",
  as_of_date: "Rate in force on the chosen date",
  latest: "Latest recorded rate (job not completed)",
};

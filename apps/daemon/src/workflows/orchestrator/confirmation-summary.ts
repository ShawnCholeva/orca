import type {
  ConfirmationSummary as ConfirmationSummaryT,
  StepResultScoringProposal,
  WorkflowStepOutputSchema,
} from "@orca/contracts";

function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, " ").trim();
  return spaced.length === 0 ? key : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function fieldValue(raw: unknown): string | string[] | null {
  if (typeof raw === "string") {
    const t = raw.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (Array.isArray(raw)) {
    const items = raw
      .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map((v) => String(v).trim())
      .filter((v) => v.length > 0);
    return items.length > 0 ? items : null;
  }
  return null; // objects / null are omitted
}

/** Returns the lead text for a confirmation card — the same formula used in both
 *  the live card and the confirm-pause snapshot so neither site can drift. */
export function confirmationLead(
  scoringReason: string | undefined,
  proposal: string | null
): string {
  return scoringReason?.trim() || proposal?.trim() || "Step complete.";
}

/** Builds the structured confirmation-card payload from a step's recorded output
 *  block and the mediator's scoring. Empty/missing fields and the internal
 *  `_completion` key are omitted so the card never shows a blank label. */
export function buildConfirmationSummary(
  outputSchema: WorkflowStepOutputSchema,
  block: unknown,
  scoring: StepResultScoringProposal | null,
  proposal: string | null
): ConfirmationSummaryT {
  const obj = (block ?? {}) as Record<string, unknown>;
  const fields: ConfirmationSummaryT["fields"] = [];
  for (const field of outputSchema) {
    if (field.key === "_completion") continue;
    const value = fieldValue(obj[field.key]);
    if (value === null) continue;
    fields.push({ label: humanizeKey(field.key), value });
  }
  const lead = confirmationLead(scoring?.reason, proposal);
  return { lead, fields, scoring };
}

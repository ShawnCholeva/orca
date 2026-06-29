import type {
  ConfirmationSummary as ConfirmationSummaryT,
  StepResultScoringProposal,
  WorkflowStepOutputField,
  WorkflowStepOutputSchema,
} from "@orca/contracts";
import type { StepSplitterRouting } from "../graph/graph-routing.js";

type CardField = ConfirmationSummaryT["fields"][number];

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
  return null; // primitives only; objects are handled by flattenField
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}

// Serialize an object's primitive leaves into one compact line ("File: a.ts · Risk: low")
// so deeper/opaque structures still render instead of being silently dropped.
function objectToLine(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(obj)) {
    const value = fieldValue(raw);
    if (value === null) continue;
    parts.push(`${humanizeKey(key)}: ${Array.isArray(value) ? value.join(", ") : value}`);
  }
  return parts.join(" · ");
}

// Project one schema field + its value into zero or more card rows. Nested objects
// recurse into composite-labeled rows (matching the validator's 2-level depth);
// arrays of objects render one compact line per item; primitives pass through.
function flattenField(
  field: WorkflowStepOutputField,
  raw: unknown,
  labelPrefix: string,
  depth: number,
  out: CardField[]
): void {
  const label = labelPrefix ? `${labelPrefix} · ${humanizeKey(field.key)}` : humanizeKey(field.key);

  if (field.type === "object" && isPlainObject(raw)) {
    if (field.fields && field.fields.length > 0 && depth > 0) {
      for (const child of field.fields) {
        flattenField(child, raw[child.key], label, depth - 1, out);
      }
      return;
    }
    const line = objectToLine(raw);
    if (line.length > 0) out.push({ label, value: line });
    return;
  }

  if (field.type === "array" && field.itemType === "object" && Array.isArray(raw)) {
    const items = raw
      .filter(isPlainObject)
      .map(objectToLine)
      .filter((line) => line.length > 0);
    if (items.length > 0) out.push({ label, value: items });
    return;
  }

  const value = fieldValue(raw);
  if (value !== null) out.push({ label, value });
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
  proposal: string | null,
  routing: StepSplitterRouting | null = null
): ConfirmationSummaryT {
  const obj = (block ?? {}) as Record<string, unknown>;
  const fields: CardField[] = [];
  for (const field of outputSchema) {
    if (field.key === "_completion") continue;
    // A field that feeds a downstream splitter (e.g. Triage's `recommended_tier`)
    // is a routing decision; show the destination step's name instead of the raw
    // branch token so the user reads "Recommended step: Proposal", not the tier.
    if (routing && field.key === routing.branchKey) {
      const raw = obj[field.key];
      const name = typeof raw === "string" ? routing.branchToName[raw.trim()] : undefined;
      if (name) {
        fields.push({ label: "Recommended step", value: name });
        continue;
      }
    }
    flattenField(field, obj[field.key], "", 1, fields);
  }
  const lead = confirmationLead(scoring?.reason, proposal);
  return { lead, fields: fields.slice(0, 32), scoring };
}

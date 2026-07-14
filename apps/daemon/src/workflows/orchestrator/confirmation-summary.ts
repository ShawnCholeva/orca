import type {
  ConfirmationSummary as ConfirmationSummaryT,
  ConfirmationSummaryEvidence,
  ConfirmationSummaryRefute,
  EvidenceFacet,
  StoredStepResultScoring,
  WorkflowStepOutputField,
  WorkflowStepOutputSchema,
} from "@orca/contracts";
import type { StepSplitterRouting } from "../graph/graph-routing.js";

// The single structural check a reasoning step (no executable oracle) carries:
// reaching the confirmation pause deterministically proves schema validation
// passed. Honest and clearly scoped as structure-only — never a fake test pass.
const STRUCTURE_CHECK: ConfirmationSummaryEvidence["checks"][number] = {
  name: "Output structure",
  status: "passed",
  kind: "structural",
  detail: "all required fields present",
};

/** Project a step's deterministic EvidenceFacet into the confirmation card's
 *  evidence bundle (paper p.62). `executed` is true only when a real sensor ran,
 *  so reasoning steps (facet null) read "no executable checks". Sensor results
 *  are the strong tier; enforced grounding checks are the structural tier. */
function buildEvidenceBundle(facet: EvidenceFacet | null): ConfirmationSummaryEvidence {
  if (!facet) {
    return { executed: false, checks: [STRUCTURE_CHECK], cantVerify: [] };
  }
  const checks: ConfirmationSummaryEvidence["checks"] = [];
  for (const s of facet.sensorsRun) {
    checks.push({
      name: s.kind,
      status: s.result === "failed" ? "failed" : s.result === "passed" ? "passed" : "warn",
      kind: "execution",
      detail: s.summary.trim().slice(0, 512) || null,
    });
  }
  for (const g of facet.grounding?.checks ?? []) {
    if (g.mode !== "enforce" || g.result === "skipped") continue;
    checks.push({
      name: g.field,
      status: g.result === "failed" ? "failed" : "passed",
      kind: "grounding",
      detail: g.detail.trim().slice(0, 512) || null,
    });
  }
  if (checks.length === 0) checks.push(STRUCTURE_CHECK);
  const cantVerify = [...facet.oracleAdequacy.gaps, ...facet.untestedRegions].slice(0, 32);
  return { executed: facet.sensorsRun.length > 0, checks: checks.slice(0, 32), cantVerify };
}

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
 *  the live card and the confirm-pause snapshot so neither site can drift. When an
 *  independent refute ran and did not uphold the completion, its verdict is
 *  prepended as an advisory (5.4 L4 — human stays authoritative; see design doc
 *  §6) so the human reviewer sees the second opinion before the base lead. */
export function confirmationLead(
  scoringReason: string | undefined,
  proposal: string | null,
  refute?: ConfirmationSummaryRefute | null
): string {
  const lead = scoringReason?.trim() || proposal?.trim() || "Step complete.";
  if (!refute || refute.verdict === "upheld") return lead;
  // "unavailable" means the refute call itself failed (reason is always null),
  // so it gets its own phrasing and NO reason clause. For refuted/uncertain the
  // reason clause is appended only when a reason is present — never interpolate
  // a null (which would render the literal string "null").
  if (refute.verdict === "unavailable") {
    return `⚠️ Independent review could not be completed for this step.\n${lead}`;
  }
  const verb = refute.verdict === "refuted" ? "disputes" : "is uncertain about";
  const reasonClause = refute.reason ? `: ${refute.reason}` : "";
  return `⚠️ Independent review ${verb} this completion${reasonClause}\n${lead}`;
}

/** Builds the structured confirmation-card payload from a step's recorded output
 *  block and the mediator's scoring. Empty/missing fields and the internal
 *  `_completion` key are omitted so the card never shows a blank label. */
export function buildConfirmationSummary(
  outputSchema: WorkflowStepOutputSchema,
  block: unknown,
  scoring: StoredStepResultScoring | null,
  proposal: string | null,
  routing: StepSplitterRouting | null = null,
  refute: ConfirmationSummaryT["refute"] = null,
  // `undefined` = omit the bundle (the persisted result card); `null` = a
  // reasoning step with no facet (structural bundle); a facet = real evidence.
  evidence: EvidenceFacet | null | undefined = undefined
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
  const lead = confirmationLead(scoring?.reason, proposal, refute ?? null);
  return {
    lead,
    fields: fields.slice(0, 32),
    scoring,
    refute: refute ?? null,
    ...(evidence !== undefined ? { evidence: buildEvidenceBundle(evidence) } : {}),
  };
}

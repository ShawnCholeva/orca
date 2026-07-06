import type Database from "better-sqlite3";
import {
  getProposal, updateProposalDecision, supersedeOtherPending, supersedeAppliedForTemplate,
  captureBaseline, getBaseline, markBaselineRestored,
} from "./store.js";
import { recordEvent, currentTemplateVersion } from "./events.js";
import { parseSchema, validateSchemaTightening } from "./schema-mutation.js";
import type { TemplateInstructionProposal, WorkflowStepOutputSchema, RollbackOutcomeSnapshot } from "@orca/contracts";

export class StaleProposalError extends Error {}
export class ProposalNotPendingError extends Error {}
export class ProposalNotAppliedError extends Error {}
export class NoBaselineError extends Error {}
export class StepNotFoundError extends Error {}
export class InvalidSchemaEditError extends Error {}

interface TemplateRow { version: number; steps_json: string; is_built_in: number }

function readTemplate(db: Database.Database, templateId: string): TemplateRow | undefined {
  return db.prepare(`SELECT version, steps_json, is_built_in FROM workflow_templates WHERE id = ?`).get(templateId) as TemplateRow | undefined;
}

// Privileged in-place write — bypasses the is_locked/is_built_in guard the generic PATCH enforces.
// MUST only be called from applyLearnedInstructionEdit or rollbackAppliedProposal, which enforce the
// proposal guards. Do not import and call this directly from outside the learning module.
function setStepInstructionsInPlace(db: Database.Database, templateId: string, stepTemplateId: string, instructions: string, now: string): number {
  const tpl = readTemplate(db, templateId);
  if (!tpl) throw new StepNotFoundError(`template ${templateId} not found`);
  const steps = JSON.parse(tpl.steps_json) as { id: string; instructions?: string }[];
  const step = steps.find((s) => s.id === stepTemplateId);
  if (!step) throw new StepNotFoundError(`step ${stepTemplateId} not in template ${templateId}`);
  step.instructions = instructions;
  const newVersion = tpl.version + 1;
  db.prepare(`UPDATE workflow_templates SET steps_json = ?, version = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(steps), newVersion, now, templateId);
  return newVersion;
}

// Sibling of setStepInstructionsInPlace — same privileged-write discipline and caveats.
function setStepOutputSchemaInPlace(db: Database.Database, templateId: string, stepTemplateId: string, schema: WorkflowStepOutputSchema, now: string): number {
  const tpl = readTemplate(db, templateId);
  if (!tpl) throw new StepNotFoundError(`template ${templateId} not found`);
  const steps = JSON.parse(tpl.steps_json) as { id: string; outputSchema?: unknown }[];
  const step = steps.find((s) => s.id === stepTemplateId);
  if (!step) throw new StepNotFoundError(`step ${stepTemplateId} not in template ${templateId}`);
  step.outputSchema = schema;
  const newVersion = tpl.version + 1;
  db.prepare(`UPDATE workflow_templates SET steps_json = ?, version = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(steps), newVersion, now, templateId);
  return newVersion;
}

// Resolve + validate the final text for a proposal per its component. For schema
// proposals a human edit must still be a valid, pure tightening of the BEFORE
// schema — an invalid edit can never be written. MUST be called before the staleness
// guard so a bad edit never triggers supersede-on-throw either.
function resolveFinalWrite(p: TemplateInstructionProposal, editedText: string | undefined): { finalText: string; write: (db: Database.Database, now: string) => number } {
  const finalText = editedText ?? p.afterInstructions;
  if (p.component === "step_output_schema") {
    const before = parseSchema(p.beforeInstructions);
    // Unreachable for stored rows (contract superRefine guarantees a parseable
    // before), but a permissive [] here would let ANY edit pass the whitelist —
    // throw instead, symmetric with rollback's mustParseStoredSchema.
    if (!before) throw new InvalidSchemaEditError("stored before-schema is unparseable — refusing to validate an edit against nothing");
    const after = parseSchema(finalText);
    if (!after) throw new InvalidSchemaEditError("edited schema is not a valid output schema (must be the JSON field list)");
    const t = validateSchemaTightening(before, after);
    if (!t.ok) throw new InvalidSchemaEditError(`edited schema is not a pure tightening: ${t.errors.join("; ")}`);
    return { finalText, write: (db, now) => setStepOutputSchemaInPlace(db, p.templateId, p.stepTemplateId, after, now) };
  }
  return { finalText, write: (db, now) => setStepInstructionsInPlace(db, p.templateId, p.stepTemplateId, finalText, now) };
}

// The contract's superRefine on TemplateInstructionProposal makes an unparseable stored
// beforeInstructions impossible for step_output_schema rows; this is a defensive hard-stop.
function mustParseStoredSchema(proposalId: string, text: string): WorkflowStepOutputSchema {
  const parsed = parseSchema(text);
  if (!parsed) throw new StepNotFoundError(`proposal ${proposalId} has an unparseable stored schema`);
  return parsed;
}

// Overwrite all steps (restore path).
function setStepsJsonInPlace(db: Database.Database, templateId: string, stepsJson: string, now: string): number {
  const tpl = readTemplate(db, templateId);
  if (!tpl) throw new StepNotFoundError(`template ${templateId} not found`);
  const newVersion = tpl.version + 1;
  db.prepare(`UPDATE workflow_templates SET steps_json = ?, version = ?, updated_at = ? WHERE id = ?`)
    .run(stepsJson, newVersion, now, templateId);
  return newVersion;
}

export function applyLearnedInstructionEdit(
  db: Database.Database, proposalId: string,
  opts: { editedInstructions?: string; decidedBy: string; now: string },
): { newVersion: number } {
  const p = getProposal(db, proposalId);
  if (!p) throw new StepNotFoundError(`proposal ${proposalId} not found`);
  if (p.status !== "pending") throw new ProposalNotPendingError(`proposal ${proposalId} is ${p.status}`);
  const tpl = readTemplate(db, p.templateId);
  if (!tpl) throw new StepNotFoundError(`template ${p.templateId} not found`);
  // Resolve + validate the final write BEFORE the staleness guard: an invalid edit must
  // leave the proposal fully untouched — it must never trigger supersede-on-throw either.
  const resolved = resolveFinalWrite(p, opts.editedInstructions);
  // Staleness guard — MUST stay outside the transaction so the supersede write persists on throw.
  if (tpl.version !== p.templateVersionAtProposal) {
    db.transaction(() => {
      updateProposalDecision(db, proposalId, { status: "superseded" });
      recordEvent(db, {
        templateId: p.templateId, proposalId, stepTemplateId: p.stepTemplateId,
        eventType: "superseded", templateVersion: currentTemplateVersion(db, p.templateId),
        payload: { kind: "superseded", by: "staleness" },
      }, opts.now);
    })();
    throw new StaleProposalError(`template moved from v${p.templateVersionAtProposal} to v${tpl.version}`);
  }
  return db.transaction(() => {
    // First learned edit on a built-in -> capture pristine baseline.
    if (tpl.is_built_in === 1) captureBaseline(db, p.templateId, tpl.steps_json, opts.now);
    const newVersion = resolved.write(db, opts.now);
    updateProposalDecision(db, proposalId, {
      status: "applied", decidedAt: opts.now, decidedBy: opts.decidedBy, appliedAsVersion: newVersion,
      afterInstructions: resolved.finalText, humanEdited: opts.editedInstructions !== undefined,
    });
    recordEvent(db, {
      templateId: p.templateId, proposalId, stepTemplateId: p.stepTemplateId,
      eventType: "applied", templateVersion: tpl.version, // pre-bump
      payload: { kind: "applied", appliedAsVersion: newVersion, humanEdited: opts.editedInstructions !== undefined },
    }, opts.now);
    const supersededIds = supersedeOtherPending(db, p.templateId, p.stepTemplateId, proposalId);
    for (const supersededId of supersededIds) {
      recordEvent(db, {
        templateId: p.templateId, proposalId: supersededId, stepTemplateId: p.stepTemplateId,
        eventType: "superseded", templateVersion: currentTemplateVersion(db, p.templateId),
        payload: { kind: "superseded", by: "apply" },
      }, opts.now);
    }
    return { newVersion };
  })();
}

export function rollbackAppliedProposal(
  db: Database.Database, proposalId: string,
  opts: { decidedBy: string; now: string; outcome?: RollbackOutcomeSnapshot },
): { newVersion: number } {
  const p = getProposal(db, proposalId);
  if (!p) throw new StepNotFoundError(`proposal ${proposalId} not found`);
  if (p.status !== "applied") throw new ProposalNotAppliedError(`proposal ${proposalId} is ${p.status}`);
  return db.transaction(() => {
    const preBumpVersion = currentTemplateVersion(db, p.templateId);
    const newVersion = p.component === "step_output_schema"
      ? setStepOutputSchemaInPlace(db, p.templateId, p.stepTemplateId, mustParseStoredSchema(proposalId, p.beforeInstructions), opts.now)
      : setStepInstructionsInPlace(db, p.templateId, p.stepTemplateId, p.beforeInstructions, opts.now);
    updateProposalDecision(db, proposalId, { status: "rolled_back", decidedAt: opts.now, decidedBy: opts.decidedBy });
    recordEvent(db, {
      templateId: p.templateId, proposalId, stepTemplateId: p.stepTemplateId,
      eventType: "rolled_back", templateVersion: preBumpVersion,
      payload: { kind: "rolled_back", outcome: opts.outcome ?? { targetDelta: null, targetDeltaVersions: null, invalidOutputRateDelta: null, regressionDetected: false } },
    }, opts.now);
    return { newVersion };
  })();
}

export function restoreTemplateDefault(db: Database.Database, templateId: string, now: string): { newVersion: number } {
  const baseline = getBaseline(db, templateId);
  if (!baseline) throw new NoBaselineError(`no baseline for ${templateId}`);
  return db.transaction(() => {
    const preRestoreVersion = currentTemplateVersion(db, templateId);
    const newVersion = setStepsJsonInPlace(db, templateId, baseline.baselineStepsJson, now);
    const supersededCount = supersedeAppliedForTemplate(db, templateId);
    markBaselineRestored(db, templateId, now);
    recordEvent(db, {
      templateId, proposalId: null, stepTemplateId: null,
      eventType: "baseline_restored", templateVersion: preRestoreVersion,
      payload: { kind: "baseline_restored", supersededCount },
    }, now);
    return { newVersion };
  })();
}

export function dismissProposal(db: Database.Database, id: string, opts: { decidedBy: string; now: string }): void {
  const p = getProposal(db, id);
  if (!p) throw new StepNotFoundError(`proposal ${id} not found`);
  if (p.status !== "pending") throw new ProposalNotPendingError(`proposal ${id} is ${p.status}`);
  db.transaction(() => {
    updateProposalDecision(db, id, { status: "dismissed", decidedAt: opts.now, decidedBy: opts.decidedBy });
    recordEvent(db, {
      templateId: p.templateId, proposalId: id, stepTemplateId: p.stepTemplateId,
      eventType: "dismissed", templateVersion: currentTemplateVersion(db, p.templateId),
      payload: { kind: "dismissed" },
    }, opts.now);
  })();
}

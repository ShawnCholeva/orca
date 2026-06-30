import type Database from "better-sqlite3";
import {
  getProposal, updateProposalDecision, supersedeOtherPending, supersedeAppliedForTemplate,
  captureBaseline, getBaseline, markBaselineRestored,
} from "./store.js";

export class StaleProposalError extends Error {}
export class ProposalNotPendingError extends Error {}
export class ProposalNotAppliedError extends Error {}
export class NoBaselineError extends Error {}
export class StepNotFoundError extends Error {}

interface TemplateRow { version: number; steps_json: string; is_built_in: number }

function readTemplate(db: Database.Database, templateId: string): TemplateRow | undefined {
  return db.prepare(`SELECT version, steps_json, is_built_in FROM workflow_templates WHERE id = ?`).get(templateId) as TemplateRow | undefined;
}

// Privileged in-place write. Bypasses the is_locked/is_built_in guard the generic PATCH enforces;
// reachable only from the learning module behind a confirmed proposal / explicit user action.
export function setStepInstructionsInPlace(db: Database.Database, templateId: string, stepTemplateId: string, instructions: string, now: string): number {
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
  // Staleness guard.
  if (tpl.version !== p.templateVersionAtProposal) {
    updateProposalDecision(db, proposalId, { status: "superseded" });
    throw new StaleProposalError(`template moved from v${p.templateVersionAtProposal} to v${tpl.version}`);
  }
  // First learned edit on a built-in -> capture pristine baseline.
  if (tpl.is_built_in === 1) captureBaseline(db, p.templateId, tpl.steps_json, opts.now);

  const finalText = opts.editedInstructions ?? p.afterInstructions;
  const newVersion = setStepInstructionsInPlace(db, p.templateId, p.stepTemplateId, finalText, opts.now);

  updateProposalDecision(db, proposalId, {
    status: "applied", decidedAt: opts.now, decidedBy: opts.decidedBy, appliedAsVersion: newVersion,
    afterInstructions: finalText, humanEdited: opts.editedInstructions !== undefined,
  });
  supersedeOtherPending(db, p.templateId, p.stepTemplateId, proposalId);
  return { newVersion };
}

export function rollbackAppliedProposal(db: Database.Database, proposalId: string, opts: { decidedBy: string; now: string }): { newVersion: number } {
  const p = getProposal(db, proposalId);
  if (!p) throw new StepNotFoundError(`proposal ${proposalId} not found`);
  if (p.status !== "applied") throw new ProposalNotAppliedError(`proposal ${proposalId} is ${p.status}`);
  const newVersion = setStepInstructionsInPlace(db, p.templateId, p.stepTemplateId, p.beforeInstructions, opts.now);
  updateProposalDecision(db, proposalId, { status: "rolled_back", decidedAt: opts.now, decidedBy: opts.decidedBy });
  return { newVersion };
}

export function restoreTemplateDefault(db: Database.Database, templateId: string, now: string): { newVersion: number } {
  const baseline = getBaseline(db, templateId);
  if (!baseline) throw new NoBaselineError(`no baseline for ${templateId}`);
  const newVersion = setStepsJsonInPlace(db, templateId, baseline.baselineStepsJson, now);
  supersedeAppliedForTemplate(db, templateId);
  markBaselineRestored(db, templateId, now);
  return { newVersion };
}

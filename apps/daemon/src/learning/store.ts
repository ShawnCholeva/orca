import type Database from "better-sqlite3";
import { TemplateInstructionProposal, type ProposalStatus, type CounterfactualJudgment } from "@orca/contracts";

interface Row {
  id: string; template_id: string; template_version_at_proposal: number; step_template_id: string;
  component: string;
  before_instructions: string; after_instructions: string; targeted_failure_mode_json: string;
  predicted_improvement: string; invariants_preserved_json: string; evidence_json: string;
  rationale: string; human_edited: number; status: string; created_at: string;
  decided_at: string | null; decided_by: string | null; applied_as_version: number | null;
  judge_json: string | null;
}

function rowToProposal(r: Row): TemplateInstructionProposal {
  return TemplateInstructionProposal.parse({
    id: r.id, templateId: r.template_id, templateVersionAtProposal: r.template_version_at_proposal,
    stepTemplateId: r.step_template_id, component: r.component,
    beforeInstructions: r.before_instructions, afterInstructions: r.after_instructions,
    targetedFailureMode: JSON.parse(r.targeted_failure_mode_json),
    predictedImprovement: r.predicted_improvement,
    invariantsPreserved: JSON.parse(r.invariants_preserved_json),
    falsifier: "version_comparison", rollbackPlan: "revert_to_before",
    evidence: JSON.parse(r.evidence_json), rationale: r.rationale,
    humanEdited: r.human_edited === 1, status: r.status,
    createdAt: r.created_at, decidedAt: r.decided_at, decidedBy: r.decided_by,
    appliedAsVersion: r.applied_as_version,
    judgment: r.judge_json ? (JSON.parse(r.judge_json) as CounterfactualJudgment) : null,
  });
}

export function insertProposal(db: Database.Database, p: TemplateInstructionProposal): void {
  db.prepare(
    `INSERT INTO template_instruction_proposals
      (id, template_id, template_version_at_proposal, step_template_id, component, before_instructions,
       after_instructions, targeted_failure_mode_json, predicted_improvement, invariants_preserved_json,
       evidence_json, rationale, human_edited, status, created_at, decided_at, decided_by, applied_as_version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    p.id, p.templateId, p.templateVersionAtProposal, p.stepTemplateId, p.component, p.beforeInstructions,
    p.afterInstructions, JSON.stringify(p.targetedFailureMode), p.predictedImprovement,
    JSON.stringify(p.invariantsPreserved), JSON.stringify(p.evidence), p.rationale,
    p.humanEdited ? 1 : 0, p.status, p.createdAt, p.decidedAt, p.decidedBy, p.appliedAsVersion,
  );
}

export function getProposal(db: Database.Database, id: string): TemplateInstructionProposal | null {
  const r = db.prepare(`SELECT * FROM template_instruction_proposals WHERE id = ?`).get(id) as Row | undefined;
  return r ? rowToProposal(r) : null;
}

export function listProposalsByTemplate(db: Database.Database, templateId: string): TemplateInstructionProposal[] {
  const rows = db.prepare(
    `SELECT * FROM template_instruction_proposals WHERE template_id = ? ORDER BY created_at DESC, id DESC`
  ).all(templateId) as Row[];
  return rows.map(rowToProposal);
}

export function pendingProposalForStep(db: Database.Database, templateId: string, stepTemplateId: string): TemplateInstructionProposal | null {
  const r = db.prepare(
    `SELECT * FROM template_instruction_proposals WHERE template_id = ? AND step_template_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1`
  ).get(templateId, stepTemplateId) as Row | undefined;
  return r ? rowToProposal(r) : null;
}

export function updateProposalDecision(
  db: Database.Database, id: string,
  patch: { status: ProposalStatus; decidedAt?: string | null; decidedBy?: string | null;
           appliedAsVersion?: number | null; afterInstructions?: string; humanEdited?: boolean },
): void {
  const cur = db.prepare(`SELECT * FROM template_instruction_proposals WHERE id = ?`).get(id) as Row | undefined;
  if (!cur) return;
  db.prepare(
    `UPDATE template_instruction_proposals
       SET status = ?, decided_at = ?, decided_by = ?, applied_as_version = ?, after_instructions = ?, human_edited = ?
     WHERE id = ?`
  ).run(
    patch.status,
    patch.decidedAt !== undefined ? patch.decidedAt : cur.decided_at,
    patch.decidedBy !== undefined ? patch.decidedBy : cur.decided_by,
    patch.appliedAsVersion !== undefined ? patch.appliedAsVersion : cur.applied_as_version,
    patch.afterInstructions !== undefined ? patch.afterInstructions : cur.after_instructions,
    patch.humanEdited !== undefined ? (patch.humanEdited ? 1 : 0) : cur.human_edited,
    id,
  );
}

export function supersedeOtherPending(db: Database.Database, templateId: string, stepTemplateId: string, exceptId: string): string[] {
  const rows = db.prepare(
    `SELECT id FROM template_instruction_proposals
     WHERE template_id = ? AND step_template_id = ? AND status = 'pending' AND id != ?`
  ).all(templateId, stepTemplateId, exceptId) as { id: string }[];
  db.prepare(
    `UPDATE template_instruction_proposals SET status = 'superseded'
     WHERE template_id = ? AND step_template_id = ? AND status = 'pending' AND id != ?`
  ).run(templateId, stepTemplateId, exceptId);
  return rows.map((r) => r.id);
}

export function supersedeAppliedForTemplate(db: Database.Database, templateId: string): number {
  return db.prepare(
    `UPDATE template_instruction_proposals SET status = 'superseded' WHERE template_id = ? AND status = 'applied'`
  ).run(templateId).changes;
}

export function getBaseline(db: Database.Database, templateId: string) {
  const r = db.prepare(`SELECT * FROM learning_template_baselines WHERE template_id = ?`).get(templateId) as
    { template_id: string; baseline_steps_json: string; captured_at: string; restored_at: string | null } | undefined;
  return r ? { templateId: r.template_id, baselineStepsJson: r.baseline_steps_json, capturedAt: r.captured_at, restoredAt: r.restored_at } : null;
}

export function captureBaseline(db: Database.Database, templateId: string, stepsJson: string, now: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO learning_template_baselines (template_id, baseline_steps_json, captured_at, restored_at)
     VALUES (?,?,?,NULL)`
  ).run(templateId, stepsJson, now);
}

export function markBaselineRestored(db: Database.Database, templateId: string, now: string): void {
  db.prepare(`UPDATE learning_template_baselines SET restored_at = ? WHERE template_id = ?`).run(now, templateId);
}

export function setProposalJudgment(db: Database.Database, proposalId: string, judgment: CounterfactualJudgment): void {
  db.prepare(`UPDATE template_instruction_proposals SET judge_json = ? WHERE id = ?`)
    .run(JSON.stringify(judgment), proposalId);
}

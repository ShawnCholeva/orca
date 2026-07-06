import type Database from "better-sqlite3";
import { EvidenceFacet, RefuteFacet, type TemplateInstructionProposal } from "@orca/contracts";

export const K_PER_BUCKET = 5;
export const OUTPUT_BUDGET = 2000; // chars per compacted output

export interface JudgeCase { stepRunId: string; output: string }
export interface JudgeCorpus { solved: JudgeCase[]; failure: JudgeCase[] }

// Never throw on a malformed facet blob — treat non-JSON as unparseable.
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function compact(body: string): string {
  let text = body;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { _completion: _omit, ...rest } = parsed as Record<string, unknown>;
      text = JSON.stringify(rest);
    }
  } catch { /* keep raw */ }
  return text.length > OUTPUT_BUDGET ? text.slice(0, OUTPUT_BUDGET) : text;
}

// Solved: latest step_output per step run whose step_complete verdict is solved
// (refute upheld primary; evidence passed fallback). Excludes the failure step runs.
function buildSolved(db: Database.Database, templateId: string, stepTemplateId: string, exclude: Set<string>): JudgeCase[] {
  const rows = db.prepare(
    `SELECT wa.step_run_id AS step_run_id, wa.body AS body,
            ht.evidence_json AS evidence_json, ht.refute_json AS refute_json
     FROM workflow_artifacts wa
     JOIN workflow_step_runs wsr ON wsr.id = wa.step_run_id
     JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id
     JOIN harness_transitions ht ON ht.workflow_step_run_id = wa.step_run_id AND ht.boundary = 'step_complete'
     WHERE wr.template_id = ? AND wsr.step_template_id = ? AND wa.type = 'step_output'
     ORDER BY wa.created_at DESC, wa.rowid DESC`
  ).all(templateId, stepTemplateId) as { step_run_id: string; body: string; evidence_json: string | null; refute_json: string | null }[];
  const seen = new Set<string>();
  const out: JudgeCase[] = [];
  for (const r of rows) {
    if (seen.has(r.step_run_id)) continue;
    seen.add(r.step_run_id);
    if (exclude.has(r.step_run_id)) continue;
    let solved: boolean;
    if (r.refute_json != null) {
      // Refute facet present: authoritative. Only "upheld" (parsed correctly) counts as solved;
      // never fall through to the evidence fallback, even if refute_json is corrupt/legacy shape.
      const parsed = safeJsonParse(r.refute_json);
      const refute = parsed === undefined ? null : RefuteFacet.safeParse(parsed);
      solved = !!refute && refute.success && refute.data.verdict === "upheld";
    } else {
      // No refute facet ran: fall back to evidence.
      const parsed = r.evidence_json ? safeJsonParse(r.evidence_json) : undefined;
      const evidence = parsed === undefined ? null : EvidenceFacet.safeParse(parsed);
      solved = !!evidence && evidence.success && evidence.data.verdict === "passed";
    }
    if (!solved) continue;
    out.push({ stepRunId: r.step_run_id, output: compact(r.body) });
    if (out.length >= K_PER_BUCKET) break;
  }
  return out;
}

// Failure: the proposal's own diagnosed cases (sampleTransitionIds + revisionSignalIds),
// each resolved to the EARLIEST step_output attempt (the pre-revision failing output).
function buildDiagnosedFailures(db: Database.Database, proposal: TemplateInstructionProposal): JudgeCase[] {
  const stepRunIds: string[] = [];
  const add = (id: string | null | undefined) => { if (id && !stepRunIds.includes(id)) stepRunIds.push(id); };
  for (const tid of proposal.evidence.sampleTransitionIds) {
    const r = db.prepare(`SELECT workflow_step_run_id AS s FROM harness_transitions WHERE id = ?`).get(tid) as { s: string | null } | undefined;
    add(r?.s);
  }
  for (const sid of proposal.evidence.revisionSignalIds) {
    const r = db.prepare(`SELECT step_run_id AS s FROM step_revision_signals WHERE id = ?`).get(sid) as { s: string } | undefined;
    add(r?.s);
  }
  const out: JudgeCase[] = [];
  for (const stepRunId of stepRunIds) {
    const r = db.prepare(
      `SELECT body FROM workflow_artifacts WHERE step_run_id = ? AND type = 'step_output' ORDER BY created_at ASC, rowid ASC LIMIT 1`
    ).get(stepRunId) as { body: string } | undefined;
    if (r) out.push({ stepRunId, output: compact(r.body) });
    if (out.length >= K_PER_BUCKET) break;
  }
  return out;
}

export const DIAGNOSED_CAP = 3;

// Held-out failures: ground-truth-failed step runs for this step that were NOT part
// of the diagnosis sample. Judging improvement only on the diagnosed cases overfits —
// the edit was authored against exactly those cases (paper §3.5.2: evaluate on
// held-out traces). Same ground-truth rules as buildSolved, inverted.
function buildHeldOutFailures(db: Database.Database, templateId: string, stepTemplateId: string, exclude: Set<string>): JudgeCase[] {
  const rows = db.prepare(
    `SELECT wa.step_run_id AS step_run_id, wa.body AS body,
            ht.evidence_json AS evidence_json, ht.refute_json AS refute_json
     FROM workflow_artifacts wa
     JOIN workflow_step_runs wsr ON wsr.id = wa.step_run_id
     JOIN workflow_runs wr ON wr.id = wsr.workflow_run_id
     JOIN harness_transitions ht ON ht.workflow_step_run_id = wa.step_run_id AND ht.boundary = 'step_complete'
     WHERE wr.template_id = ? AND wsr.step_template_id = ? AND wa.type = 'step_output'
     ORDER BY wa.created_at DESC, wa.rowid DESC`
  ).all(templateId, stepTemplateId) as { step_run_id: string; body: string; evidence_json: string | null; refute_json: string | null }[];
  const seen = new Set<string>();
  const out: JudgeCase[] = [];
  for (const r of rows) {
    if (seen.has(r.step_run_id)) continue;
    seen.add(r.step_run_id);
    if (exclude.has(r.step_run_id)) continue;
    let failed: boolean;
    if (r.refute_json != null) {
      const parsed = safeJsonParse(r.refute_json);
      const refute = parsed === undefined ? null : RefuteFacet.safeParse(parsed);
      failed = !!refute && refute.success && refute.data.verdict === "refuted";
    } else {
      const parsed = r.evidence_json ? safeJsonParse(r.evidence_json) : undefined;
      const evidence = parsed === undefined ? null : EvidenceFacet.safeParse(parsed);
      failed = !!evidence && evidence.success && (evidence.data.verdict === "failed" || evidence.data.verdict === "partial");
    }
    if (!failed) continue;
    out.push({ stepRunId: r.step_run_id, output: compact(r.body) });
    if (out.length >= K_PER_BUCKET) break;
  }
  return out;
}

export function buildJudgeCorpus(db: Database.Database, proposal: TemplateInstructionProposal): JudgeCorpus {
  const diagnosed = buildDiagnosedFailures(db, proposal);
  const diagnosedIds = new Set(diagnosed.map((c) => c.stepRunId));
  const heldOut = buildHeldOutFailures(db, proposal.templateId, proposal.stepTemplateId, diagnosedIds);
  // Diagnosed cases define the targeted failure mode (cap them); held-out cases keep
  // the judge honest. Back-fill with extra diagnosed cases only when no held-out exist.
  const failure = [...diagnosed.slice(0, DIAGNOSED_CAP), ...heldOut].slice(0, K_PER_BUCKET);
  for (const c of diagnosed.slice(DIAGNOSED_CAP)) {
    if (failure.length >= K_PER_BUCKET) break;
    if (!failure.some((f) => f.stepRunId === c.stepRunId)) failure.push(c);
  }
  const failureIds = new Set(failure.map((c) => c.stepRunId));
  const solved = buildSolved(db, proposal.templateId, proposal.stepTemplateId, failureIds);
  return { solved, failure };
}

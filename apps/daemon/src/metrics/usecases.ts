import type Database from "better-sqlite3";
import type { MetricPeriod, MetricScope, TemplateMetricsDetail, TemplateMetricsSummary, WorkflowGraph, WorkflowGuardrailConfig } from "@orca/contracts";
import { listGateDecisionsByTemplate, listSplitDecisionsByTemplate, listStepRunsByTemplate, listTemplatesWithRuns, listTransitionsByTemplate } from "./fetch.js";
import type { TemplateTransition } from "./fetch.js";
import { computeStepMetrics, computeTemplateSummary, windowStart } from "./aggregate.js";
import { deriveVindication } from "./vindication.js";
import type { VindicationOutcome } from "./vindication.js";
import { deriveGateVindication, deriveSplitterVindication } from "./node-vindication.js";
import { computeCalibration } from "./verification.js";
import type { CalibrationEntry } from "./verification.js";
import { gateApprovalsByStep } from "./gate-review.js";
import { buildCompletionGateMetrics, buildGateMetrics, buildPolicyGatewayMetrics } from "./gate-metrics.js";
import { buildSplitterMetrics } from "./splitter-metrics.js";
import { computeNodeLineage } from "./node-lineage.js";
import { buildPipeline } from "./pipeline.js";
import { stepRequiresExecution } from "../workflows/orchestrator/requires-execution.js";

function nowOr(nowIso?: string): string {
  return nowIso ?? new Date().toISOString();
}

interface RunRow { template_version: number; started_at: string }

function versionsInWindow(db: Database.Database, templateId: string, sinceIso: string, untilIso: string) {
  const rows = db.prepare(
    `SELECT template_version, started_at FROM workflow_runs
     WHERE template_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at ASC`
  ).all(templateId, sinceIso, untilIso) as RunRow[];
  const byVersion = new Map<number, { version: number; runs: number; firstSeenAt: string }>();
  for (const r of rows) {
    const v = byVersion.get(r.template_version);
    if (v) v.runs += 1;
    else byVersion.set(r.template_version, { version: r.template_version, runs: 1, firstSeenAt: r.started_at });
  }
  return { runCount: rows.length, versions: [...byVersion.values()].sort((a, b) => b.version - a.version) };
}

function buildSummary(db: Database.Database, t: { templateId: string; name: string; latestVersion: number }, period: MetricPeriod, nowIso: string, scope: MetricScope = "current", calibration?: CalibrationEntry[]): TemplateMetricsSummary {
  const until = nowIso;
  const since = windowStart(nowIso, period);
  const priorUntil = since;
  const priorSince = windowStart(since, period);
  const { runCount, versions } = versionsInWindow(db, t.templateId, since, until);
  const isLatest = (v: { templateVersion: number }) => v.templateVersion === t.latestVersion;
  const currentTransitions = listTransitionsByTemplate(db, t.templateId, since, until);
  const currentStepRuns = listStepRunsByTemplate(db, t.templateId, since, until);
  const priorTransitions = listTransitionsByTemplate(db, t.templateId, priorSince, priorUntil);
  const priorStepRuns = listStepRunsByTemplate(db, t.templateId, priorSince, priorUntil);
  const summary = computeTemplateSummary({
    templateId: t.templateId, name: t.name, latestVersion: t.latestVersion, runCount, versions,
    current: {
      transitions: scope === "latest" ? currentTransitions.filter(isLatest) : currentTransitions,
      stepRuns: scope === "latest" ? currentStepRuns.filter(isLatest) : currentStepRuns,
    },
    prior: {
      transitions: scope === "latest" ? priorTransitions.filter(isLatest) : priorTransitions,
      stepRuns: scope === "latest" ? priorStepRuns.filter(isLatest) : priorStepRuns,
    },
    calibration,
  });
  return { ...summary, scope };
}

// gateHealth stays the computeTemplateSummary stub ({value:null,...}) here: populating it
// needs the graph + latest-version gate decisions + gateVindication (getTemplateMetricsDetail's
// wiring), which this list path doesn't load per-template — that's O(templates) extra queries
// for a summaries-list response. The detail endpoint (one template) pays that cost and
// overrides gateHealth after buildSummary; this stays honestly null rather than paying it here.
export function getTemplateMetricsSummaries(db: Database.Database, period: MetricPeriod, nowIso?: string): TemplateMetricsSummary[] {
  const now = nowOr(nowIso);
  return listTemplatesWithRuns(db).map((t) => buildSummary(db, t, period, now));
}

interface StepDef { id: string; name?: string; ordinal?: number; instructions?: string; completionPolicy?: string }

// First sentence of `text`, capped at `cap` chars (word-boundary + ellipsis if truncated).
export function firstSentence(text: string, cap = 140): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const m = t.search(/\.\s/);
  let s = m > 0 ? t.slice(0, m + 1) : t;
  if (s.length > cap) s = s.slice(0, cap).replace(/\s+\S*$/, "") + "…";
  return s;
}

function stepNames(db: Database.Database, templateId: string): Map<string, { name: string; ordinal: number; description?: string; completionPolicy?: string }> {
  const row = db.prepare(`SELECT steps_json FROM workflow_templates WHERE id = ?`).get(templateId) as { steps_json: string } | undefined;
  const map = new Map<string, { name: string; ordinal: number; description?: string; completionPolicy?: string }>();
  if (!row) return map;
  const defs = JSON.parse(row.steps_json) as StepDef[];
  defs.forEach((d, i) => map.set(d.id, {
    name: d.name ?? d.id,
    ordinal: i,
    description: d.instructions ? firstSentence(d.instructions) : undefined,
    completionPolicy: d.completionPolicy,
  }));
  return map;
}

export function gateNodeNames(db: Database.Database, templateId: string): Map<string, { name: string; evalSubstrate: "shadow" | "worker" }> {
  const row = db.prepare(`SELECT graph_json FROM workflow_templates WHERE id = ?`).get(templateId) as { graph_json: string | null } | undefined;
  const map = new Map<string, { name: string; evalSubstrate: "shadow" | "worker" }>();
  if (!row?.graph_json) return map;
  const graph = JSON.parse(row.graph_json) as { nodes: { id: string; type: string; name?: string; evalSubstrate?: "shadow" | "worker" }[] };
  for (const n of graph.nodes) {
    if (n.type !== "gate") continue;
    map.set(n.id, { name: n.name || n.id, evalSubstrate: n.evalSubstrate ?? "shadow" });
  }
  return map;
}

export function splitterNodeNames(db: Database.Database, templateId: string): Map<string, { name: string }> {
  const row = db.prepare(`SELECT graph_json FROM workflow_templates WHERE id = ?`).get(templateId) as { graph_json: string | null } | undefined;
  const map = new Map<string, { name: string }>();
  if (!row?.graph_json) return map;
  const graph = JSON.parse(row.graph_json) as { nodes: { id: string; type: string; name?: string }[] };
  for (const n of graph.nodes) {
    if (n.type !== "splitter") continue;
    map.set(n.id, { name: n.name || n.id });
  }
  return map;
}

export function getTemplateMetricsDetail(db: Database.Database, templateId: string, period: MetricPeriod, nowIso?: string, scope: MetricScope = "current"): TemplateMetricsDetail | null {
  const now = nowOr(nowIso);
  const info = listTemplatesWithRuns(db).find((t) => t.templateId === templateId);
  if (!info) return null;
  const since = windowStart(now, period);
  const allTransitions = listTransitionsByTemplate(db, templateId, since, now);
  const allGateDecisions = listGateDecisionsByTemplate(db, templateId, since, now);
  const allStepRuns = listStepRunsByTemplate(db, templateId, since, now);
  // scope="latest": only runs whose templateVersion is the current latest contribute.
  const transitions = scope === "latest" ? allTransitions.filter((t) => t.templateVersion === info.latestVersion) : allTransitions;
  const gateDecisions = scope === "latest" ? allGateDecisions.filter((d) => d.templateVersion === info.latestVersion) : allGateDecisions;
  const stepRuns = scope === "latest" ? allStepRuns.filter((r) => r.templateVersion === info.latestVersion) : allStepRuns;
  const graphRow = db.prepare(`SELECT graph_json FROM workflow_templates WHERE id = ?`).get(templateId) as { graph_json: string | null } | undefined;
  // Read-time gate→step credit (no migration): resolve the reviewed step from graph
  // topology (gateApprovalsByStep) and thread it into composedScore so a gate-approved
  // completion scores as independent-review, not unknown. In the Adaptive graph a step
  // transition's stepTemplateId equals its graph node id.
  const graph = graphRow?.graph_json ? (JSON.parse(graphRow.graph_json) as WorkflowGraph) : null;
  // Only the latest template version's topology is ever persisted (templates are one
  // row, overwritten on edit) — an older-version gate decision can land on a node id
  // that a DIFFERENT step feeds under the current graph, mis-attributing an approval
  // to a step it never reviewed. So gate credit is resolved against latest-version
  // decisions ONLY, unconditionally of `scope`: older-version runs get no gate credit
  // (safe under-credit) rather than a cross-version mis-credit.
  const latestVersionGateDecisions = allGateDecisions.filter((d) => d.templateVersion === info.latestVersion);
  const approvals = graph ? gateApprovalsByStep(graph, latestVersionGateDecisions) : new Map<string, Set<string>>();
  const gateApprovedByCompletion = (t: TemplateTransition) => {
    const runId = t.transition.workflowRunId;
    const stepNodeId = t.stepTemplateId;
    return runId != null && stepNodeId != null && (approvals.get(stepNodeId)?.has(runId) ?? false);
  };
  // Downstream-vindication feed. Same version-safety rule as gate credit above: only
  // latest-version transitions/gate/split decisions feed the derivation (older-version
  // decisions/completions can land on a node id a DIFFERENT step feeds under the current
  // graph) — deriveVindication's own input is latest-version-only, so the resulting map
  // never contains a key for an older-version run, which is what keeps computeCalibration
  // (below) from calibrating against older-version vindication labels.
  const splitDecisions = listSplitDecisionsByTemplate(db, templateId, since, now);
  const latestSplits = splitDecisions.filter((d) => d.templateVersion === info.latestVersion);
  const latestVersionTransitions = transitions.filter((t) => t.templateVersion === info.latestVersion);
  const vindication = graph
    ? deriveVindication({ transitions: latestVersionTransitions, gateDecisions: latestVersionGateDecisions, splitDecisions: latestSplits, graph })
    : new Map<string, { outcome: VindicationOutcome; byNodeId: string | null }>();
  // Split version-excluded out of "pending": a version-mismatched completion returns
  // "excluded" (skip — counts toward no bucket in aggregate.ts's tally) instead of
  // falling through to "pending", so pending means only "latest-version completion,
  // downstream hasn't ruled yet".
  const vindicationByCompletion = (t: TemplateTransition): VindicationOutcome | "excluded" | undefined => {
    const runId = t.transition.workflowRunId;
    if (runId == null || t.stepTemplateId == null) return undefined;
    if (t.templateVersion !== info.latestVersion) return "excluded";
    return vindication.get(`${runId}::${t.stepTemplateId}`)?.outcome;
  };
  const calibration = computeCalibration(transitions, { vindication, graph: graph ?? undefined, gateApprovedByCompletion });
  const lineage = computeNodeLineage(db, templateId, since, now);
  const currentStepNames = stepNames(db, templateId);
  const gRow = db.prepare(`SELECT guardrails_json FROM workflow_templates WHERE id = ?`).get(templateId) as { guardrails_json: string } | undefined;
  const guardrails = gRow ? (JSON.parse(gRow.guardrails_json) as WorkflowGuardrailConfig[]) : [];
  const requiresExecution = new Set([...currentStepNames.keys()].filter((id) => stepRequiresExecution(guardrails, id) !== null));
  // Decision-correctness confidence (Phase 3, T4). Same version-safety rule as gate credit
  // and downstream-vindication above: fed only latest-version decisions.
  const gateVindication = graph ? deriveGateVindication({ transitions: latestVersionTransitions, gateDecisions: latestVersionGateDecisions, graph }) : undefined;
  const splitterVindication = graph ? deriveSplitterVindication({ transitions: latestVersionTransitions, splitDecisions: latestSplits, graph }) : undefined;
  const gates = buildGateMetrics({ decisions: gateDecisions, transitions, names: gateNodeNames(db, templateId), period, calibration, scope, lineage, gateVindication });
  const scored = gates.filter((g) => g.health != null);
  const gateHealthValue = scored.length ? Math.round(scored.reduce((n, g) => n + g.health!, 0) / scored.length) : null;
  const gateHealth = {
    value: gateHealthValue,
    grade: gateHealthValue == null ? null : (gateHealthValue >= 90 ? "A" : gateHealthValue >= 80 ? "B" : gateHealthValue >= 70 ? "C" : gateHealthValue >= 60 ? "D" : "F") as "A" | "B" | "C" | "D" | "F",
    delta: null, confidence: (scored.length >= 1 ? "ok" : "low") as "ok" | "low",
  };
  const summary = { ...buildSummary(db, info, period, now, scope, calibration), gateHealth };
  return {
    summary,
    steps: computeStepMetrics({
      transitions,
      stepRuns,
      stepNames: currentStepNames,
      nowIso: now, period,
      calibration,
      scope,
      lineage,
      requiresExecution,
      gateApprovedByCompletion,
      vindicationByCompletion,
    }),
    gates,
    splitters: graph
      ? buildSplitterMetrics({ splitDecisions: latestSplits, splitterVindication: splitterVindication ?? new Map(), graph, names: splitterNodeNames(db, templateId), lineage })
      : [],
    policyGateway: buildPolicyGatewayMetrics(transitions),
    completionGate: buildCompletionGateMetrics(transitions),
    pipeline: buildPipeline(graphRow?.graph_json ?? null),
  };
}

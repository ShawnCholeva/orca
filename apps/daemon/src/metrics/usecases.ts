import type Database from "better-sqlite3";
import type { MetricPeriod, TemplateMetricsDetail, TemplateMetricsSummary } from "@orca/contracts";
import { listStepRunsByTemplate, listTemplatesWithRuns, listTransitionsByTemplate } from "./fetch.js";
import { computeStepMetrics, computeTemplateSummary, windowStart } from "./aggregate.js";
import { computeCalibration } from "./verification.js";

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

function buildSummary(db: Database.Database, t: { templateId: string; name: string; latestVersion: number }, period: MetricPeriod, nowIso: string): TemplateMetricsSummary {
  const until = nowIso;
  const since = windowStart(nowIso, period);
  const priorUntil = since;
  const priorSince = windowStart(since, period);
  const { runCount, versions } = versionsInWindow(db, t.templateId, since, until);
  return computeTemplateSummary({
    templateId: t.templateId, name: t.name, latestVersion: t.latestVersion, runCount, versions,
    current: {
      transitions: listTransitionsByTemplate(db, t.templateId, since, until),
      stepRuns: listStepRunsByTemplate(db, t.templateId, since, until),
    },
    prior: {
      transitions: listTransitionsByTemplate(db, t.templateId, priorSince, priorUntil),
      stepRuns: listStepRunsByTemplate(db, t.templateId, priorSince, priorUntil),
    },
  });
}

export function getTemplateMetricsSummaries(db: Database.Database, period: MetricPeriod, nowIso?: string): TemplateMetricsSummary[] {
  const now = nowOr(nowIso);
  return listTemplatesWithRuns(db).map((t) => buildSummary(db, t, period, now));
}

interface StepDef { id: string; name: string }

function stepNames(db: Database.Database, templateId: string): Map<string, { name: string; ordinal: number }> {
  const row = db.prepare(`SELECT steps_json FROM workflow_templates WHERE id = ?`).get(templateId) as { steps_json: string } | undefined;
  const map = new Map<string, { name: string; ordinal: number }>();
  if (!row) return map;
  const defs = JSON.parse(row.steps_json) as StepDef[];
  defs.forEach((d, i) => map.set(d.id, { name: d.name ?? d.id, ordinal: i }));
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

export function getTemplateMetricsDetail(db: Database.Database, templateId: string, period: MetricPeriod, nowIso?: string): TemplateMetricsDetail | null {
  const now = nowOr(nowIso);
  const info = listTemplatesWithRuns(db).find((t) => t.templateId === templateId);
  if (!info) return null;
  const since = windowStart(now, period);
  const transitions = listTransitionsByTemplate(db, templateId, since, now);
  return {
    summary: buildSummary(db, info, period, now),
    steps: computeStepMetrics({
      transitions,
      stepRuns: listStepRunsByTemplate(db, templateId, since, now),
      stepNames: stepNames(db, templateId),
      nowIso: now, period,
      calibration: computeCalibration(transitions),
    }),
    // TODO(gate-metrics): populated in the gates-wiring task
    gates: [],
    policyGateway: {
      decisionDist: { allow: 0, require_approval: 0, deny: 0 },
      overPermissive: { count: 0, sampleTransitionIds: [] },
      boundaryViolations: [],
    },
  };
}

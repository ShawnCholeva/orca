import type { CompletionGateMetrics, GateMetrics, GateFailureMode, MetricPeriod, MetricScope, PolicyGatewayMetrics } from "@orca/contracts";
import { labelForGateFailure } from "@orca/contracts";
import type { GateDecisionRow, TemplateTransition } from "./fetch.js";
import { composedScore } from "./composed-score.js";
import { SOURCE_CONFIDENCE } from "./source-signals.js";
import type { CalibrationEntry } from "./verification.js";

export const GATE_OVERTURN_MIN = 5;   // supervised-with-recommendation decisions before overturnRate is non-null
export const GATE_SAMPLE_CAP = 5;     // max artifact ids per drill-through list
export const GATE_REJECT_CAP = 3;     // mirrors gate-evaluation.ts:12
export const W_OVERTURN = 0.5;
export const W_GROUNDED = 0.3;
export const W_CONVERGE = 0.2;

const grade = (s: number): GateMetrics["grade"] => (s >= 90 ? "A" : s >= 80 ? "B" : s >= 70 ? "C" : s >= 60 ? "D" : "F");
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function buildGateMetrics(input: {
  decisions: GateDecisionRow[];
  transitions: TemplateTransition[];
  names: Map<string, { name: string; evalSubstrate: "shadow" | "worker" }>;
  period: MetricPeriod;
  calibration?: CalibrationEntry[];
  scope?: MetricScope;
}): GateMetrics[] {
  const calibration = input.calibration;
  const scope = input.scope ?? "current";
  // Scope to the CURRENT template's gates: a node id not in `names` is a retired gate
  // from an older version. If the gate set is unknown (empty), don't filter.
  // scope="all" disables this filter entirely (pre-A-i behavior).
  const currentGates = input.names;
  const byNode = new Map<string, GateDecisionRow[]>();
  for (const d of input.decisions) {
    if (scope !== "all" && currentGates.size > 0 && !currentGates.has(d.nodeId)) continue;
    (byNode.get(d.nodeId) ?? byNode.set(d.nodeId, []).get(d.nodeId)!).push(d);
  }

  // Step-completion transitions per run, sorted by time — used for the gate→evidence join.
  const stepCompletesByRun = new Map<string, TemplateTransition[]>();
  for (const t of input.transitions) {
    if (t.stepTemplateId?.startsWith("__gate__:")) continue;
    if (t.transition.boundary !== "step_complete") continue;
    const runId = t.transition.workflowRunId;
    if (runId == null) continue;
    (stepCompletesByRun.get(runId) ?? stepCompletesByRun.set(runId, []).get(runId)!).push(t);
  }
  for (const arr of stepCompletesByRun.values()) arr.sort((a, b) => a.transition.createdAt.localeCompare(b.transition.createdAt));

  const gates: GateMetrics[] = [];
  for (const [nodeId, decisions] of byNode) {
    const meta = input.names.get(nodeId) ?? { name: nodeId.replace(/^__gate__:/, ""), evalSubstrate: "shadow" as const };

    // --- Overturn (dominant term) ---
    const withRec = decisions.filter((d) => d.recommendedOutcome != null);
    const overturned = withRec.filter((d) => d.recommendedOutcome !== d.outcome);
    const overturnSampleSize = withRec.length;
    const overturnRate = overturnSampleSize >= GATE_OVERTURN_MIN ? overturned.length / overturnSampleSize : null;
    const overturnDecisionIds = overturned.slice(0, GATE_SAMPLE_CAP).map((d) => d.id);

    // --- Groundedness: how strongly did the reviewed step's evidence stand up? (graded, composed) ---
    const GROUNDED_FLOOR = SOURCE_CONFIDENCE.self_report; // 0.3 — at/below ⇒ no independent verifier passed
    const groundednessOf = (d: GateDecisionRow): number => {
      const completes = stepCompletesByRun.get(d.workflowRunId) ?? [];
      const reviewed = [...completes].reverse().find((t) => t.transition.createdAt < d.createdAt);
      return reviewed ? composedScore(reviewed, calibration).base : 0; // no reviewed step / refuted / failed ⇒ 0
    };
    const isUngrounded = (d: GateDecisionRow): boolean => groundednessOf(d) <= GROUNDED_FLOOR;
    const groundedness = mean(decisions.map(groundednessOf)); // number | null (null only on empty — unreachable per node)
    const ungroundedDecisionIds = decisions.filter(isUngrounded).slice(0, GATE_SAMPLE_CAP).map((d) => d.id);

    // --- Convergence: resolutions = decisions grouped per run; loops penalize toward the cap ---
    const byRun = new Map<string, GateDecisionRow[]>();
    for (const d of decisions) (byRun.get(d.workflowRunId) ?? byRun.set(d.workflowRunId, []).get(d.workflowRunId)!).push(d);
    const resolutions = [...byRun.values()];
    const loopsPer = resolutions.map((r) => r.length);
    const convScores = loopsPer.map((n) => Math.max(0, Math.min(1, (GATE_REJECT_CAP - (n - 1)) / GATE_REJECT_CAP)));
    const convergence = mean(convScores);
    const capHitRate = resolutions.length ? loopsPer.filter((n) => n >= GATE_REJECT_CAP).length / resolutions.length : null;
    const stagnated = resolutions.filter((r) => {
      const sorted = [...r].sort((a, b) => a.traversalSeq - b.traversalSeq);
      for (let i = 1; i < sorted.length; i++) {
        const a = [...sorted[i - 1].issueRefs].sort().join("|"); const b = [...sorted[i].issueRefs].sort().join("|");
        if (a && a === b) return true;
      }
      return false;
    });
    const stagnationRate = resolutions.length ? stagnated.length / resolutions.length : null;

    // --- Health (honest-null when overturn coverage is thin) ---
    let health: number | null = null;
    if (overturnRate != null && groundedness != null && convergence != null) {
      health = Math.round(100 * (W_OVERTURN * (1 - overturnRate) + W_GROUNDED * groundedness + W_CONVERGE * convergence));
    }
    const limitingTerm = health == null ? null : ([
      ["overturn", 1 - (overturnRate ?? 0)], ["groundedness", groundedness ?? 0], ["convergence", convergence ?? 0],
    ] as const).slice().sort((a, b) => a[1] - b[1])[0][0];

    // --- Cost (never folded into health) ---
    const gateTs = input.transitions.filter((t) => t.stepTemplateId === `__gate__:${nodeId}`);
    const tel = (t: TemplateTransition) => t.transition.telemetry as { latency_ms?: number | null; cost?: { usd?: number; tokens_in?: number; tokens_out?: number } | null } | undefined;
    const usd = gateTs.map((t) => tel(t)?.cost?.usd).filter((x): x is number => typeof x === "number");
    const tokens = gateTs.map((t) => { const c = tel(t)?.cost; return c ? (c.tokens_in ?? 0) + (c.tokens_out ?? 0) : null; }).filter((x): x is number => x != null);
    const latencies = gateTs.map((t) => tel(t)?.latency_ms).filter((x): x is number => typeof x === "number");
    const overturnedRuns = new Set(overturned.map((d) => d.workflowRunId));
    const overturnedTokens = gateTs.filter((t) => t.transition.workflowRunId != null && overturnedRuns.has(t.transition.workflowRunId))
      .map((t) => { const c = tel(t)?.cost; return c ? (c.tokens_in ?? 0) + (c.tokens_out ?? 0) : 0; });

    // --- Failure-mode taxonomy ---
    const modes: GateFailureMode[] = [];
    const pushMode = (code: string, rows: GateDecisionRow[]) => {
      if (!rows.length) return;
      modes.push({ label: labelForGateFailure(code), count: rows.length, pct: rows.length / decisions.length, sampleDecisionIds: rows.slice(0, GATE_SAMPLE_CAP).map((d) => d.id) });
    };
    pushMode("overturned_approve", overturned.filter((d) => d.recommendedOutcome === "approved" && d.outcome === "rejected"));
    pushMode("blind_approve", decisions.filter((d) => d.outcome === "approved" && isUngrounded(d)));
    pushMode("cap_hit", resolutions.filter((r) => r.length >= GATE_REJECT_CAP).flat());
    pushMode("stagnation", stagnated.flat());

    const approvals = decisions.filter((d) => d.outcome === "approved").length;
    const recentRejectReasons = decisions.filter((d) => d.outcome === "rejected").slice(-3)
      .map((d) => ({ at: d.createdAt, reason: d.reason, issueRefs: d.issueRefs }));

    gates.push({
      nodeId, name: meta.name, evalSubstrate: meta.evalSubstrate,
      health, grade: health == null ? null : grade(health),
      confidence: overturnSampleSize >= GATE_OVERTURN_MIN ? "ok" : "low",
      sampleSize: decisions.length, delta: null,
      scored: { overturnRate, overturnSampleSize, overturnDecisionIds, groundedness, ungroundedDecisionIds, convergence, limitingTerm },
      cost: { p50LatencyMs: median(latencies), meanTokens: mean(tokens), meanUsd: mean(usd), tokensSpentOnOverturned: overturnedTokens.length ? overturnedTokens.reduce((a, b) => a + b, 0) : null },
      failureModes: modes,
      context: {
        approvalRate: decisions.length ? approvals / decisions.length : null,
        rejectRate: decisions.length ? (decisions.length - approvals) / decisions.length : null,
        decisions: decisions.length, meanLoops: mean(loopsPer), capHitRate, stagnationRate, parkRate: null,
        residualRiskBurden: null, recentRejectReasons,
      },
      trend: [], versionBoundaries: [],
    });
  }
  return gates.sort((a, b) => a.name.localeCompare(b.name));
}

export function buildPolicyGatewayMetrics(transitions: TemplateTransition[]): PolicyGatewayMetrics {
  const dist = { allow: 0, require_approval: 0, deny: 0 };
  const overIds: string[] = [];
  const violationsByClass = new Map<string, { count: number; ids: string[] }>();
  for (const t of transitions) {
    if (t.transition.boundary !== "tool_gate") continue;
    const risk = (t.transition as { risk?: { gate_decision?: string; risk_class?: string } }).risk;
    if (!risk || !risk.gate_decision) continue;
    // Defensive: only the three known GateDecision values may enter dist — decisionDist
    // is now a strict 3-key contract, so an unexpected value must not add a 4th key.
    const decision = risk.gate_decision;
    if (decision === "allow" || decision === "require_approval" || decision === "deny") {
      dist[decision]++;
    }
    const id = t.transition.id;
    if (risk.gate_decision === "allow" && (risk.risk_class === "high" || risk.risk_class === "critical")) {
      if (overIds.length < GATE_SAMPLE_CAP) overIds.push(id);
    }
    if (risk.gate_decision === "deny" || risk.gate_decision === "require_approval") {
      const key = risk.risk_class ?? "unknown";
      const bucket = violationsByClass.get(key) ?? { count: 0, ids: [] };
      bucket.count++; if (bucket.ids.length < GATE_SAMPLE_CAP) bucket.ids.push(id);
      violationsByClass.set(key, bucket);
    }
  }
  return {
    decisionDist: dist,
    overPermissive: { count: overIds.length, sampleTransitionIds: overIds },
    boundaryViolations: [...violationsByClass.entries()].map(([risk_class, b]) => ({
      failureCode: null, boundary: `tool_gate:${risk_class}`, count: b.count, sampleTransitionIds: b.ids,
    })),
  };
}

export function buildCompletionGateMetrics(transitions: TemplateTransition[]): CompletionGateMetrics {
  const dist = { upheld: 0, escalated: 0, evidence_veto: 0, refute_veto: 0 };
  const vetoedIds: string[] = [];
  for (const t of transitions) {
    const tr = t.transition;
    if (tr.boundary !== "step_complete") continue;
    if (t.stepTemplateId?.startsWith("__gate__:")) continue;
    if (!(tr as { evidence?: unknown }).evidence) continue; // only gated completions carry an evidence facet
    const oc = (tr as { telemetry?: { outcome?: { status?: string; failure_code?: string | null } } }).telemetry?.outcome;
    const fc = oc?.failure_code ?? null;
    if (fc === "refute_veto") {
      dist.refute_veto++;
      if (vetoedIds.length < GATE_SAMPLE_CAP) vetoedIds.push(tr.id);
    } else if (fc === "evidence_veto") {
      if (oc?.status === "escalated") dist.escalated++;
      else dist.evidence_veto++;
      if (vetoedIds.length < GATE_SAMPLE_CAP) vetoedIds.push(tr.id);
    } else {
      dist.upheld++;
    }
  }
  return {
    verdictDist: dist,
    vetoed: { count: dist.escalated + dist.evidence_veto + dist.refute_veto, sampleTransitionIds: vetoedIds },
  };
}

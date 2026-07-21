import { useEffect, useState } from "react";
import type { MetricScope, TemplateInstructionProposal, TemplateMetricsSummary, TemplateMetricsDetail } from "@orca/contracts";
import { getTemplateMetricsSummaries, getTemplateMetricsDetail, listProposals, applyProposal, dismissProposal } from "../api";
import { gradeFor, workflowHealthFromSteps } from "./metrics-data";
import { StatTile } from "./metrics-charts";
import { StepPerformancePanel, WorkflowDropdown } from "./StepPerformance";
import { GatePerformancePanel, FusedPipelinePanel, PolicyGatewayReadout, CompletionGateReadout } from "./GatePerformance";
import { SelfImprovementRail } from "./SelfImprovement";
import { ProposalReviewModal } from "./ProposalReviewModal";
import { Workflow, Refresh } from "./metrics-icons";

const PERIODS = ["24h", "7d", "30d"] as const;
type Period = (typeof PERIODS)[number];

const SCOPES: { id: MetricScope; label: string }[] = [
  { id: "current", label: "Current shape" },
  { id: "latest", label: "Latest only" },
  { id: "all", label: "All versions" },
];

export function MetricsPage({ onOpenGoal }: { onOpenGoal?: (goalId: string) => void } = {}) {
  const [period, setPeriod] = useState<Period>("7d");
  const [scope, setScope] = useState<MetricScope>("current");
  const [summaries, setSummaries] = useState<TemplateMetricsSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [wfId, setWfId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TemplateMetricsDetail | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [openGate, setOpenGate] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [proposals, setProposals] = useState<TemplateInstructionProposal[]>([]);
  const [reviewingProposalId, setReviewingProposalId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setSummaries(null); setError(false);
    getTemplateMetricsSummaries(period)
      .then((s) => { if (!live) return; setSummaries(s); setWfId((cur) => cur ?? s[0]?.templateId ?? null); })
      .catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [period, reloadKey]);

  useEffect(() => {
    setDetail(null);
    setOpenStep(null);
    setOpenGate(null);
    setReviewingProposalId(null);
    if (!wfId) { return; }
    let live = true;
    getTemplateMetricsDetail(wfId, period, scope).then((d) => { if (live) setDetail(d); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [wfId, period, scope, reloadKey]);

  useEffect(() => {
    let live = true;
    if (!wfId) { setProposals([]); return; }
    listProposals(wfId, period).then((p) => { if (live) setProposals(p); }).catch(() => {});
    return () => { live = false; };
  }, [wfId, period, reloadKey]);

  const refetchProposals = async () => {
    if (wfId) { try { setProposals(await listProposals(wfId, period)); } catch { /* best-effort */ } }
  };
  // Keyed for a later task (opening the review modal from the step drawer).
  const proposalsByStep = new Map<string, TemplateInstructionProposal>();
  for (const p of proposals) if (p.status === "pending" && !proposalsByStep.has(p.stepTemplateId)) proposalsByStep.set(p.stepTemplateId, p);
  const reviewingProposal = proposals.find((p) => p.id === reviewingProposalId) ?? null;

  if (error) {
    return <CenterNote>Couldn't load metrics. <button type="button" onClick={() => setReloadKey((k) => k + 1)} style={linkBtn}>Retry</button></CenterNote>;
  }
  if (summaries === null) return <CenterNote>Loading metrics…</CenterNote>;
  if (summaries.length === 0) return <CenterNote>Run a workflow to see metrics.</CenterNote>;

  const wf = summaries.find((s) => s.templateId === wfId) ?? summaries[0];
  const health = workflowHealthFromSteps(detail?.steps ?? []);
  const healthColor = health == null ? "var(--text-3)" : health >= 80 ? "var(--run)" : health >= 60 ? "var(--warn)" : "var(--err)";

  return (
    <>
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 12, padding: 12, height: "100%", minHeight: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <Workflow size={14} color="var(--text-3)" />
          <span className="mono" style={{ fontSize: 10.5, letterSpacing: 1.1, textTransform: "uppercase", color: "var(--text-3)", marginRight: 2 }}>Workflow</span>
          <WorkflowDropdown summaries={summaries} value={wf.templateId} onChange={(id) => { setWfId(id); setOpenStep(null); }} />
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} title="Refresh data for this workflow" aria-label="Refresh data for this workflow" style={iconBtn}>
            <Refresh size={13} color="var(--text-3)" />
          </button>
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", background: "rgba(255,255,255,0.03)", border: "1px solid var(--hairline)", borderRadius: 8, padding: 2 }}>
            {PERIODS.map((p) => (
              <button key={p} type="button" onClick={() => setPeriod(p)} className="mono"
                style={{ background: period === p ? "rgba(255,255,255,0.08)" : "transparent", color: period === p ? "var(--text)" : "var(--text-3)", border: "none", borderRadius: 6, padding: "4px 9px", cursor: "pointer", fontSize: 11 }}>
                {p}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <span className="mono" style={{ fontSize: 10.5, letterSpacing: 1.1, textTransform: "uppercase", color: "var(--text-3)" }}>Version scope</span>
          <div style={{ display: "flex", background: "rgba(255,255,255,0.03)", border: "1px solid var(--hairline)", borderRadius: 8, padding: 2 }}>
            {SCOPES.map((s) => (
              <button key={s.id} type="button" onClick={() => setScope(s.id)} aria-pressed={scope === s.id}
                style={{ background: scope === s.id ? "var(--accent-2-soft)" : "transparent", color: scope === s.id ? "var(--accent-2)" : "var(--text-3)", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: 11.5 }}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexShrink: 0, opacity: wf.confidence === "low" ? 0.55 : 1 }}>
          <StatTile label="Step health" value={health} accent={healthColor} grade={health == null ? null : gradeFor(health)} delta={pctDelta(wf.deltas.verificationStrength)} deltaGood="up" />
          <StatTile label="Gate health" value={wf.gateHealth.value} accent={wf.gateHealth.value == null ? "var(--text-3)" : wf.gateHealth.value >= 80 ? "var(--run)" : wf.gateHealth.value >= 60 ? "var(--warn)" : "var(--err)"} grade={wf.gateHealth.grade} delta={pctDelta(wf.gateHealth.delta)} deltaGood="up" />
          <StatTile label="First-pass" value={rate(wf.firstPass)} unit="%" />
          <StatTile label="Self-recovered" value={rate(wf.recovered)} unit="%" accent="var(--warn)" />
          <StatTile label="Escalated" value={rate(wf.escalated)} unit="%" accent="var(--err)" />
        </div>

        {detail?.pipeline ? (
          <FusedPipelinePanel
            detail={detail}
            loading={detail === null}
            openStep={openStep}
            onToggleStep={(name) => setOpenStep((o) => (o === name ? null : name))}
            openGate={openGate}
            onToggleGate={(id) => setOpenGate((o) => (o === id ? null : id))}
            onOpenGoal={onOpenGoal}
          />
        ) : (
          <>
            <StepPerformancePanel detail={detail} loading={detail === null} openStep={openStep} onToggleStep={(name) => setOpenStep((o) => (o === name ? null : name))} onOpenGoal={onOpenGoal} />
            <GatePerformancePanel detail={detail} openGate={openGate} onToggleGate={(id) => setOpenGate((o) => (o === id ? null : id))} />
          </>
        )}
        <PolicyGatewayReadout detail={detail} />
        <CompletionGateReadout detail={detail} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <SelfImprovementRail
          detail={detail}
          workflowName={wf.name}
          templateId={wfId}
          period={period}
          onMutated={() => setReloadKey((k) => k + 1)}
          proposals={proposals}
          onReview={setReviewingProposalId}
          refetchProposals={refetchProposals}
        />
      </div>
    </div>
    {reviewingProposal && (
      <ProposalReviewModal
        proposal={reviewingProposal}
        stepName={detail?.steps.find((s) => s.stepTemplateId === reviewingProposal.stepTemplateId)?.name ?? reviewingProposal.stepTemplateId}
        onApply={async (edited) => { await applyProposal(reviewingProposal.id, edited); setReviewingProposalId(null); await refetchProposals(); setReloadKey((k) => k + 1); }}
        onDismiss={async () => { await dismissProposal(reviewingProposal.id); setReviewingProposalId(null); await refetchProposals(); }}
        onClose={() => setReviewingProposalId(null)}
      />
    )}
    </>
  );
}

const linkBtn: React.CSSProperties = { background: "transparent", color: "var(--accent)", border: "none", cursor: "pointer", fontSize: 11, padding: "4px 6px" };
const iconBtn: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", background: "transparent", border: "1px solid var(--hairline)", borderRadius: 8, cursor: "pointer", padding: 5, color: "var(--text-3)" };
function rate(r: number | null): number | null { return r == null ? null : Math.round(r * 100); }
function pctDelta(d: number | null): number { return d == null ? 0 : Math.round(d * 100); }
function CenterNote({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-3)", fontSize: 13 }}>{children}</div>;
}

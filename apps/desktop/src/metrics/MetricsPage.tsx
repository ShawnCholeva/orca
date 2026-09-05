import { useEffect, useRef, useState } from "react";
import type { MetricScope, TemplateInstructionProposal, TemplateMetricsSummary, TemplateMetricsDetail, CountedRate } from "@orca/contracts";
import { getTemplateMetricsSummaries, getTemplateMetricsDetail, listProposals, applyProposal, dismissProposal } from "../api";
import { gradeFor, workflowHealthFromSteps } from "./metrics-data";
import { StatTile } from "./metrics-charts";
import { StepPerformancePanel, WorkflowDropdown } from "./StepPerformance";
import { GatePerformancePanel, FusedPipelinePanel } from "./GatePerformance";
import { SelfImprovementRail } from "./SelfImprovement";
import { ProposalReviewModal } from "./ProposalReviewModal";
import { Workflow, Refresh } from "./metrics-icons";
import { RunLedger } from "./RunLedger";
import { MeasurementLabel } from "./n-gate-ui";

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
  // The run ledger leads. The aggregate view below cannot answer "how did THIS run
  // behave", and it still opens on a grade computed over runs the daemon killed —
  // so it is reachable behind the toggle rather than being what the tab shows first.
  const [view, setView] = useState<"runs" | "workflow">("runs");
  const [reloadKey, setReloadKey] = useState(0);
  const [proposals, setProposals] = useState<TemplateInstructionProposal[]>([]);
  const [reviewingProposalId, setReviewingProposalId] = useState<string | null>(null);
  const wfIdRef = useRef(wfId);
  wfIdRef.current = wfId;

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
    if (!wfId) return;
    const capturedId = wfId;
    try {
      const p = await listProposals(capturedId, period);
      if (capturedId === wfIdRef.current) setProposals(p);
    } catch { /* best-effort */ }
  };
  // Keyed for a later task (opening the review modal from the step drawer).
  const proposalsByStep = new Map<string, TemplateInstructionProposal>();
  for (const p of proposals) if (p.status === "pending" && !proposalsByStep.has(p.stepTemplateId)) proposalsByStep.set(p.stepTemplateId, p);
  const reviewingProposal = proposals.find((p) => p.id === reviewingProposalId) ?? null;

  if (view === "runs") {
    // `gridTemplateRows` is load-bearing. Without it, auto rows split `height: 100%`
    // evenly between the toggle and the ledger — so on a SHORT run detail the toggle
    // inflated to a ~210px box with its two buttons stretched down it. It looked
    // correct on every screenshot we took, because the runs list is always tall enough
    // to starve the first row: the bug needed SPARSE data to appear, which is the case
    // nobody photographs.
    return (
      <div style={{ display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", gap: 14, padding: 12, height: "100%", minHeight: 0, overflowY: "auto" }}>
        <ViewToggle view={view} onChange={setView} />
        <RunLedger />
      </div>
    );
  }

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
        <ViewToggle view={view} onChange={setView} />
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
                style={{ background: scope === s.id ? "var(--accent-2-soft)" : "transparent", color: scope === s.id ? "var(--accent-2)" : "var(--text-3)", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: "var(--fs-2)" }}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* This is the row the whole redesign started from: five estimates rendered
            at 55% opacity when the sample couldn't support them. Dimming was never a
            second claim — the numbers were asserted either way — so it cost the reader
            legibility and bought nothing. The sample now says itself, once, in words.
            The tiles still assert rates below their gate; converting them to gated
            forms is C11 and is deliberately not smuggled in here. */}
        {wf.confidence === "low" && (
          <MeasurementLabel state="insufficient" have={wf.runs} need={5} unit="runs" style={{ flexShrink: 0 }} />
        )}
        <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
          <StatTile label="Step health" value={health} accent={healthColor} grade={health == null ? null : gradeFor(health)} delta={pctDelta(wf.deltas.verificationStrength)} deltaGood="up" />
          <StatTile label="Gate health" value={wf.gateHealth.value} accent={wf.gateHealth.value == null ? "var(--text-3)" : wf.gateHealth.value >= 80 ? "var(--run)" : wf.gateHealth.value >= 60 ? "var(--warn)" : "var(--err)"} grade={wf.gateHealth.grade} delta={pctDelta(wf.gateHealth.delta)} deltaGood="up" />
          <StatTile label="First-pass" value={rate(wf.firstPass)} unit={denom(wf.firstPass)} />
          <StatTile label="Self-recovered" value={rate(wf.recovered)} unit={denom(wf.recovered)} accent="var(--warn)" />
          {/* Escalated is cut from the display, not from the contract — `wf.escalated`
              stays and nothing upstream changes.
              It is computed over a different population from the two tiles beside it,
              so the row rendered "3 of 7" next to "5 of 11": two denominators, adjacent
              and unexplained, which reads as a broken screen rather than as two honest
              measurements. The difference cannot be compressed into a suffix without
              claiming the populations are comparable, and the question it was there to
              answer — how often does a run need a human — is now answered properly by
              the run ledger, with real durations instead of a rate. */}
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
            proposalsByStep={proposalsByStep}
            onReviewProposal={setReviewingProposalId}
          />
        ) : (
          <>
            <StepPerformancePanel detail={detail} loading={detail === null} openStep={openStep} onToggleStep={(name) => setOpenStep((o) => (o === name ? null : name))} onOpenGoal={onOpenGoal} proposalsByStep={proposalsByStep} onReviewProposal={setReviewingProposalId} />
            <GatePerformancePanel detail={detail} openGate={openGate} onToggleGate={(id) => setOpenGate((o) => (o === id ? null : id))} />
          </>
        )}
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
function ViewToggle({ view, onChange }: { view: "runs" | "workflow"; onChange: (v: "runs" | "workflow") => void }) {
  const tab = (id: "runs" | "workflow", label: string) => (
    <button key={id} type="button" onClick={() => onChange(id)} aria-pressed={view === id}
      style={{ background: view === id ? "var(--accent-soft)" : "transparent", color: view === id ? "var(--accent)" : "var(--text-3)",
               border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontSize: "var(--fs-2)" }}>
      {label}
    </button>
  );
  return (
    <div style={{ display: "flex", gap: 2, background: "rgba(255,255,255,0.03)", border: "1px solid var(--hairline)", borderRadius: 8, padding: 2, width: "fit-content", flexShrink: 0 }}>
      {tab("runs", "Runs")}
      {tab("workflow", "Workflow averages")}
    </div>
  );
}

function rate(r: CountedRate | null): number | null { return r == null ? null : Math.round((r.pos / r.n) * 100); }
// The denominator rides along with the percentage. A bare ratio looks identical
// whichever population produced it, which is how gate surrogates sat in these
// denominators unnoticed — 4 of 5 and 4 of 6 render the same.
function denom(r: CountedRate | null): string { return r == null ? "%" : `% · ${r.pos} of ${r.n}`; }
function pctDelta(d: number | null): number { return d == null ? 0 : Math.round(d * 100); }
function CenterNote({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-3)", fontSize: 13 }}>{children}</div>;
}

import { useEffect, useState } from "react";
import type { TemplateMetricsSummary, TemplateMetricsDetail } from "@orca/contracts";
import { getTemplateMetricsSummaries, getTemplateMetricsDetail } from "../api";
import { gradeFor, workflowHealthFromSteps } from "./metrics-data";
import { StatTile } from "./metrics-charts";
import { StepPerformancePanel, WorkflowDropdown } from "./StepPerformance";
import { SelfImprovementRail } from "./SelfImprovement";
import { Workflow } from "./metrics-icons";

const PERIODS = ["24h", "7d", "30d"] as const;
type Period = (typeof PERIODS)[number];

export function MetricsPage() {
  const [period, setPeriod] = useState<Period>("7d");
  const [summaries, setSummaries] = useState<TemplateMetricsSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [wfId, setWfId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TemplateMetricsDetail | null>(null);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
    if (!wfId) { return; }
    let live = true;
    getTemplateMetricsDetail(wfId, period).then((d) => { if (live) setDetail(d); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [wfId, period, reloadKey]);

  if (error) {
    return <CenterNote>Couldn't load metrics. <button type="button" onClick={() => setReloadKey((k) => k + 1)} style={linkBtn}>Retry</button></CenterNote>;
  }
  if (summaries === null) return <CenterNote>Loading metrics…</CenterNote>;
  if (summaries.length === 0) return <CenterNote>Run a workflow to see metrics.</CenterNote>;

  const wf = summaries.find((s) => s.templateId === wfId) ?? summaries[0];
  const health = workflowHealthFromSteps(detail?.steps ?? []);
  const healthColor = health == null ? "var(--text-3)" : health >= 80 ? "var(--run)" : health >= 60 ? "var(--warn)" : "var(--err)";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 12, padding: 12, height: "100%", minHeight: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <Workflow size={14} color="var(--text-3)" />
          <span className="mono" style={{ fontSize: 10.5, letterSpacing: 1.1, textTransform: "uppercase", color: "var(--text-3)", marginRight: 2 }}>Workflow</span>
          <WorkflowDropdown summaries={summaries} value={wf.templateId} onChange={(id) => { setWfId(id); setOpenStep(null); }} />
          <div style={{ flex: 1 }} />
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="mono" style={linkBtn}>Refresh</button>
          <div style={{ display: "flex", background: "rgba(255,255,255,0.03)", border: "1px solid var(--hairline)", borderRadius: 8, padding: 2 }}>
            {PERIODS.map((p) => (
              <button key={p} type="button" onClick={() => setPeriod(p)} className="mono"
                style={{ background: period === p ? "rgba(255,255,255,0.08)" : "transparent", color: period === p ? "var(--text)" : "var(--text-3)", border: "none", borderRadius: 6, padding: "4px 9px", cursor: "pointer", fontSize: 11 }}>
                {p}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexShrink: 0, opacity: wf.confidence === "low" ? 0.55 : 1 }}>
          <StatTile label="Workflow health" value={health} accent={healthColor} grade={health == null ? null : gradeFor(health)} delta={pctDelta(wf.deltas.verificationStrength)} deltaGood="up" />
          <StatTile label="First-pass" value={rate(wf.firstPass)} unit="%" />
          <StatTile label="Self-recovered" value={rate(wf.recovered)} unit="%" accent="var(--warn)" />
          <StatTile label="Escalated" value={rate(wf.escalated)} unit="%" accent="var(--err)" />
        </div>

        <StepPerformancePanel detail={detail} loading={detail === null} openStep={openStep} onToggleStep={(name) => setOpenStep((o) => (o === name ? null : name))} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <SelfImprovementRail
          detail={detail}
          workflowName={wf.name}
          templateId={wfId}
          period={period}
          onMutated={() => setReloadKey((k) => k + 1)}
        />
      </div>
    </div>
  );
}

const linkBtn: React.CSSProperties = { background: "transparent", color: "var(--accent)", border: "none", cursor: "pointer", fontSize: 11, padding: "4px 6px" };
function rate(r: number | null): number | null { return r == null ? null : Math.round(r * 100); }
function pctDelta(d: number | null): number { return d == null ? 0 : Math.round(d * 100); }
function CenterNote({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-3)", fontSize: 13 }}>{children}</div>;
}

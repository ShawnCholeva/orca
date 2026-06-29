import { useState } from "react";
import { getWorkflowMetrics, gradeFor } from "./metrics-data";
import { StatTile } from "./metrics-charts";
import { StepPerformancePanel, WorkflowDropdown } from "./StepPerformance";
import { SelfImprovementRail } from "./SelfImprovement";
import { Workflow } from "./metrics-icons";

const PERIODS = ["24h", "7d", "30d"] as const;

export function MetricsPage() {
  const workflows = getWorkflowMetrics();
  const [wfId, setWfId] = useState(workflows[0].id);
  // Period toggle is display-only today — mock data has no time dimension; wired for the future real-data seam.
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("7d");
  const [openStep, setOpenStep] = useState<string | null>("Verify Proposal");
  const wf = workflows.find((w) => w.id === wfId) ?? workflows[0];

  const healthColor = wf.health >= 80 ? "var(--run)" : wf.health >= 70 ? "var(--warn)" : "var(--err)";

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 12, padding: 12, height: "100%", minHeight: 0, overflow: "hidden" }}>
      {/* LEFT */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <Workflow size={14} color="var(--text-3)" />
          <span className="mono" style={{ fontSize: 10.5, letterSpacing: 1.1, textTransform: "uppercase", color: "var(--text-3)", marginRight: 2 }}>Workflow</span>
          <WorkflowDropdown workflows={workflows} value={wfId} onChange={(id) => { setWfId(id); setOpenStep(null); }} />
          <div style={{ flex: 1 }} />
          <div style={{ display: "flex", background: "rgba(255,255,255,0.03)", border: "1px solid var(--hairline)", borderRadius: 8, padding: 2 }}>
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPeriod(p)}
                className="mono"
                style={{ background: period === p ? "rgba(255,255,255,0.08)" : "transparent", color: period === p ? "var(--text)" : "var(--text-3)", border: "none", borderRadius: 6, padding: "4px 9px", cursor: "pointer", fontSize: 11 }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
          <StatTile label="Workflow health" value={wf.health} accent={healthColor} grade={gradeFor(wf.health)} delta={wf.healthDelta} deltaGood="up" spark={wf.steps[0].trend} sparkColor={healthColor} />
          <StatTile label="First-pass" value={wf.firstPass} unit="%" delta={wf.firstPassDelta} deltaGood="up" deltaSuffix="%" spark={wf.steps[0].trend} sparkColor="var(--accent)" />
          <StatTile label="Self-recovered" value={wf.recovered} unit="%" delta={wf.recoveredDelta} deltaGood="up" deltaSuffix="%" accent="var(--warn)" spark={wf.steps[1].trend} sparkColor="var(--warn)" />
          <StatTile label="Escalated" value={wf.escalated} unit="%" delta={wf.escalatedDelta} deltaGood="down" deltaSuffix="%" accent="var(--err)" spark={wf.steps[3]?.trend ?? wf.steps[0].trend} sparkColor="var(--err)" />
        </div>

        <StepPerformancePanel wf={wf} openStep={openStep} onToggleStep={(name) => setOpenStep((o) => (o === name ? null : name))} />
      </div>

      {/* RIGHT */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <SelfImprovementRail wf={wf} />
      </div>
    </div>
  );
}

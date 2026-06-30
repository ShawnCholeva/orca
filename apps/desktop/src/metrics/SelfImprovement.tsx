import type { TemplateMetricsDetail } from "@orca/contracts";
import { Panel } from "./metrics-charts";
import { statusForScore } from "./metrics-data";
import { Sparkle } from "./metrics-icons";

export function SelfImprovementRail({ detail, workflowName }: { detail: TemplateMetricsDetail | null; workflowName: string }) {
  const steps = detail?.steps ?? [];
  const attention = steps.filter((s) => statusForScore(s.score) !== "healthy").length;
  return (
    <Panel title="Self-improvement" kicker="ORCA LEARNS" style={{ flex: 1, minHeight: 0 }}
      bodyStyle={{ padding: 12, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.55, marginBottom: 12 }}>
        {attention > 0
          ? <>Orca sees <strong style={{ color: "var(--text)" }}>{attention} step{attention !== 1 ? "s" : ""} underperforming</strong> in {workflowName}.</>
          : <>Every step in {workflowName} is healthy.</>}
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", color: "var(--text-3)", gap: 8, padding: "24px 12px" }}>
        <Sparkle size={22} color="var(--text-4)" />
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-2)" }}>Learning loop not yet enabled</div>
        <div style={{ fontSize: 11.5, lineHeight: 1.5, maxWidth: 240 }}>
          Orca isn't proposing instruction changes yet. When the learning loop ships, drafted improvements and an activity log will appear here.
        </div>
      </div>
    </Panel>
  );
}

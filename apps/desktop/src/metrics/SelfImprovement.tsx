import { useEffect, useState } from "react";
import type { TemplateInstructionProposal, TemplateMetricsDetail } from "@orca/contracts";
import { analyzeTemplate, applyProposal, dismissProposal, listProposals, restoreTemplateDefault, rollbackProposal } from "../api";
import { Panel } from "./metrics-charts";
import { statusForScore } from "./metrics-data";
import { Sparkle } from "./metrics-icons";

type Props = {
  detail: TemplateMetricsDetail | null;
  workflowName: string;
  templateId: string | null;
  period: "24h" | "7d" | "30d";
  onMutated: () => void;
};

export function SelfImprovementRail({ detail, workflowName, templateId, period, onMutated }: Props) {
  const [proposals, setProposals] = useState<TemplateInstructionProposal[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [editing, setEditing] = useState<Record<string, string>>({});

  useEffect(() => {
    let live = true;
    if (templateId) listProposals(templateId, period).then((p) => { if (live) setProposals(p); }).catch(() => {});
    return () => { live = false; };
  }, [templateId, period]);

  const refresh = async () => { if (templateId) setProposals(await listProposals(templateId, period)); };

  const onAnalyze = async () => {
    if (!templateId) return;
    setAnalyzing(true);
    try { setProposals(await analyzeTemplate(templateId, period)); } finally { setAnalyzing(false); }
  };
  const onApply = async (p: TemplateInstructionProposal) => {
    await applyProposal(p.id, editing[p.id]); await refresh(); onMutated();
  };
  const onDismiss = async (p: TemplateInstructionProposal) => { await dismissProposal(p.id); await refresh(); };
  const onRollback = async (p: TemplateInstructionProposal) => { await rollbackProposal(p.id); await refresh(); onMutated(); };
  const onRestore = async () => { if (!templateId) return; await restoreTemplateDefault(templateId); await refresh(); onMutated(); };

  const pending = proposals.filter((p) => p.status === "pending");
  const applied = proposals.filter((p) => p.status === "applied");
  const history = proposals.filter((p) => ["dismissed", "rolled_back", "superseded"].includes(p.status));
  const steps = detail?.steps ?? [];
  const attention = steps.filter((s) => statusForScore(s.score) !== "healthy").length;

  return (
    <Panel title="Self-improvement" kicker="ORCA LEARNS" style={{ flex: 1, minHeight: 0 }}
      bodyStyle={{ padding: 12, display: "flex", flexDirection: "column", minHeight: 0, gap: 12, overflowY: "auto" }}>
      <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.55 }}>
        {attention > 0
          ? <>Orca sees <strong style={{ color: "var(--text)" }}>{attention} step{attention !== 1 ? "s" : ""} underperforming</strong> in {workflowName}.</>
          : <>Every step in {workflowName} is healthy.</>}
      </div>

      <button type="button" onClick={onAnalyze} disabled={analyzing || !templateId} style={{ alignSelf: "flex-start" }}>
        {analyzing ? "Reviewing runs…" : "Analyze this template"}
      </button>

      {!analyzing && pending.length === 0 && applied.length === 0 && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", color: "var(--text-3)", gap: 8, padding: "16px 12px" }}>
          <Sparkle size={20} color="var(--text-4)" />
          <div style={{ fontSize: 12 }}>Nothing to propose — steps are healthy or below the sample threshold.</div>
        </div>
      )}

      {pending.map((p) => (
        <div key={p.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, fontSize: 12 }}>
          <div style={{ fontWeight: 600 }}>{p.stepTemplateId}</div>
          <div style={{ color: "var(--text-3)" }}>
            targets {p.targetedFailureMode.failureCode ?? p.targetedFailureMode.rule}
            {p.targetedFailureMode.clusterCount != null ? ` (${p.targetedFailureMode.clusterCount})` : ""}
            {p.targetedFailureMode.signalCount != null ? ` · ${p.targetedFailureMode.signalCount} re-steers` : ""}
          </div>
          <div style={{ marginTop: 6 }}>
            <div style={{ color: "var(--danger)", textDecoration: "line-through", whiteSpace: "pre-wrap" }}>{p.beforeInstructions}</div>
            <textarea defaultValue={p.afterInstructions} onChange={(e) => setEditing((s) => ({ ...s, [p.id]: e.target.value }))} style={{ width: "100%", marginTop: 4 }} />
          </div>
          <div style={{ marginTop: 6, color: "var(--text-2)" }}>Predicts: {p.predictedImprovement}</div>
          <div style={{ color: "var(--text-3)" }}>Preserves: {p.invariantsPreserved.join(", ") || "—"}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" onClick={() => onApply(p)}>Apply</button>
            <button type="button" onClick={() => onDismiss(p)}>Dismiss</button>
          </div>
        </div>
      ))}

      {applied.map((p) => (
        <div key={p.id} style={{ border: `1px solid ${p.regressionDetected ? "var(--danger)" : "var(--border)"}`, borderRadius: 8, padding: 10, fontSize: 12 }}>
          <div style={{ fontWeight: 600 }}>{p.stepTemplateId} · applied as v{p.appliedAsVersion}</div>
          <div style={{ color: "var(--text-3)" }}>
            {p.regressionDetected ? "Regression detected" : "Watching"}
            {p.watchedDeltas && Object.keys(p.watchedDeltas).length > 0
              ? " · " + Object.entries(p.watchedDeltas).map(([k, v]) => `${k} ${v == null ? "—" : v.toFixed(2)}`).join(", ")
              : " · awaiting runs"}
          </div>
          {p.regressionDetected && <button type="button" onClick={() => onRollback(p)} style={{ marginTop: 8 }}>Rollback</button>}
        </div>
      ))}

      {history.length > 0 && (
        <details>
          <summary style={{ fontSize: 11.5, color: "var(--text-3)", cursor: "pointer" }}>Activity log ({history.length})</summary>
          {history.map((p) => (
            <div key={p.id} style={{ fontSize: 11, color: "var(--text-3)", padding: "4px 0" }}>
              {p.stepTemplateId} — {p.status}{p.decidedBy ? ` by ${p.decidedBy}` : ""}{p.decidedAt ? ` · ${p.decidedAt.slice(0, 10)}` : ""}
            </div>
          ))}
        </details>
      )}

      <button type="button" onClick={onRestore} style={{ alignSelf: "flex-start", fontSize: 11, color: "var(--text-3)" }}>
        Restore default built-in
      </button>
    </Panel>
  );
}

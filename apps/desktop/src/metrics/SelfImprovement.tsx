import { useEffect, useRef, useState } from "react";
import type { TemplateInstructionProposal, TemplateMetricsDetail } from "@orca/contracts";
import { analyzeTemplate, applyProposal, dismissProposal, judgeProposal, listProposals, restoreTemplateDefault, rollbackProposal, toErrorMessage } from "../api";
import { Panel } from "./metrics-charts";
import { statusForStep } from "./metrics-data";
import { Sparkle } from "./metrics-icons";
import { diffLines, schemaChips, type DiffLine, type SchemaChip } from "./proposal-diff";

function ChipRow({ chips }: { chips: SchemaChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {chips.map((c, i) => (
        <span key={i} style={{ fontSize: 11, color: c.kind === "added" ? "var(--run)" : "var(--text-2)", background: "rgba(255,255,255,0.04)", border: "1px solid var(--hairline)", borderRadius: 6, padding: "2px 6px" }}>
          {c.label}
        </span>
      ))}
    </div>
  );
}

function DiffBlock({ lines }: { lines: DiffLine[] }) {
  return (
    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 11.5, maxHeight: 240, overflow: "auto" }}>
      {lines.map((l, i) => (
        <div key={i} style={{ color: l.kind === "removed" ? "var(--err)" : l.kind === "added" ? "var(--run)" : "var(--text-3)" }}>
          {l.kind === "removed" ? "− " : l.kind === "added" ? "+ " : "  "}{l.text}
        </div>
      ))}
    </pre>
  );
}

type Props = {
  detail: TemplateMetricsDetail | null;
  workflowName: string;
  templateId: string | null;
  period: "24h" | "7d" | "30d";
  onMutated: () => void;
};

const VERDICT_META: Record<string, { label: string; icon: string }> = {
  pass: { label: "pass", icon: "✓" },
  regression_risk: { label: "regression risk", icon: "⚠" },
  uncertain: { label: "uncertain", icon: "?" },
  insufficient_evidence: { label: "insufficient evidence", icon: "—" },
  unavailable: { label: "unavailable", icon: "—" },
};

export function SelfImprovementRail({ detail, workflowName, templateId, period, onMutated }: Props) {
  const [proposals, setProposals] = useState<TemplateInstructionProposal[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [judging, setJudging] = useState<Record<string, boolean>>({});
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  useEffect(() => {
    let live = true;
    if (templateId) listProposals(templateId, period).then((p) => { if (live) setProposals(p); }).catch(() => {});
    return () => { live = false; };
  }, [templateId, period]);

  const refresh = async () => {
    if (!templateId) return;
    const capturedId = templateId;
    const ps = await listProposals(capturedId, period);
    if (mountedRef.current && capturedId === templateId) setProposals(ps);
  };

  const onAnalyze = async () => {
    if (!templateId) return;
    setAnalyzing(true);
    try { setProposals(await analyzeTemplate(templateId, period)); } finally { setAnalyzing(false); }
  };
  const onApply = async (p: TemplateInstructionProposal) => {
    try { setError(null); await applyProposal(p.id, editing[p.id]); await refresh(); onMutated(); }
    catch (err) { setError(toErrorMessage(err, "Failed to apply proposal.")); }
  };
  const onJudge = async (p: TemplateInstructionProposal) => {
    setJudging((s) => ({ ...s, [p.id]: true }));
    try { setError(null); await judgeProposal(p.id); await refresh(); }
    catch (err) { setError(toErrorMessage(err, "Failed to evaluate proposal.")); }
    finally { setJudging((s) => ({ ...s, [p.id]: false })); }
  };
  const onDismiss = async (p: TemplateInstructionProposal) => {
    try { setError(null); await dismissProposal(p.id); await refresh(); }
    catch (err) { setError(toErrorMessage(err, "Failed to dismiss proposal.")); }
  };
  const onRollback = async (p: TemplateInstructionProposal) => {
    try { setError(null); await rollbackProposal(p.id); await refresh(); onMutated(); }
    catch (err) { setError(toErrorMessage(err, "Failed to rollback proposal.")); }
  };
  const onRestore = async () => {
    if (!templateId) return;
    try { setError(null); await restoreTemplateDefault(templateId); await refresh(); onMutated(); }
    catch { setError("No learned changes to restore."); }
  };

  const pending = proposals.filter((p) => p.status === "pending");
  const applied = proposals.filter((p) => p.status === "applied");
  const history = proposals.filter((p) => ["dismissed", "rolled_back", "superseded"].includes(p.status));
  const steps = detail?.steps ?? [];
  const attention = steps.filter((s) => statusForStep(s) !== "healthy").length;

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

      {error && <div style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div>}

      {!analyzing && pending.length === 0 && applied.length === 0 && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", color: "var(--text-3)", gap: 8, padding: "16px 12px" }}>
          <Sparkle size={20} color="var(--text-4)" />
          <div style={{ fontSize: 12 }}>Nothing to propose — steps are healthy or below the sample threshold.</div>
        </div>
      )}

      {pending.map((p) => {
        const diff = diffLines(p.beforeInstructions, p.afterInstructions);
        const chips = p.component === "step_output_schema" ? schemaChips(p.beforeInstructions, p.afterInstructions) : [];
        const changedCount = diff.filter((d) => d.kind !== "kept").length;
        return (
          <div key={p.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, fontSize: 12 }}>
            <div style={{ fontWeight: 600 }}>{p.stepTemplateId}</div>
            <div style={{ color: "var(--text-3)" }}>
              targets {p.targetedFailureMode.failureCode ?? p.targetedFailureMode.rule}
              {p.targetedFailureMode.clusterCount != null ? ` (${p.targetedFailureMode.clusterCount})` : ""}
              {p.targetedFailureMode.signalCount != null ? ` · ${p.targetedFailureMode.signalCount} re-steers` : ""}
            </div>
            <div style={{ marginTop: 6 }}>
              {p.component === "step_output_schema"
                ? <ChipRow chips={chips} />
                : <div style={{ color: "var(--text-2)" }}>{changedCount} line{changedCount === 1 ? "" : "s"} changed</div>}
              <button type="button" onClick={() => setReviewing(p.id)} style={{ marginTop: 6 }}>Review change</button>
            </div>
            <div style={{ marginTop: 6, color: "var(--text-2)" }}>Predicts: {p.predictedImprovement}</div>
            <div style={{ color: "var(--text-3)" }}>Preserves: {p.invariantsPreserved.join(", ") || "—"}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" onClick={() => onApply(p)}>Apply</button>
              <button type="button" onClick={() => onDismiss(p)}>Dismiss</button>
            </div>

            {reviewing === p.id && (
              <div style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div role="dialog" aria-modal="true" aria-label={`Review change — ${p.stepTemplateId}`}
                  style={{ width: "min(560px, 90vw)", maxHeight: "80vh", overflowY: "auto", background: "var(--panel)", border: "1px solid var(--hairline-strong)", borderRadius: 10, boxShadow: "0 16px 48px rgba(0,0,0,0.5)", padding: 16 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>{p.stepTemplateId} — review change</div>
                  {p.component === "step_output_schema" && chips.length > 0 && <div style={{ marginBottom: 8 }}><ChipRow chips={chips} /></div>}
                  <DiffBlock lines={diff} />
                  <textarea value={editing[p.id] ?? p.afterInstructions} onChange={(e) => setEditing((s) => ({ ...s, [p.id]: e.target.value }))} rows={6} style={{ width: "100%", marginTop: 8, fontFamily: "inherit", fontSize: 11.5 }} />
                  <div style={{ marginTop: 8, color: "var(--text-2)" }}>Predicts: {p.predictedImprovement}</div>
                  <div style={{ color: "var(--text-3)" }}>Preserves: {p.invariantsPreserved.join(", ") || "—"}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button type="button" onClick={() => onApply(p)}>Apply</button>
                    <button type="button" onClick={() => onDismiss(p)}>Dismiss</button>
                    <button type="button" onClick={() => setReviewing(null)}>Close</button>
                  </div>
                </div>
              </div>
            )}

            {p.judgment ? (
              <div style={{ marginTop: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                <div style={{ fontWeight: 600 }}>
                  {VERDICT_META[p.judgment.verdict]?.label ?? p.judgment.verdict} {VERDICT_META[p.judgment.verdict]?.icon ?? ""}
                </div>
                {p.judgment.reason && <div style={{ color: "var(--text-2)" }}>{p.judgment.reason}</div>}
                {p.judgment.regressionCases.length > 0 && (
                  <ul style={{ margin: "4px 0", paddingLeft: 16 }}>
                    {p.judgment.regressionCases.map((c) => <li key={c}>{c}</li>)}
                  </ul>
                )}
                <div style={{ color: "var(--text-3)" }}>
                  judged {p.judgment.solvedSampleSize} solved · {p.judgment.failureSampleSize} failure cases
                </div>
                {(p.judgment.solvedCaseIds.length > 0 || p.judgment.failureCaseIds.length > 0) && (
                  <div style={{ color: "var(--text-3)" }}>
                    {p.judgment.solvedCaseIds.length > 0 && <>solved: {p.judgment.solvedCaseIds.join(", ")}</>}
                    {p.judgment.solvedCaseIds.length > 0 && p.judgment.failureCaseIds.length > 0 ? " · " : ""}
                    {p.judgment.failureCaseIds.length > 0 && <>failed: {p.judgment.failureCaseIds.join(", ")}</>}
                  </div>
                )}
                {p.judgment.reasoning && (
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ color: "var(--text-3)", cursor: "pointer" }}>How the reviewer worked through it</summary>
                    <div style={{ color: "var(--text-2)" }}>{p.judgment.reasoning}</div>
                  </details>
                )}
              </div>
            ) : (
              <button type="button" onClick={() => onJudge(p)} disabled={!!judging[p.id]} style={{ marginTop: 8 }}>
                {judging[p.id] ? "Evaluating…" : "Evaluate this edit"}
              </button>
            )}
          </div>
        );
      })}

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

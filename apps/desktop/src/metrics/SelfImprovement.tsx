import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { LearningEvent, TemplateInstructionProposal, TemplateMetricsDetail } from "@orca/contracts";
import { labelForFailure } from "@orca/contracts";
import { analyzeTemplate, applyProposal, dismissProposal, judgeProposal, listLearningEvents, rollbackProposal, toErrorMessage } from "../api";
import { Btn, Pill } from "../workspaces/primitives";
import { eventLine, synthesizedLine, VERDICT_META } from "./learning-log";
import { Panel } from "./metrics-charts";
import { statusForStep, statusMeta } from "./metrics-data";
import { Check, Sparkle } from "./metrics-icons";
import { diffLines, schemaChips, type SchemaChip } from "./proposal-diff";

// mock card + modal chrome uses the app's token set (workspaces/primitives ported the same
// Btn/Pill from the design prototype these panels were mocked in).
const cardStyle: CSSProperties = { border: "1px solid var(--hairline)", borderRadius: 10, background: "var(--panel-2)", padding: 11, display: "flex", flexDirection: "column", gap: 8, fontSize: 12 };
const componentLabel = (c: string) => (c === "step_output_schema" ? "output check" : c === "step_instructions" ? "instructions" : c.replace(/_/g, " "));

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

type Props = {
  detail: TemplateMetricsDetail | null;
  workflowName: string;
  templateId: string | null;
  period: "24h" | "7d" | "30d";
  onMutated: () => void;
  proposals: TemplateInstructionProposal[];
  onReview: (id: string) => void;
  refetchProposals: () => Promise<void>;
};

export function SelfImprovementRail({ detail, workflowName, templateId, period, onMutated, proposals, onReview, refetchProposals }: Props) {
  const [events, setEvents] = useState<LearningEvent[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [judging, setJudging] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  useEffect(() => {
    let live = true;
    if (templateId) {
      listLearningEvents(templateId).then((e) => { if (live) setEvents(e); }).catch(() => {});
    }
    return () => { live = false; };
  }, [templateId, period]);

  const refresh = async () => {
    if (!templateId) return;
    const capturedId = templateId;
    await refetchProposals();
    try {
      const evs = await listLearningEvents(capturedId);
      if (mountedRef.current && capturedId === templateId) setEvents(evs);
    } catch { /* best-effort — proposals remain the source of truth for this refresh */ }
  };

  const onAnalyze = async () => {
    if (!templateId) return;
    setAnalyzing(true);
    try {
      await analyzeTemplate(templateId, period);
      await refetchProposals();
      // The run just wrote created/analyzed events — refetch or the log stays stale.
      const evs = await listLearningEvents(templateId).catch(() => null);
      if (evs && mountedRef.current) setEvents(evs);
    } finally { setAnalyzing(false); }
  };
  const onApply = async (p: TemplateInstructionProposal) => {
    // Card-level Apply applies unedited — editing now lives in ProposalReviewModal (opened via
    // onReview), which calls applyProposal(id, edited) itself. Noted behavior change.
    try { setError(null); await applyProposal(p.id); await refresh(); onMutated(); }
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

  const pending = proposals.filter((p) => p.status === "pending");
  const applied = proposals.filter((p) => p.status === "applied");
  const steps = detail?.steps ?? [];
  const attention = steps.filter((s) => statusForStep(s) !== "healthy").length;
  const stepName = (id: string | null) => (id ? steps.find((s) => s.stepTemplateId === id)?.name ?? id : "the template");
  const stepDotColor = (id: string) => {
    const s = steps.find((x) => x.stepTemplateId === id);
    return s ? statusMeta[statusForStep(s)].color : "var(--text-4)";
  };
  const eventedProposalIds = new Set(events.map((e) => e.proposalId).filter((id): id is string => id != null));
  // Only decided proposals fall back to a synthesized row — a still-pending/applied
  // proposal already has its own card above, so there's nothing "misleadingly empty"
  // about it missing from the log (this fallback is for pre-SP3 backlog rows).
  const unevented = proposals.filter((p) => !eventedProposalIds.has(p.id) && ["dismissed", "rolled_back", "superseded"].includes(p.status));
  const logCount = events.length + unevented.length;
  // Honest empty state: events arrive newest-first, so the first "analyzed" event is the
  // latest review. If it diagnosed steps but drafted nothing, don't claim steps are healthy.
  const lastAnalyzed = events.find((e) => e.payload.kind === "analyzed")?.payload;
  const lastReviewStalled = lastAnalyzed?.kind === "analyzed" && lastAnalyzed.proposalsCreated === 0 && lastAnalyzed.skips.length > 0
    ? lastAnalyzed : null;

  return (
    <>
    <Panel title="Self-improvement" kicker="ORCA LEARNS" style={{ flex: 1, minHeight: 0 }}
      bodyStyle={{ padding: 12, display: "flex", flexDirection: "column", minHeight: 0, gap: 12, overflowY: "auto" }}>
      <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.55 }}>
        {attention > 0
          ? pending.length > 0
            ? <>Orca flagged <strong style={{ color: "var(--text)" }}>{attention} underperforming step{attention !== 1 ? "s" : ""}</strong> in {workflowName} and drafted {pending.length} change{pending.length !== 1 ? "s" : ""}. Review each to let it improve itself.</>
            : <>Orca sees <strong style={{ color: "var(--text)" }}>{attention} step{attention !== 1 ? "s" : ""} underperforming</strong> in {workflowName}. Analyze to draft fixes.</>
          : <>Every step in {workflowName} is healthy.</>}
      </div>

      <div style={{ display: "flex", justifyContent: "center" }}>
        <Btn kind="primary" size="sm" onClick={onAnalyze} disabled={analyzing || !templateId}>
          {analyzing ? "Reviewing runs…" : "Analyze this template"}
        </Btn>
      </div>

      {error && <div style={{ fontSize: 12, color: "var(--err)" }}>{error}</div>}

      {!analyzing && pending.length === 0 && applied.length === 0 && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", color: "var(--text-3)", gap: 8, padding: "16px 12px" }}>
          <Sparkle size={20} color="var(--text-4)" />
          <div style={{ fontSize: 12 }}>
            {lastReviewStalled
              ? `The last review flagged ${lastReviewStalled.stepsDiagnosed} step${lastReviewStalled.stepsDiagnosed === 1 ? "" : "s"} but couldn't draft a change — the Learning log below records why.`
              : "Nothing to propose — steps are healthy or below the sample threshold."}
          </div>
        </div>
      )}

      {pending.map((p) => {
        const diff = diffLines(p.beforeInstructions, p.afterInstructions);
        const chips = p.component === "step_output_schema" ? schemaChips(p.beforeInstructions, p.afterInstructions) : [];
        const changedCount = diff.filter((d) => d.kind !== "kept").length;
        return (
          <div key={p.id} style={cardStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: stepDotColor(p.stepTemplateId), flexShrink: 0 }} />
              <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{stepName(p.stepTemplateId)}</span>
              <div style={{ flex: 1 }} />
              <Pill tone="neutral" size="xs">{componentLabel(p.component)}</Pill>
            </div>

            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", lineHeight: 1.35 }}>{p.predictedImprovement}</div>

            <div style={{ color: "var(--text-3)", fontSize: 11.5 }}>
              targets {p.targetedFailureMode.failureCode ? labelForFailure(p.targetedFailureMode.failureCode) : p.targetedFailureMode.rule}
              {p.targetedFailureMode.clusterCount != null ? ` (${p.targetedFailureMode.clusterCount})` : ""}
              {p.targetedFailureMode.signalCount != null ? ` · ${p.targetedFailureMode.signalCount} re-steers` : ""}
            </div>

            {p.component === "step_output_schema"
              ? (chips.length > 0
                ? <ChipRow chips={chips} />
                : <div style={{ color: "var(--text-2)" }}>Adds required structure — open Review change.</div>)
              : <div style={{ color: "var(--text-2)" }}>{changedCount} line{changedCount === 1 ? "" : "s"} changed</div>}

            <div style={{ color: "var(--text-3)", fontSize: 11.5 }}>Preserves: {p.invariantsPreserved.join(", ") || "—"}</div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <Btn kind="quiet" size="xs" onClick={() => onReview(p.id)}>Review change</Btn>
              <Btn kind="primary" size="xs" icon={<Check />} onClick={() => onApply(p)}>Apply</Btn>
              <Btn kind="ghost" size="xs" onClick={() => onDismiss(p)}>Dismiss</Btn>
            </div>

            {p.judgment ? (
              <div style={{ marginTop: 4, borderTop: "1px solid var(--hairline)", paddingTop: 8 }}>
                <div style={{ fontWeight: 600, color: statusMeta.watch.color }}>
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
              <div style={{ display: "flex" }}>
                <Btn kind="quiet" size="xs" onClick={() => onJudge(p)} disabled={!!judging[p.id]}>
                  {judging[p.id] ? "Evaluating…" : "Evaluate this edit"}
                </Btn>
              </div>
            )}
          </div>
        );
      })}

      {applied.map((p) => (
        <div key={p.id} style={{ ...cardStyle, border: `1px solid ${p.regressionDetected ? "var(--err)" : "var(--hairline)"}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{stepName(p.stepTemplateId)}</span>
            <div style={{ flex: 1 }} />
            <Pill tone={p.regressionDetected ? "err" : "run"} size="xs">v{p.appliedAsVersion}</Pill>
          </div>
          <div style={{ color: "var(--text-3)" }}>
            {p.regressionDetected ? "Regression detected" : "Watching"}
            {p.watchedDeltas && Object.keys(p.watchedDeltas).length > 0
              ? " · " + Object.entries(p.watchedDeltas).map(([k, v]) => `${k} ${v == null ? "—" : v.toFixed(2)}`).join(", ")
              : " · awaiting runs"}
          </div>
          {(() => {
            const pair = p.targetDeltaVersions;
            const versionText = pair ? `v${pair.prior}→v${pair.latest}` : null;
            if (p.targetDelta == null) return (
              <div style={{ color: "var(--text-3)", marginTop: 4 }}>Target step: awaiting data — needs 2 scored runs on each version.</div>
            );
            const pts = Math.round(p.targetDelta * 100);
            return (
              <div style={{ color: p.targetImproved ? "var(--run)" : "var(--warn)", marginTop: 4 }}>
                Target step: {p.targetImproved
                  ? `improved +${pts} points${versionText ? ` (${versionText})` : ""}`
                  : `not improved (${pts} points${versionText ? `, ${versionText}` : ""})`}.
              </div>
            );
          })()}
          {/* mirrors SCHEMA_INVALID_OUTPUT_THRESHOLD (daemon canary.ts) — regressionDetected still gates the button */}
          {p.component === "step_output_schema" && p.invalidOutputRateDelta != null && p.invalidOutputRateDelta > 0.2 && (
            <div style={{ color: "var(--err)", marginTop: 4 }}>
              New checks are rejecting output (+{Math.round(p.invalidOutputRateDelta * 100)}% of runs) — consider rollback.
            </div>
          )}
          {p.regressionDetected && (
            <div style={{ display: "flex" }}>
              <Btn kind="danger" size="xs" onClick={() => onRollback(p)}>Rollback</Btn>
            </div>
          )}
        </div>
      ))}

    </Panel>

    <Panel title="Learning" kicker="OVER TIME"
      right={<span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{logCount} event{logCount !== 1 ? "s" : ""}</span>}
      style={{ flex: 1, minHeight: 0 }}
      bodyStyle={{ padding: "4px 12px 12px", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div className="scroll" style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {logCount === 0 && (
          <div style={{ color: "var(--text-3)", fontSize: 12, textAlign: "center", padding: "16px 0" }}>No learning events yet.</div>
        )}
        {(() => {
          // Collapse adjacent identical lines (repeat analyze runs with the same outcome)
          // into one row with a repeat count — every event is still counted in the header.
          const rows: { key: string; at: string; text: string; count: number }[] = [];
          for (const e of events) {
            const text = eventLine(e, stepName);
            const last = rows[rows.length - 1];
            if (last && last.text === text) { last.count++; continue; }
            rows.push({ key: e.id, at: e.createdAt, text, count: 1 });
          }
          return rows.map((r) => (
            <div key={r.key} style={{ fontSize: 11.5, color: "var(--text-2)", padding: "7px 0", borderBottom: "1px solid var(--hairline)", lineHeight: 1.5 }}>
              <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{r.at.slice(0, 16).replace("T", " ")}</span> {r.text}
              {r.count > 1 && <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", marginLeft: 6 }}>×{r.count}</span>}
            </div>
          ));
        })()}
        {unevented.map((p) => (
          <div key={p.id} style={{ fontSize: 11.5, color: "var(--text-3)", padding: "7px 0", borderBottom: "1px solid var(--hairline)", lineHeight: 1.5 }}>
            {synthesizedLine(p, stepName)}
          </div>
        ))}
      </div>
    </Panel>
    </>
  );
}

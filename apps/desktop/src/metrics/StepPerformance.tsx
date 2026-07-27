import { useEffect, useRef, useState } from "react";
import type { SampleDetail, StepMetrics, TemplateInstructionProposal, TemplateMetricsDetail, TemplateMetricsSummary } from "@orca/contracts";
import { labelForFailure, labelForConfidenceReason } from "@orca/contracts";
import { getSampleDetail } from "../api";
import { Pill } from "../workspaces/primitives";
import { bandMeta, channelsFor, gradeFor, statusForStep, statusMeta, toneColor, verdictFor } from "./metrics-data";
import { Panel, SectionLabel, Sparkline, VersionHistoryStrip, VersionMarkerChips } from "./metrics-charts";
import { ChevronDown, ChevronRight, Sparkle, Workflow } from "./metrics-icons";

// Simple relative-time label — the desktop has no existing helper for this.
function relativeTime(iso: string): string {
  const diffSec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

type SampleState = { status: "loading" } | { status: "error" } | { status: "ok"; sample: SampleDetail };

// Fetches each sample in the cluster, up to 3 at a time, tracking per-id loading/error state.
function useSampleDetails(transitionIds: string[]): Record<string, SampleState> {
  const [samples, setSamples] = useState<Record<string, SampleState>>({});
  useEffect(() => {
    let live = true;
    setSamples(Object.fromEntries(transitionIds.map((id) => [id, { status: "loading" } as SampleState])));
    let next = 0;
    async function worker() {
      while (next < transitionIds.length) {
        const id = transitionIds[next++]!;
        try {
          const sample = await getSampleDetail(id);
          if (live) setSamples((s) => ({ ...s, [id]: { status: "ok", sample } }));
        } catch {
          if (live) setSamples((s) => ({ ...s, [id]: { status: "error" } }));
        }
      }
    }
    for (let i = 0; i < Math.min(3, transitionIds.length); i++) worker();
    return () => { live = false; };
  }, [transitionIds]);
  return samples;
}

function SamplePeek({ transitionIds, onOpenGoal }: { transitionIds: string[]; onOpenGoal?: (goalId: string) => void }) {
  const samples = useSampleDetails(transitionIds);
  return (
    <div style={{ marginTop: 4, marginBottom: 6, background: "var(--accent-soft)", border: "1px solid var(--accent-line)", borderRadius: 8, overflow: "hidden" }}>
      {transitionIds.map((id) => {
        const state = samples[id];
        if (!state || state.status === "loading") {
          return <div key={id} style={{ padding: "8px 11px", fontSize: 11.5, color: "var(--text-3)", borderTop: "1px solid var(--hairline)" }}>Loading run {id.slice(0, 6)}…</div>;
        }
        if (state.status === "error") {
          return <div key={id} style={{ padding: "8px 11px", fontSize: 11.5, color: "var(--err)", borderTop: "1px solid var(--hairline)" }}>Couldn't load this sample.</div>;
        }
        const { sample } = state;
        return (
          <div key={id} style={{ padding: "9px 11px", borderTop: "1px solid var(--hairline)" }}>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--text-3)", marginBottom: 5 }}>
              run {sample.transitionId.slice(0, 6)} · {relativeTime(sample.createdAt)}{sample.templateVersion != null ? ` · v${sample.templateVersion}` : ""}
            </div>
            {sample.checks.map((c, i) => (
              <div key={i} style={{ fontSize: 12, color: "var(--text-2)", display: "flex", gap: 6, flexWrap: "wrap", padding: "2px 0" }}>
                <span style={{ fontWeight: 600 }}>{c.label}</span>
                {c.detail && (<><span style={{ color: "var(--text-4)" }}>—</span><span style={{ color: "var(--text-3)" }}>{c.detail}</span></>)}
              </div>
            ))}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
              <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{labelForFailure(sample.failureCode)}</span>
              {onOpenGoal && (
                <button type="button" onClick={() => onOpenGoal(sample.goalId)} style={{ background: "transparent", border: "none", color: "var(--accent)", fontSize: 11, cursor: "pointer", padding: 0 }}>
                  open full run →
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const GRID = "34px minmax(0,1fr) 88px 64px 22px";

export function WorkflowDropdown({ summaries, value, onChange }: { summaries: TemplateMetricsSummary[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = summaries.find((w) => w.templateId === value) ?? summaries[0];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 8, background: open ? "var(--accent-soft)" : "rgba(255,255,255,0.03)", border: `1px solid ${open ? "var(--accent-line)" : "var(--hairline)"}`, color: "var(--text)", borderRadius: 8, padding: "5px 9px 5px 11px", cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 500, minWidth: 200 }}>
        <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cur.name}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{cur.runs} runs</span>
        <ChevronDown size={13} color="var(--text-3)" style={{ transform: open ? "rotate(180deg)" : "none" }} />
      </button>
      {open && (
        <div className="scroll" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 30, minWidth: 260, maxHeight: 320, overflow: "auto", background: "var(--panel)", border: "1px solid var(--hairline-strong)", borderRadius: 10, boxShadow: "0 16px 48px rgba(0,0,0,0.5)", padding: 4 }}>
          {summaries.map((w) => {
            const active = w.templateId === value;
            return (
              <button key={w.templateId} type="button" onClick={() => { onChange(w.templateId); setOpen(false); }}
                style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", background: active ? "var(--accent-soft)" : "transparent", border: "none", borderRadius: 7, padding: "8px 10px", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                <Workflow size={13} color={active ? "var(--accent)" : "var(--text-3)"} />
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, color: active ? "var(--accent)" : "var(--text)" }}>{w.name}</span>
                <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{w.runs}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function StepRow({ step, index, isLast, open, onToggle, onOpenGoal, proposalForStep, onReviewProposal }: { step: StepMetrics; index: number; isLast: boolean; open: boolean; onToggle: () => void; onOpenGoal?: (goalId: string) => void; proposalForStep?: TemplateInstructionProposal; onReviewProposal?: (id: string) => void }) {
  const [openClusterIdx, setOpenClusterIdx] = useState<number | null>(null);
  const status = statusForStep(step);
  const m = statusMeta[status];
  const low = step.confidence === "low";
  const verdict = verdictFor(step);
  const channels = channelsFor(step);
  const channelCells: [string, ReturnType<typeof channelsFor>["doing"]][] = [
    ["How it's doing", channels.doing],
    ["How we check it", channels.check],
    ["Anything wrong", channels.wrong],
  ];
  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid var(--hairline)", opacity: low ? 0.6 : 1 }}>
      <div onClick={onToggle} style={{ display: "grid", gridTemplateColumns: GRID, alignItems: "center", gap: 12, padding: "12px 14px", cursor: "pointer" }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, border: `1px solid ${m.color}`, background: `color-mix(in srgb, ${m.color} 12%, transparent)`, color: m.color, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 600 }}>
            {String(index + 1).padStart(2, "0")}
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{step.name}</span>
            <Pill tone={bandMeta[step.verification.band.level].tone} size="xs">{step.verification.band.label}</Pill>
            {low && <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }} title={`Based on only ${step.sampleSize} run${step.sampleSize === 1 ? "" : "s"} — low confidence (fewer than 5). Scores here can swing as more runs accrue.`}>n={step.sampleSize}</span>}
            <VersionMarkerChips history={step.versionHistory} />
          </div>
          {step.description && (
            <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {step.description}
            </div>
          )}
          <div style={{ marginTop: 6, fontSize: 12 }}>
            <span style={{ fontWeight: 600, color: toneColor[verdict.tone] }}>{verdict.health}</span>
            <span style={{ color: "var(--text-3)" }}> — {verdict.cause}</span>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            {channelCells.map(([label, ch]) => (
              <div key={label} style={{ flex: 1, minWidth: 0, background: "rgba(255,255,255,0.02)", border: "1px solid var(--hairline)", borderRadius: 7, padding: "5px 8px" }}>
                <div className="mono" style={{ fontSize: 8.5, letterSpacing: 0.6, textTransform: "uppercase", color: "var(--text-4)", marginBottom: 3 }}>{label}</div>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 5 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: toneColor[ch.tone], marginTop: 4, flexShrink: 0 }} />
                  <span style={{ fontSize: 11, color: "var(--text-2)", lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis" }}>{ch.text}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        {step.trend.length > 0 ? <Sparkline data={step.trend} color={m.color} w={84} h={26} /> : <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", textAlign: "center" }}>—</span>}
        <div style={{ textAlign: "right" }}>
          {step.score == null ? (
            // No conclusive verdict — show the coverage gap, not a failing grade it didn't earn.
            <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: m.color }} title="No independent check ran for this step yet — it's an opportunity to strengthen, not a failing grade.">needs a check</span>
          ) : (
            <>
              <span style={{ fontSize: 20, fontWeight: 600, color: m.color, letterSpacing: -0.5 }}>{step.score}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--text-4)" }}>/100 {gradeFor(step.score)}</span>
            </>
          )}
        </div>
        <ChevronRight size={13} color="var(--text-3)" style={{ transform: open ? "rotate(90deg)" : "none", justifySelf: "center" }} />
      </div>
      {open && (
        <div style={{ padding: "2px 16px 16px 60px" }}>
          <div style={{ background: "var(--panel-2)", border: "1px solid var(--hairline)", borderRadius: 10, padding: 12 }}>
            <SectionLabel style={{ paddingTop: 0 }}>What's going wrong</SectionLabel>
            {step.failureClusters.length === 0 && (
              step.confidenceReason
                ? <div style={{ fontSize: 12, color: "var(--warn)" }}>{labelForConfidenceReason(step.confidenceReason)}</div>
                : <div style={{ fontSize: 12, color: "var(--run)" }}>No problems detected this period.</div>
            )}
            {step.failureClusters.map((c, i) => (
              <div key={i}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: "var(--text-2)", padding: "3px 0" }}>
                  <span>{labelForFailure(c.failureCode)}</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{c.count}×</span>
                    {c.sampleTransitionIds.length > 0 && (
                      <button type="button" onClick={() => setOpenClusterIdx((o) => (o === i ? null : i))}
                        style={{ background: "transparent", border: "none", color: "var(--accent)", fontSize: 11, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                        {openClusterIdx === i ? "hide samples" : `view ${c.sampleTransitionIds.length} samples`}
                      </button>
                    )}
                  </span>
                </div>
                {openClusterIdx === i && c.sampleTransitionIds.length > 0 && (
                  <SamplePeek transitionIds={c.sampleTransitionIds} onOpenGoal={onOpenGoal} />
                )}
              </div>
            ))}
            {step.failureClusters.length > 0 && proposalForStep && (
              <div style={{ display: "flex", alignItems: "center", gap: 11, marginTop: 14, padding: "11px 12px", border: "1px solid var(--accent-line)", background: "var(--accent-2-soft)", borderRadius: 9 }}>
                <Sparkle size={15} color="var(--accent-2)" style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, fontSize: 12, color: "var(--text-2)" }}>
                  <b style={{ color: "var(--text)" }}>Orca drafted a fix:</b> {proposalForStep.predictedImprovement}
                </div>
                {onReviewProposal && (
                  <button type="button" onClick={() => onReviewProposal(proposalForStep.id)}
                    style={{ background: "transparent", border: "1px solid var(--accent-line)", color: "var(--accent-2)", borderRadius: 7, padding: "6px 11px", fontSize: 11, cursor: "pointer", whiteSpace: "nowrap", fontFamily: "inherit" }}>
                    Review change →
                  </button>
                )}
              </div>
            )}
            <VersionHistoryStrip history={step.versionHistory} />
          </div>
        </div>
      )}
    </div>
  );
}

export function StepPerformancePanel({ detail, loading, openStep, onToggleStep, onOpenGoal, proposalsByStep, onReviewProposal }: { detail: TemplateMetricsDetail | null; loading: boolean; openStep: string | null; onToggleStep: (name: string) => void; onOpenGoal?: (goalId: string) => void; proposalsByStep?: Map<string, TemplateInstructionProposal>; onReviewProposal?: (id: string) => void }) {
  const steps = detail?.steps ?? [];
  const attention = steps.filter((s) => { const st = statusForStep(s); return st === "watch" || st === "degraded" || st === "unverified"; }).length;
  return (
    <Panel title="Step performance" kicker={(detail?.summary.name ?? "").toUpperCase()}
      right={<span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{attention > 0 ? `${attention} need attention` : "all healthy"}</span>}
      style={{ flex: 1, minHeight: 0 }} bodyStyle={{ padding: 0, display: "flex", flexDirection: "column" }}>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        {loading && <div style={{ padding: 16, color: "var(--text-3)", fontSize: 12 }}>Loading steps…</div>}
        {!loading && steps.length === 0 && <div style={{ padding: 16, color: "var(--text-3)", fontSize: 12 }}>No step activity in this period.</div>}
        {steps.map((s, i) => (
          <StepRow key={s.stepTemplateId} step={s} index={i} isLast={i === steps.length - 1} open={openStep === s.name} onToggle={() => onToggleStep(s.name)} onOpenGoal={onOpenGoal} proposalForStep={proposalsByStep?.get(s.stepTemplateId)} onReviewProposal={onReviewProposal} />
        ))}
      </div>
    </Panel>
  );
}

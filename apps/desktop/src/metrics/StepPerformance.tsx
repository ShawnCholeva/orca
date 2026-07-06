import { useEffect, useRef, useState } from "react";
import type { StepMetrics, TemplateMetricsDetail, TemplateMetricsSummary } from "@orca/contracts";
import { Pill } from "../workspaces/primitives";
import { gradeFor, latencyLabel, statusForStep, statusMeta } from "./metrics-data";
import { OutcomeBar, Panel, SectionLabel, Sparkline } from "./metrics-charts";
import { ChevronDown, ChevronRight, Sparkle, Workflow } from "./metrics-icons";

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

function Chips({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div className="mono" style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-4)", marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {items.map((t, i) => <span key={i} style={{ fontSize: 11, color: "var(--text-2)", background: "rgba(255,255,255,0.04)", border: "1px solid var(--hairline)", borderRadius: 6, padding: "2px 6px" }}>{t}</span>)}
      </div>
    </div>
  );
}

export function StepRow({ step, index, isLast, open, onToggle }: { step: StepMetrics; index: number; isLast: boolean; open: boolean; onToggle: () => void }) {
  const status = statusForStep(step);
  const m = statusMeta[status];
  const low = step.confidence === "low";
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
            <Pill tone={status === "unverified" ? "accent" : m.tone} size="xs">{status === "unverified" ? "No check yet" : step.verification.tierLabel}</Pill>
            {low && <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }} title={`Based on only ${step.sampleSize} run${step.sampleSize === 1 ? "" : "s"} — low confidence (fewer than 5). Scores here can swing as more runs accrue.`}>n={step.sampleSize}</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
            <div style={{ flex: 1, maxWidth: 220 }}><OutcomeBar passed={step.passedFirstTry} recovered={step.recovered} failed={step.failed} /></div>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{step.runs} runs · {latencyLabel(step.cost.p50LatencyMs)}</span>
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
            {(() => {
              const rank = ["unverified", "self_reported", "ai_reviewed", "partially_verified", "verified_executed"].indexOf(step.verification.tier) + 1;
              return (
                <div style={{ display: "flex", gap: 3, marginBottom: 10 }}>
                  {[0, 1, 2, 3, 4].map((i) => <div key={i} style={{ height: 6, flex: 1, borderRadius: 3, background: i < rank ? "var(--warn)" : "rgba(255,255,255,0.08)" }} />)}
                </div>
              );
            })()}

            <SectionLabel style={{ paddingTop: 0 }}>What's going wrong</SectionLabel>
            {step.failureModes.length === 0 && <div style={{ fontSize: 12, color: "var(--run)" }}>No problems detected this period.</div>}
            {step.failureModes.map((f, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: "var(--text-2)", padding: "3px 0" }}>
                <span>{f.label}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{f.count}× · {Math.round(f.pct * 100)}%</span>
              </div>
            ))}

            <SectionLabel>Checks run</SectionLabel>
            {step.verification.artifacts.map((a, i) => (
              <div key={i} style={{ fontSize: 12, color: "var(--text-2)", padding: "2px 0" }}>
                {a.verifies}{a.cannotVerify ? <span style={{ color: "var(--text-4)" }}> — couldn't check: {a.cannotVerify}</span> : null}
              </div>
            ))}

            <Chips label="What we couldn't check" items={step.quality.untestedRegions} />
            <Chips label="Remaining risks" items={step.quality.residualRisk} />

            {step.risk.approvals.count > 0 && (
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-2)" }}>
                {step.risk.approvals.count} human approval(s) · {step.risk.hardConstraintViolations} hard-constraint violation(s)
              </div>
            )}

            {step.insights.length > 0 && (
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--hairline)" }}>
                {step.insights.map((t, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                    <Sparkle size={14} color="var(--accent-2)" style={{ flexShrink: 0, marginTop: 1 }} />
                    <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>{t}</div>
                  </div>
                ))}
              </div>
            )}

            {step.reconciliation && (
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--hairline)", fontSize: 12, color: step.reconciliation.refuted ? "var(--err)" : "var(--text-2)" }}>
                The AI <b>claimed</b> this step complete. Independently verified: <b>{step.reconciliation.verifiedTierLabel.toLowerCase()}</b>{step.reconciliation.refuted ? " — but the independent check overturned it." : "."}
                {step.reconciliation.refuted && step.reconciliation.refuteReason && (
                  <div style={{ marginTop: 4 }}>Why it was overturned: “{step.reconciliation.refuteReason}”</div>
                )}
              </div>
            )}

            {step.recentReasons.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="mono" style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-4)", marginBottom: 4 }}>Recent reasons</div>
                {step.recentReasons.map((r, i) => <div key={i} style={{ fontSize: 11.5, color: "var(--text-3)", padding: "2px 0" }}>{r.reason}</div>)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function StepPerformancePanel({ detail, loading, openStep, onToggleStep }: { detail: TemplateMetricsDetail | null; loading: boolean; openStep: string | null; onToggleStep: (name: string) => void }) {
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
          <StepRow key={s.stepTemplateId} step={s} index={i} isLast={i === steps.length - 1} open={openStep === s.name} onToggle={() => onToggleStep(s.name)} />
        ))}
      </div>
    </Panel>
  );
}

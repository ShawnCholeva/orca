import { useEffect, useState, type ComponentType } from "react";
import { Btn, Pill } from "../workspaces/primitives";
import { getLearningLog, statusMeta, type LearningLogEntry, type Proposal, type StepStatus, type WorkflowMetrics } from "./metrics-data";
import { Panel } from "./metrics-charts";
import { Check, ChevronLeft, Close, Spark, Sparkle } from "./metrics-icons";

export type Improvement = Proposal & { step: string; status: StepStatus };

export function ProposalModal({ imp, applied, onApply, onClose }: { imp: Improvement; applied: boolean; onApply: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={{ position: "absolute", inset: 0, zIndex: 50, background: "rgba(5,5,8,0.55)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", animation: "float-in 160ms ease" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 560, maxHeight: "85%", background: "var(--panel)", border: "1px solid var(--hairline-strong)", borderRadius: 14, boxShadow: "0 24px 80px rgba(0,0,0,0.55)", display: "flex", flexDirection: "column", overflow: "hidden" }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--hairline)" }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, background: "var(--accent-soft)", color: "var(--accent)", border: "1px solid var(--accent-line)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Sparkle size={15} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 10.5, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1.2 }}>Orca proposes</div>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--text-3)" }}>{imp.step}</div>
          </div>
          <Pill tone="run" size="xs">+{imp.lift} score</Pill>
          <Btn icon={<Close />} size="xs" onClick={onClose} />
        </header>

        <div className="scroll" style={{ flex: 1, padding: 18, overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", lineHeight: 1.35 }}>{imp.title}</div>

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ flex: 1, height: 5, background: "rgba(255,255,255,0.06)", borderRadius: 999, overflow: "hidden" }}>
              <div style={{ width: `${imp.confidence}%`, height: "100%", background: "var(--accent)" }} />
            </div>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-2)" }}>{imp.confidence}% confidence</span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ borderLeft: "2px solid var(--err)", paddingLeft: 10 }}>
              <div className="mono" style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-4)", marginBottom: 3 }}>Current instruction</div>
              <div style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.55 }}>{imp.before}</div>
            </div>
            <div style={{ borderLeft: "2px solid var(--run)", paddingLeft: 10 }}>
              <div className="mono" style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--run)", marginBottom: 3 }}>Proposed</div>
              <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55 }}>{imp.after}</div>
            </div>
          </div>
        </div>

        <footer style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--hairline)" }}>
          {applied ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--run)", fontWeight: 600 }}>
              <Check size={14} color="var(--run)" /> Applied · re-running {imp.step}
            </span>
          ) : (
            <>
              <div style={{ flex: 1 }} />
              <Btn kind="ghost" size="sm" onClick={onClose}>Dismiss</Btn>
              <Btn kind="primary" size="sm" icon={<Check />} onClick={() => { onApply(); onClose(); }}>Apply change</Btn>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

export function ImprovementCard({ imp }: { imp: Improvement }) {
  const [applied, setApplied] = useState(false);
  const [review, setReview] = useState(false);
  const m = statusMeta[imp.status];
  return (
    <>
      <div style={{ border: "1px solid var(--hairline)", borderRadius: 10, background: "var(--panel-2)", padding: 11, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: m.color, flexShrink: 0 }} />
          <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{imp.step}</span>
          <div style={{ flex: 1 }} />
          <Pill tone="run" size="xs">+{imp.lift}</Pill>
        </div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", lineHeight: 1.35 }}>{imp.title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ flex: 1, height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 999, overflow: "hidden" }}>
            <div style={{ width: `${imp.confidence}%`, height: "100%", background: "var(--accent)" }} />
          </div>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-3)" }}>{imp.confidence}% conf</span>
        </div>
        {applied ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--run)", fontWeight: 600 }}>
            <Check size={13} color="var(--run)" /> Applied
          </span>
        ) : (
          <div style={{ display: "flex", gap: 6 }}>
            <Btn kind="quiet" size="xs" onClick={() => setReview(true)}>Review</Btn>
          </div>
        )}
      </div>
      {review && <ProposalModal imp={imp} applied={applied} onApply={() => setApplied(true)} onClose={() => setReview(false)} />}
    </>
  );
}

const logMeta: Record<LearningLogEntry["type"], { tone: "run" | "info" | "accent" | "neutral"; label: string; icon: ComponentType<{ size?: number; color?: string }>; color: string }> = {
  applied: { tone: "run", label: "Applied", icon: Check, color: "var(--run)" },
  observed: { tone: "info", label: "Observed", icon: Spark, color: "var(--info)" },
  proposed: { tone: "accent", label: "Proposal", icon: Sparkle, color: "var(--accent)" },
  reverted: { tone: "neutral", label: "Reverted", icon: ChevronLeft, color: "var(--text-3)" },
};

export function LearningLogRow({ entry }: { entry: LearningLogEntry }) {
  const m = logMeta[entry.type];
  const I = m.icon;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "18px 1fr", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--hairline)" }}>
      <div style={{ paddingTop: 1 }}><I size={13} color={m.color} /></div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
          <Pill tone={m.tone} size="xs">{m.label}</Pill>
          <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{entry.t}</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>{entry.text}</div>
      </div>
    </div>
  );
}

export function AutoApplyToggle() {
  const [on, setOn] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setOn((o) => !o)}
      aria-pressed={on}
      style={{ width: 32, height: 18, borderRadius: 999, border: "none", cursor: "pointer", flexShrink: 0, background: on ? "var(--accent)" : "rgba(255,255,255,0.12)", position: "relative", transition: "background 160ms ease", padding: 0 }}
    >
      <span style={{ position: "absolute", top: 2, left: on ? 16 : 2, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left 160ms ease" }} />
    </button>
  );
}

export function SelfImprovementRail({ wf }: { wf: WorkflowMetrics }) {
  const improvements: Improvement[] = wf.steps
    .filter((s) => s.proposal)
    .map((s) => ({ step: s.name, status: s.status, ...(s.proposal as Proposal) }));
  const attention = wf.steps.filter((s) => s.status !== "healthy").length;
  const proposals = improvements.length;
  const log = getLearningLog();

  return (
    <Panel
      title="Self-improvement"
      kicker="ORCA LEARNS"
      style={{ flex: 1, minHeight: 0 }}
      bodyStyle={{ padding: 12, display: "flex", flexDirection: "column", minHeight: 0 }}
    >
      <div className="scroll" style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.55, marginBottom: 12 }}>
          {proposals > 0 ? (
            <>Orca flagged <strong style={{ color: "var(--text)" }}>{attention} underperforming step{attention !== 1 ? "s" : ""}</strong> in {wf.name} and drafted {proposals} instruction change{proposals !== 1 ? "s" : ""}. Approve to let it improve itself.</>
          ) : (
            <>Every step in {wf.name} is healthy. Orca has no changes to propose right now.</>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {improvements.map((imp, i) => <ImprovementCard key={i} imp={imp} />)}
          {improvements.length === 0 && (
            <div style={{ textAlign: "center", padding: "18px 0", color: "var(--text-3)", fontSize: 12 }}>
              <Check size={20} color="var(--run)" style={{ marginBottom: 6 }} />
              <div>No pending improvements.</div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 16 }}>
          <div className="mono" style={{ fontSize: 10.5, letterSpacing: 1.4, textTransform: "uppercase", color: "var(--text-3)", fontWeight: 600, padding: "4px 0" }}>Activity</div>
          {log.map((entry, i) => <LearningLogRow key={i} entry={entry} />)}
        </div>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--hairline)", cursor: "pointer", flexShrink: 0 }}>
        <AutoApplyToggle />
        <span style={{ fontSize: 11.5, color: "var(--text-2)" }}>Auto-apply improvements above 90% confidence</span>
      </label>
    </Panel>
  );
}

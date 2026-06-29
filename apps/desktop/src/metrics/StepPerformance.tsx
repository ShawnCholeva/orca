import { useEffect, useRef, useState } from "react";
import { Pill } from "../workspaces/primitives";
import { statusMeta, type StepMetrics, type WorkflowMetrics } from "./metrics-data";
import { Delta, OutcomeBar, Panel, SectionLabel, Sparkline } from "./metrics-charts";
import { ChevronDown, ChevronRight, Check, Sparkle, Workflow } from "./metrics-icons";

const GRID = "34px minmax(0,1fr) 88px 64px 56px 22px";

export function WorkflowDropdown({ workflows, value, onChange }: { workflows: WorkflowMetrics[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = workflows.find((w) => w.id === value) ?? workflows[0];
  const curAtt = cur.steps.filter((s) => s.status !== "healthy").length;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); window.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          background: open ? "var(--accent-soft)" : "rgba(255,255,255,0.03)",
          border: `1px solid ${open ? "var(--accent-line)" : "var(--hairline)"}`,
          color: "var(--text)", borderRadius: 8, padding: "5px 9px 5px 11px",
          cursor: "pointer", fontFamily: "inherit", fontSize: 12.5, fontWeight: 500, minWidth: 200,
        }}
      >
        <span style={{ flex: 1, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cur.name}</span>
        <span className="mono" style={{ fontSize: 10, color: "var(--text-4)" }}>{cur.steps.length} steps</span>
        {curAtt > 0 && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--warn)", flexShrink: 0 }} />}
        <ChevronDown size={13} color="var(--text-3)" style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 120ms ease" }} />
      </button>

      {open && (
        <div
          className="scroll"
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 30,
            minWidth: 260, maxHeight: 320, overflow: "auto",
            background: "var(--panel)", border: "1px solid var(--hairline-strong)",
            borderRadius: 10, boxShadow: "0 16px 48px rgba(0,0,0,0.5)", padding: 4,
            animation: "float-in 120ms ease",
          }}
        >
          {workflows.map((w) => {
            const active = w.id === value;
            const att = w.steps.filter((s) => s.status !== "healthy").length;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => { onChange(w.id); setOpen(false); }}
                style={{
                  display: "flex", alignItems: "center", gap: 9, width: "100%",
                  background: active ? "var(--accent-soft)" : "transparent",
                  border: "none", borderRadius: 7, padding: "8px 10px", cursor: "pointer",
                  fontFamily: "inherit", textAlign: "left",
                }}
              >
                <Workflow size={13} color={active ? "var(--accent)" : "var(--text-3)"} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 500, color: active ? "var(--accent)" : "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.name}</span>
                {att > 0 && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--warn)", flexShrink: 0 }} />}
                <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", flexShrink: 0 }}>{w.steps.length}</span>
                {active && <Check size={13} color="var(--accent)" style={{ flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function StepRow({ step, index, isLast, open, onToggle }: { step: StepMetrics; index: number; isLast: boolean; open: boolean; onToggle: () => void }) {
  const m = statusMeta[step.status];
  const failures = step.failures.filter((f) => f.count > 0);
  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid var(--hairline)" }}>
      <div
        onClick={onToggle}
        style={{ display: "grid", gridTemplateColumns: GRID, alignItems: "center", gap: 12, padding: "12px 14px", cursor: "pointer" }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
      >
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0, border: `1px solid ${m.color}`, background: `color-mix(in srgb, ${m.color} 12%, transparent)`, color: m.color, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "JetBrains Mono, monospace", fontSize: 11, fontWeight: 600 }}>
            {String(index + 1).padStart(2, "0")}
          </div>
        </div>

        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{step.name}</span>
            <Pill tone={m.tone} size="xs">{m.label}</Pill>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
            <div style={{ flex: 1, maxWidth: 220 }}><OutcomeBar passed={step.passed} recovered={step.recovered} failed={step.failed} /></div>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{step.runs} runs · {step.latency}</span>
          </div>
        </div>

        <Sparkline data={step.trend} color={m.color} w={84} h={26} />

        <div style={{ textAlign: "right" }}>
          <span style={{ fontSize: 20, fontWeight: 600, color: m.color, letterSpacing: -0.5 }}>{step.score}</span>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-4)" }}>/100</span>
        </div>

        <div style={{ textAlign: "right" }}><Delta value={step.delta} good="up" /></div>

        <ChevronRight size={13} color="var(--text-3)" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 140ms ease", justifySelf: "center" }} />
      </div>

      {open && (
        <div style={{ padding: "2px 16px 16px 60px", animation: "float-in 160ms ease" }}>
          <div style={{ background: "var(--panel-2)", border: "1px solid var(--hairline)", borderRadius: 10, padding: 12 }}>
            <SectionLabel style={{ paddingTop: 0 }}>Failure modes</SectionLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
              {failures.length === 0 && <div style={{ fontSize: 12, color: "var(--run)" }}>No failures recorded this period.</div>}
              {failures.map((f, i) => (
                <div key={i}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: "var(--text-2)" }}>
                    <span style={{ lineHeight: 1.4 }}>{f.label}</span>
                    <span className="mono" style={{ fontSize: 11, color: "var(--text-3)", flexShrink: 0 }}>{f.count}×</span>
                  </div>
                  <div style={{ height: 4, background: "rgba(255,255,255,0.05)", borderRadius: 999, marginTop: 5, overflow: "hidden" }}>
                    <div style={{ width: `${f.pct}%`, height: "100%", background: "var(--err)", opacity: 0.7 }} />
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--hairline)", display: "flex", gap: 8 }}>
              <Sparkle size={14} color="var(--accent-2)" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.55 }}>{step.insight}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function StepPerformancePanel({ wf, openStep, onToggleStep }: { wf: WorkflowMetrics; openStep: string | null; onToggleStep: (name: string) => void }) {
  const attention = wf.steps.filter((s) => s.status !== "healthy").length;
  const headers = ["", "Step", "Trend", "Score", "Δ 7d", ""];
  return (
    <Panel
      title="Step performance"
      kicker={wf.name.toUpperCase()}
      right={
        <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>
          {attention > 0 ? `${attention} need attention` : "all healthy"}
        </span>
      }
      style={{ flex: 1, minHeight: 0 }}
      bodyStyle={{ padding: 0, display: "flex", flexDirection: "column" }}
    >
      <div style={{ display: "grid", gridTemplateColumns: GRID, gap: 12, padding: "8px 14px", borderBottom: "1px solid var(--hairline)", flexShrink: 0 }}>
        {headers.map((h, i) => (
          <span key={i} className="mono" style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-4)", textAlign: i >= 3 && i <= 4 ? "right" : "left" }}>{h}</span>
        ))}
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        {wf.steps.map((s, i) => (
          <StepRow key={s.name} step={s} index={i} isLast={i === wf.steps.length - 1} open={openStep === s.name} onToggle={() => onToggleStep(s.name)} />
        ))}
      </div>
    </Panel>
  );
}

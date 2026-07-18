import type { GateMetrics, TemplateMetricsDetail } from "@orca/contracts";
import { Pill } from "../workspaces/primitives";
import { gradeFor } from "./metrics-data";
import { Panel, SectionLabel, Sparkline } from "./metrics-charts";
import { ChevronRight } from "./metrics-icons";

const GATE_GRID = "34px minmax(0,1fr) 96px 64px 22px";

function pct(x: number | null): string { return x == null ? "—" : `${Math.round(x * 100)}%`; }

export function GateRow({ gate, index, isLast, open, onToggle }: { gate: GateMetrics; index: number; isLast: boolean; open: boolean; onToggle: () => void }) {
  const color = gate.health == null ? "var(--accent)" : gate.health >= 80 ? "var(--run)" : gate.health >= 60 ? "var(--warn)" : "var(--err)";
  return (
    <div style={{ borderBottom: isLast ? "none" : "1px solid var(--hairline)" }}>
      <div onClick={onToggle} style={{ display: "grid", gridTemplateColumns: GATE_GRID, alignItems: "center", gap: 12, padding: "12px 14px", cursor: "pointer" }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, border: `1px solid ${color}`, background: `color-mix(in srgb, ${color} 12%, transparent)`, color, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}>◈</div>
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{gate.name}</span>
            <Pill tone="accent" size="xs">{gate.evalSubstrate === "worker" ? "Agent-reviewed" : "Quick review"}</Pill>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 7 }}>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>
              {pct(gate.context.approvalRate)} approved · {gate.context.meanLoops == null ? "—" : `${gate.context.meanLoops.toFixed(1)} loops`}
              {gate.scored.overturnRate != null ? ` · ${pct(gate.scored.overturnRate)} sent back` : ""}
            </span>
          </div>
        </div>
        {gate.trend.length > 0 ? <Sparkline data={gate.trend} color={color} w={84} h={26} /> : <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", textAlign: "center" }}>—</span>}
        <div style={{ textAlign: "right" }}>
          {gate.health == null ? (
            <span className="mono" style={{ fontSize: 12, fontWeight: 600, color }} title="No independent check has confirmed this gate's calls yet — not a failing grade.">unproven</span>
          ) : (
            <>
              <span style={{ fontSize: 20, fontWeight: 600, color, letterSpacing: -0.5 }}>{gate.health}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--text-4)" }}>/100 {gradeFor(gate.health)}</span>
            </>
          )}
        </div>
        <ChevronRight size={13} color="var(--text-3)" style={{ transform: open ? "rotate(90deg)" : "none", justifySelf: "center" }} />
      </div>
      {open && (
        <div style={{ padding: "2px 16px 16px 60px" }}>
          <div style={{ background: "var(--panel-2)", border: "1px solid var(--hairline)", borderRadius: 10, padding: 12 }}>
            <SectionLabel style={{ paddingTop: 0 }}>What's going wrong</SectionLabel>
            {gate.failureModes.length === 0 && <div style={{ fontSize: 12, color: "var(--run)" }}>No problems detected this period.</div>}
            {gate.failureModes.map((f, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, color: "var(--text-2)", padding: "3px 0" }}>
                <span>{f.label}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>{f.count}× · {Math.round(f.pct * 100)}%</span>
              </div>
            ))}
            <SectionLabel>Grounded in checks</SectionLabel>
            <div style={{ fontSize: 12, color: "var(--text-2)" }}>{pct(gate.scored.groundedness)} average strength of the evidence behind gate calls.</div>
            <SectionLabel>Cost</SectionLabel>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--text-3)" }}>
              {gate.cost.p50LatencyMs == null ? "—" : `${Math.round(gate.cost.p50LatencyMs)}ms`} · {gate.cost.meanTokens == null ? "—" : `${Math.round(gate.cost.meanTokens)} tok`} · {gate.cost.meanUsd == null ? "—" : `$${gate.cost.meanUsd.toFixed(3)}`}
              {gate.cost.tokensSpentOnOverturned ? ` · ${gate.cost.tokensSpentOnOverturned} tok spent on calls later sent back` : ""}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function GatePerformancePanel({ detail, openGate, onToggleGate }: { detail: TemplateMetricsDetail | null; openGate: string | null; onToggleGate: (nodeId: string) => void }) {
  const gates = detail?.gates ?? [];
  if (gates.length === 0) return null;
  return (
    <Panel title="Gates" kicker="REVIEW POINTS" style={{ marginTop: 12 }} bodyStyle={{ padding: 0 }}>
      {gates.map((g, i) => (
        <GateRow key={g.nodeId} gate={g} index={i} isLast={i === gates.length - 1} open={openGate === g.nodeId} onToggle={() => onToggleGate(g.nodeId)} />
      ))}
    </Panel>
  );
}

export function PolicyGatewayReadout({ detail }: { detail: TemplateMetricsDetail | null }) {
  const pg = detail?.policyGateway;
  if (!pg) return null;
  const total = (pg.decisionDist.allow ?? 0) + (pg.decisionDist.require_approval ?? 0) + (pg.decisionDist.deny ?? 0);
  if (total === 0) return null;
  return (
    <Panel title="Tool safety gateway" kicker="PERMISSIONS" style={{ marginTop: 12 }}>
      <div className="mono" style={{ fontSize: 11.5, color: "var(--text-2)" }}>
        {pg.decisionDist.allow ?? 0} allowed · {pg.decisionDist.require_approval ?? 0} asked first · {pg.decisionDist.deny ?? 0} blocked
      </div>
      {pg.overPermissive.count > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: "var(--warn)" }}>⚠ {pg.overPermissive.count} risky action(s) allowed without asking</div>
      )}
    </Panel>
  );
}

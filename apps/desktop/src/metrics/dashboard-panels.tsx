import type { CSSProperties, ReactNode } from "react";

// Panel primitives for the Workflows dashboard.
//
// Every one of these renders a COUNT or a SUM. None takes an estimate, a threshold or
// a trend, because none of those is available honestly at this n — so there is no
// gauge with a coloured arc (an arc asserts a threshold nobody has defined, which is
// the letter-grade problem in a new costume) and no line over a time axis we do not
// sample.
//
// Density therefore comes from showing MORE FACTS rather than more precision. The
// screen was called bare twice; the answer is not to hedge harder, it is to render
// the nine-tenths of what we hold that never reached a surface.

export function Panel({
  title, span = 3, children, right,
}: { title: string; span?: number; children: ReactNode; right?: ReactNode }) {
  return (
    <section
      style={{
        gridColumn: `span ${span}`, minWidth: 0,
        background: "var(--panel)", border: "1px solid var(--hairline)",
        borderRadius: 10, padding: "var(--sp-3) var(--sp-4)",
        display: "grid", gap: "var(--sp-3)", alignContent: "start",
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-2)" }}>
        <span className="mono" style={{ fontSize: "var(--fs-1)", letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-3)" }}>
          {title}
        </span>
        <span style={{ flex: 1 }} />
        {right}
      </header>
      {children}
    </section>
  );
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2
      className="mono"
      style={{
        gridColumn: "span 12", margin: 0, fontSize: "var(--fs-1)", fontWeight: 600,
        letterSpacing: 1.2, textTransform: "uppercase", color: "var(--text-3)",
        paddingTop: "var(--sp-2)",
      }}
    >
      {children}
    </h2>
  );
}

/**
 * The figure that leads a panel.
 *
 * `size` exists so the grid has weight classes. `100h 31m` beside `1h 41m` works
 * because the magnitude contrast lands before any label is read, and the risk of a
 * dense grid is that everything becomes one tile among many — so the headline figures
 * keep a size no other panel uses.
 */
export function Big({
  value, label, tone, size = "var(--fs-6)",
}: { value: string; label?: string; tone?: string; size?: string }) {
  return (
    <div style={{ display: "grid", gap: "var(--sp-1)", minWidth: 0 }}>
      <span className="mono" style={{ fontSize: size, fontWeight: 600, letterSpacing: -0.8, lineHeight: 1, color: tone ?? "var(--text)" }}>
        {value}
      </span>
      {label && (
        <span style={{ fontSize: "var(--fs-2)", color: "var(--text-3)" }}>{label}</span>
      )}
    </div>
  );
}

export interface BarItem { key?: string; label: string; value: number; display: string; tone?: string }

/**
 * Sums, side by side, drawn to scale.
 *
 * Each bar is an exact quantity and the comparison between two exact quantities is
 * itself exact — so this needs no gate. Bars are scaled to the largest member rather
 * than to a total, because the question is "which of these is big" and the widths are
 * a reading aid for numbers that are all printed anyway.
 */
export function BarList({ items, tone = "var(--accent-2)" }: { items: BarItem[]; tone?: string }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  if (items.length === 0) {
    return <span style={{ fontSize: "var(--fs-2)", color: "var(--text-3)" }}>Nothing recorded.</span>;
  }
  return (
    <div style={{ display: "grid", gap: "var(--sp-2)" }}>
      {items.map((it) => (
        <div key={it.key ?? it.label} style={{ display: "grid", gap: 3 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-2)" }}>
            <span style={{ fontSize: "var(--fs-2)", color: "var(--text-2)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {it.label}
            </span>
            <span style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--text)", whiteSpace: "nowrap" }}>{it.display}</span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: "var(--hairline)", overflow: "hidden" }}>
            <div style={{ width: `${(it.value / max) * 100}%`, height: "100%", background: it.tone ?? tone }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface SplitPart { label: string; value: number; display: string; tone: string }

/**
 * A composition of parts that must add up to a stated whole.
 *
 * The same property as the ledger's four duration terms: the reader can add the
 * legend in front of us. A composition whose parts don't sum is the thing worth
 * catching, so the remainder is rendered rather than absorbed.
 */
export function SplitBar({ parts, total, height = 10 }: { parts: SplitPart[]; total: number; height?: number }) {
  const sum = parts.reduce((a, p) => a + p.value, 0);
  const scale = total > 0 ? total : sum || 1;
  return (
    <div style={{ display: "grid", gap: "var(--sp-2)" }}>
      <div style={{ display: "flex", height, borderRadius: 2, overflow: "hidden", background: "var(--hairline)" }}>
        {parts.map((p) => (
          <span key={p.label} style={{ width: `${(p.value / scale) * 100}%`, background: p.tone }} />
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-3)" }}>
        {parts.map((p) => (
          <span key={p.label} className="mono" style={{ fontSize: "var(--fs-1)", color: "var(--text-2)", whiteSpace: "nowrap" }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 2, background: p.tone, marginRight: 5, verticalAlign: -1 }} />
            {p.display} {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A row of small counts — the cheapest honest density there is. */
export function CountRow({ items }: { items: { label: string; value: string; tone?: string }[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-5)" }}>
      {items.map((i) => (
        <div key={i.label} style={{ display: "grid", gap: 2 }}>
          <span className="mono" style={{ fontSize: "var(--fs-4)", fontWeight: 600, color: i.tone ?? "var(--text)" }}>{i.value}</span>
          <span style={{ fontSize: "var(--fs-1)", color: "var(--text-3)" }}>{i.label}</span>
        </div>
      ))}
    </div>
  );
}

export const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
  gap: "var(--sp-3)",
  alignContent: "start",
};

export interface MatrixCell { key: string; tone: string; title: string; label?: string }

/**
 * Runs × steps, one cell each.
 *
 * orca-d0's call and it is the densest honest panel available: 7 runs × 8 steps is
 * 56 cells, every one an observed outcome, with no estimate anywhere. It also makes
 * "every run stopped at Triage" visible as a SHAPE rather than as the same sentence
 * repeated down a list — which is the difference between a reader noticing a pattern
 * and a reader being told one.
 */
export function Matrix({
  columns, rows,
}: {
  columns: string[];
  rows: { key: string; label: string; sub?: string; cells: (MatrixCell | null)[] }[];
}) {
  return (
    <div style={{ display: "grid", gap: "var(--sp-1)", overflowX: "auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: `170px repeat(${columns.length}, minmax(52px, 1fr))`, gap: 3 }}>
        <span />
        {columns.map((c) => (
          <span key={c} className="mono" style={{ fontSize: "var(--fs-1)", color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {c}
          </span>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.key} style={{ display: "grid", gridTemplateColumns: `170px repeat(${columns.length}, minmax(52px, 1fr))`, gap: 3, alignItems: "center" }}>
          <span style={{ fontSize: "var(--fs-1)", color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.label}
            {r.sub && <span className="mono" style={{ color: "var(--text-3)" }}> {r.sub}</span>}
          </span>
          {r.cells.map((c, i) => (
            <span
              key={i}
              title={c?.title ?? "this step did not run"}
              style={{
                height: 22, borderRadius: 3, background: c?.tone ?? "transparent",
                border: c ? "none" : "1px dashed var(--hairline-strong)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              {c?.label && (
                <span className="mono" style={{ fontSize: 9.5, color: "var(--bg)", fontWeight: 600 }}>{c.label}</span>
              )}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A running total across an ordered sequence, drawn as a line.
 *
 * Legitimate at n=7 where a trend line is not, and orca-d0's reasoning is what makes
 * it so: each point of a cumulative series is itself a SUM, so joining them asserts
 * nothing beyond what "cumulative" already means. A line through 7 independent
 * observations would be a trend claim; a line through 7 running totals is arithmetic.
 */
export function CumulativeLine({ values, w = 240, h = 56, tone = "var(--accent-2)" }: { values: number[]; w?: number; h?: number; tone?: string }) {
  if (values.length < 2) return null;
  const max = values[values.length - 1] || 1;
  const x = (i: number) => (i / (values.length - 1)) * (w - 4) + 2;
  const y = (v: number) => h - 2 - (v / max) * (h - 6);

  // A STEP function, not a smooth line. The steps are the runs and the flats are the
  // stretches when nothing ran — both true. Smoothing would draw spend accruing
  // between runs, which is money nobody spent: the curve would be inventing data in
  // the gaps rather than describing them.
  let d = `M${x(0).toFixed(1)},${y(values[0]!).toFixed(1)}`;
  for (let i = 1; i < values.length; i++) {
    d += ` L${x(i).toFixed(1)},${y(values[i - 1]!).toFixed(1)} L${x(i).toFixed(1)},${y(values[i]!).toFixed(1)}`;
  }
  return (
    <svg width={w} height={h} style={{ display: "block", maxWidth: "100%" }}>
      <path d={d} fill="none" stroke={tone} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      {values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="2" fill={tone} />)}
    </svg>
  );
}

export interface ScatterPoint { at: number; value: number; title: string; open?: boolean }

/**
 * One dot per run: when it started against how long it took.
 *
 * Unconnected, deliberately — the n>=12 line gate stands, and seven points joined
 * would be the trend claim we refuse everywhere else. Both axes are observed:
 * `startedAt` is a timestamp and the duration is a measured span, so nothing here is
 * derived.
 *
 * Date-spaced rather than index-spaced, because the clustering is real information —
 * three runs in one evening and then a five-day gap is a fact about how the product
 * gets used, and index spacing would erase it.
 *
 * A run still in flight is marked hollow: its duration is not final and would grow on
 * every render, so a solid dot would assert a settled value that keeps moving.
 */
export function Scatter({ points, w = 240, h = 90, tone = "var(--accent-2)" }: { points: ScatterPoint[]; w?: number; h?: number; tone?: string }) {
  if (points.length === 0) return null;
  const ats = points.map((p) => p.at);
  const t0 = Math.min(...ats);
  const t1 = Math.max(...ats);
  const maxV = Math.max(...points.map((p) => p.value), 1);
  const x = (at: number) => (t1 === t0 ? w / 2 : ((at - t0) / (t1 - t0)) * (w - 12) + 6);
  const y = (v: number) => h - 8 - (v / maxV) * (h - 16);
  return (
    <svg width={w} height={h} style={{ display: "block", maxWidth: "100%" }}>
      <line x1="0" y1={h - 4} x2={w} y2={h - 4} stroke="var(--hairline)" strokeWidth="1" />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={x(p.at)} cy={y(p.value)} r="3.5"
          fill={p.open ? "transparent" : tone}
          stroke={tone} strokeWidth="1.5"
        >
          <title>{p.title}</title>
        </circle>
      ))}
    </svg>
  );
}

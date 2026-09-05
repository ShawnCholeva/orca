import { scaleTime } from "d3-scale";
import { arc, pie } from "d3-shape";
import { timeFormat } from "d3-time-format";
import { Fragment } from "react";
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
  title, span = 3, children, right, center = false,
}: { title: string; span?: number; children: ReactNode; right?: ReactNode; center?: boolean }) {
  return (
    <section
      style={{
        gridColumn: `span ${span}`, minWidth: 0,
        background: "var(--panel)", border: "1px solid var(--hairline)",
        borderRadius: 10, padding: "var(--sp-3) var(--sp-4)",
        display: "grid", gridTemplateRows: "auto 1fr", gap: "var(--sp-3)", alignContent: "stretch",
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-2)" }}>
        <span className="mono" style={{ fontSize: "var(--fs-1)", letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-3)" }}>
          {title}
        </span>
        <span style={{ flex: 1 }} />
        {right}
      </header>
      {/* Panels in a row are equal height, so a panel holding one figure stacks it at
          the top and leaves every pixel of the difference in a block underneath —
          which is what reads as "a lot of space". `center` takes up that slack.
          It is opt-in rather than the default because centring a LIST breaks the
          thing lists most need: two of them side by side stop sharing a first-row
          baseline, and the shorter one drifts down by half the height difference. */}
      <div style={{ display: "grid", alignContent: center ? "center" : "start", gap: "var(--sp-3)", minHeight: 0 }}>
        {children}
      </div>
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
export function BarList({
  items, tone = "var(--accent-2)", scaleTo,
}: { items: BarItem[]; tone?: string; scaleTo?: number }) {
  // Default: scale to the largest member, because the question is "which of these is
  // big". `scaleTo` is for the other case — items that are PARTS OF A WHOLE, where
  // scaling to the largest would draw the biggest part full-width and assert it was
  // everything. A 72% share rendering as a full bar next to the text "72%" is the
  // chart contradicting its own label.
  const max = scaleTo && scaleTo > 0 ? scaleTo : Math.max(...items.map((i) => i.value), 1);
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
 * A part-to-whole ring. Same contract as SplitBar and the same reason for it: the
 * parts must BE the whole, so the reader can add the legend in front of us.
 *
 * A pie makes a stronger claim than a bar — it asserts the slices are mutually
 * exclusive AND exhaustive, because the ring closes. Feeding it overlapping counts
 * draws a circle whose total corresponds to nothing, so `caption` names the
 * population out loud and the centre shows the sum the slices actually make.
 *
 * d3-shape rather than hand-rolled arcs for one specific case: a single part at 100%.
 * Naive start/end trig puts both arc endpoints on the same coordinate and SVG draws
 * nothing — and "every run completed" is the HEALTHY case, so the degenerate render
 * would land exactly when the news is good.
 */
export function Donut({
  parts, caption, size = 128, total,
}: { parts: SplitPart[]; caption: string; size?: number; total?: string }) {
  const shown = parts.filter((p) => p.value > 0);
  const sum = shown.reduce((a, p) => a + p.value, 0);
  // Counts print themselves; anything else must not. This was written for runs and
  // steps, and the first non-integer caller put "75.279189" in the middle of the ring
  // — the sum was right, the presentation of it was raw. `total` is how a caller that
  // already knows the unit says so.
  const middle = total ?? String(sum);
  const r = size / 2;
  const layout = pie<SplitPart>().value((d) => d.value).sortValues(null).padAngle(shown.length > 1 ? 0.02 : 0);
  const shape = arc<{ startAngle: number; endAngle: number }>().innerRadius(r * 0.62).outerRadius(r).cornerRadius(1);

  return (
    /* The legend FLEXES to the panel edge and its rows share one column grid. Left
       to `flex-start` the ring hugged the left border and the legend stopped dead in
       the middle of a 440px panel, so a third of every panel was empty and the two
       elements read as unrelated. Columns are what make a legend look measured
       rather than placed: swatch, label, then figures on a right-aligned rail so the
       counts and shares stack into readable columns instead of ragging. */
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-4)" }}>
      {/* The ring centres in whatever the legend leaves, rather than pinning to the
          panel's left border. `space-between` alone pushed it flush against the wall,
          which read as a chart shoved aside to make room rather than as the panel's
          subject. */}
      <div style={{ flex: 1, display: "flex", justifyContent: "center", minWidth: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }} role="img"
           aria-label={`${caption}: ${shown.map((p) => `${p.display} ${p.label}`).join(", ") || "none"}`}>
        <g transform={`translate(${r},${r})`}>
          {/* The track is drawn ONLY when there is nothing else to draw, where it makes
              an empty window read as a measured zero rather than as a panel that
              failed. Underneath real slices it did the opposite: "stopped by Orca" is
              neutral grey by design, and a neutral slice on a grey track made the
              largest category on the panel — 5 of 7 runs — read as unfilled ring.
              The tone is right and survives; the surface beneath it was the problem,
              which is a hazard a bar chart does not have and a ring does. */}
          {sum === 0 && <circle r={r * 0.81} fill="none" stroke="var(--hairline)" strokeWidth={r * 0.38} />}
          {layout(shown).map((a, i) => (
            <path key={shown[i]!.label} d={shape(a) ?? undefined} fill={shown[i]!.tone}>
              <title>{`${shown[i]!.display} ${shown[i]!.label} of ${middle} ${caption}`}</title>
            </path>
          ))}
          <text textAnchor="middle" dy="-0.05em" className="mono"
                style={{ fontSize: "var(--fs-5)", fontWeight: 600, fill: "var(--text)" }}>{middle}</text>
          <text textAnchor="middle" dy="1.35em" style={{ fontSize: "var(--fs-1)", fill: "var(--text-3)" }}>{caption}</text>
        </g>
      </svg>
      </div>
      {/* Content-width columns, not a stretched label column. With the label on
          `1fr` the legend spanned the gap and the words ended up marooned in the
          middle with their own figures a panel-width away — the reader had to track
          across empty space to pair "stopped by Orca" with 5. Sized to content and
          pushed right by the flex, each label sits against its own numbers, and the
          columns still line up across rows because that is what a grid does. */}
      <div style={{
        display: "grid", gridTemplateColumns: "auto auto auto auto",
        columnGap: "var(--sp-3)", rowGap: "var(--sp-3)", alignItems: "center",
      }}>
        {shown.map((p) => (
          <Fragment key={p.label}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: p.tone }} />
            <span style={{ fontSize: "var(--fs-2)", color: "var(--text-2)" }}>{p.label}</span>
            <span className="mono" style={{ fontSize: "var(--fs-2)", fontWeight: 600, color: "var(--text)", textAlign: "right" }}>
              {p.display}
            </span>
            {/* A share, only where it is a ratio of a closed set — which is what this
                component refuses to be built out of anything else. */}
            <span className="mono" style={{ fontSize: "var(--fs-1)", color: "var(--text-3)", textAlign: "right", minWidth: "3ch" }}>
              {Math.round((p.value / sum) * 100)}%
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export interface StackedRow { key: string; label: string; display: string; parts: SplitPart[] }

/**
 * One composition per row, each drawn to its OWN whole.
 *
 * The rows answer "inside this step, where did the time go", so every bar is
 * full-width and the segments are shares of that step. Scaling the rows against each
 * other instead would answer a different question — one `TIME BY STEP` already
 * answers, two panels along.
 *
 * The legend is stated once, beneath, rather than repeated per row: four tones read
 * eight times is noise, and the tones are the same four the wall-clock panel uses.
 */
export function StackedRows({ rows, legend }: { rows: StackedRow[]; legend: SplitPart[] }) {
  if (rows.length === 0) {
    return <span style={{ fontSize: "var(--fs-2)", color: "var(--text-3)" }}>Nothing recorded.</span>;
  }
  return (
    <div style={{ display: "grid", gap: "var(--sp-2)" }}>
      {rows.map((r) => {
        const total = r.parts.reduce((a, p) => a + p.value, 0) || 1;
        return (
          <div key={r.key} style={{ display: "grid", gap: 3 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-2)" }}>
              <span style={{ fontSize: "var(--fs-2)", color: "var(--text-2)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.label}
              </span>
              <span style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: "var(--fs-2)", color: "var(--text)", whiteSpace: "nowrap" }}>{r.display}</span>
            </div>
            <div style={{ display: "flex", height: 6, borderRadius: 2, overflow: "hidden", background: "var(--hairline)" }}>
              {r.parts.filter((p) => p.value > 0).map((p) => (
                <span
                  key={p.label}
                  title={`${r.label} · ${p.display} ${p.label}`}
                  style={{ width: `${(p.value / total) * 100}%`, background: p.tone }}
                />
              ))}
            </div>
          </div>
        );
      })}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sp-3)", paddingTop: "var(--sp-1)" }}>
        {legend.map((p) => (
          <span key={p.label} style={{ fontSize: "var(--fs-1)", color: "var(--text-3)", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: p.tone }} />
            {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface CoverageCell { fired: number; of: number }
export interface CoverageRow { key: string; label: string; cells: CoverageCell[]; note?: string }

/**
 * Which checks fired, per step template, as fractions rather than a verdict.
 *
 * The fraction is the point. `0/7` and `7/7` are all-or-nothing and therefore describe
 * WIRING — a property of the template, true regardless of how many runs there are.
 * `6/7` describes CONDUCT, a sample of behaviour whose denominator has to be visible
 * to be read at all. Printing both lets the reader tell configuration from behaviour
 * without either being labelled, which no single collapsed number can do.
 *
 * Deliberately not a score, a grade or a tier. `tier` already exists in the contract
 * and collapses these facets into one ordinal word — and it puts "sensors ran but did
 * not cover it" and "nothing executed, grounding passed" both under
 * `partially_verified`, which a reader takes as "about half verified".
 */
export interface CoverageColumn { label: string; hint: string }

export function CoverageMatrix({
  columns, rows, tone = "var(--ok)",
}: { columns: CoverageColumn[]; rows: CoverageRow[]; tone?: string }) {
  if (rows.length === 0) {
    return <span style={{ fontSize: "var(--fs-2)", color: "var(--text-3)" }}>Nothing recorded.</span>;
  }
  const grid: CSSProperties = {
    display: "grid",
    gridTemplateColumns: `minmax(0, 18rem) repeat(${columns.length}, minmax(84px, auto))`,
    columnGap: "var(--sp-4)", rowGap: "var(--sp-2)", alignItems: "center",
    // Capped, not stretched. On a full-width panel a `1fr` label column drove the
    // figures to the far edge and left the step name marooned from its own numbers —
    // the same gap that made the donut legends unreadable, in a grid this time.
    maxWidth: "44rem",
  };
  return (
    <div style={grid}>
      <span />
      {/* The header carries the definition, because the column names were the
          contract's field names in a thin disguise — `executed`, `grounded`,
          `model-reviewed` describe how the daemon classifies a check, not what the
          reader learns from it. The visible label answers "what does this tell me",
          and the tooltip carries the precision the label had to drop. */}
      {columns.map((c) => (
        <span key={c.label} title={c.hint} className="mono"
              style={{ fontSize: "var(--fs-1)", color: "var(--text-3)", textTransform: "uppercase", letterSpacing: 0.6, textAlign: "right" }}>
          {c.label}
        </span>
      ))}
      {rows.map((r) => (
        <Fragment key={r.key}>
          <span style={{ fontSize: "var(--fs-2)", color: "var(--text-2)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {r.label}
            {r.note && <span style={{ color: "var(--text-3)", fontSize: "var(--fs-1)" }}> · {r.note}</span>}
          </span>
          {r.cells.map((c, i) => (
            <span key={columns[i]!.label} style={{ display: "grid", gap: 3, justifyItems: "end" }}
                  title={`${r.label} — ${columns[i]!.label}: ${c.fired} of ${c.of} completed attempts. ${columns[i]!.hint}`}>
              <span className="mono" style={{ fontSize: "var(--fs-2)", color: c.fired === 0 ? "var(--text-3)" : "var(--text)" }}>
                {c.fired}/{c.of}
              </span>
              {/* An empty track IS the finding, so the bar is always drawn: a missing
                  bar would read as "no data" where the truth is "never fired". */}
              <span style={{ width: 52, height: 3, borderRadius: 2, background: "var(--hairline)", overflow: "hidden" }}>
                <span style={{ display: "block", width: `${c.of > 0 ? (c.fired / c.of) * 100 : 0}%`, height: "100%", background: tone }} />
              </span>
            </span>
          ))}
        </Fragment>
      ))}
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

export interface ScatterRow { key: string; label: string }
export interface ScatterPoint { rowKey: string; atMs: number; title: string }

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Dots on a time axis, one row per kind. The question is WHEN, so time is the
 * only continuous axis and the row carries identity — a single hue, no legend,
 * because position already says which kind a dot is.
 *
 * The axis is the chosen window exactly, and the ticks fall on the chosen
 * interval: the two choosers above the dashboard are what this chart is drawn
 * with, not a decoration beside it. Labels are thinned so no more than eight
 * print, but every interval boundary keeps a minor tick — the reader can count.
 *
 * Coincident dots (same row, same pixel) fan out vertically instead of hiding
 * one another; every dot keeps a 2px ring in the panel colour so a stack reads
 * as a stack. Each dot carries its own hover text.
 */
export function Scatter({
  rows, points, fromMs, toMs, intervalMs, tone = "var(--err)", height,
}: { rows: ScatterRow[]; points: ScatterPoint[]; fromMs: number; toMs: number; intervalMs: number; tone?: string; height?: number }) {
  if (points.length === 0) {
    return <span style={{ fontSize: "var(--fs-2)", color: "var(--text-3)" }}>Nothing recorded in this window.</span>;
  }
  const width = 960;
  const left = 168, right = 16, top = 12, bottom = 28;
  const rowH = 34;
  const h = height ?? top + rows.length * rowH + bottom;
  const x = scaleTime().domain([new Date(fromMs), new Date(toMs)]).range([left, width - right]);
  const rowY = new Map(rows.map((r, i) => [r.key, top + rowH * i + rowH / 2]));

  // Ticks on the interval, snapped to the reader's clock rather than to the
  // window's start: a window opened at 17:22 seven days ago put every daily label
  // at "17:22", which named a time of day and said nothing about the day. Ticks
  // run from the local midnight on or before the window opens, at the interval,
  // and only those inside the window are drawn. Labels are thinned to at most
  // eight; minor ticks stay so the reader can count intervals.
  const origin = new Date(fromMs);
  origin.setHours(0, 0, 0, 0);
  const ticks: number[] = [];
  for (let t = origin.getTime(); t <= toMs + 1; t += intervalMs) if (t >= fromMs) ticks.push(t);
  const every = Math.max(1, Math.ceil(ticks.length / 8));
  // A label names the day when labelled ticks are a day or more apart; the clock
  // time joins it unless the step itself is a whole day, where every tick is midnight.
  const labelledStep = every * intervalMs;
  const fmt = labelledStep >= DAY_MS
    ? (intervalMs >= DAY_MS ? timeFormat("%b %d") : timeFormat("%b %d %H:%M"))
    : timeFormat("%H:%M");
  const dayFmt = timeFormat("%b %d");

  // Fan out dots that share a row and a pixel column.
  const byCell = new Map<string, number[]>();
  const placed = points.map((p, i) => {
    const px = Math.round(x(new Date(p.atMs)));
    const key = `${p.rowKey}@${px}`;
    const cell = byCell.get(key) ?? [];
    cell.push(i);
    byCell.set(key, cell);
    return { ...p, px, cell: key, slot: cell.length - 1 };
  });
  const dot = 4;

  return (
    <div style={{ overflowX: "auto" }}>
      <svg width="100%" viewBox={`0 0 ${width} ${h}`} role="img"
           aria-label={`${points.length} ${points.length === 1 ? "event" : "events"} across ${rows.length} kinds`}
           style={{ display: "block", minWidth: 640 }}>
        {rows.map((r) => (
          <g key={r.key}>
            <line x1={left} x2={width - right} y1={rowY.get(r.key)} y2={rowY.get(r.key)} stroke="var(--hairline)" />
            <text x={left - 10} y={rowY.get(r.key)} dy="0.35em" textAnchor="end"
                  style={{ fontSize: 11, fill: "var(--text-2)" }}>{r.label}</text>
          </g>
        ))}
        {ticks.map((t, i) => {
          const tx = x(new Date(t));
          const labelled = i % every === 0;
          return (
            <g key={t}>
              <line x1={tx} x2={tx} y1={labelled ? top - 4 : h - bottom} y2={h - bottom + (labelled ? 6 : 3)}
                    stroke={labelled ? "var(--hairline-strong)" : "var(--hairline)"} />
              {labelled && (
                <text x={tx} y={h - bottom + 18} textAnchor="middle" className="mono"
                      style={{ fontSize: 10, fill: "var(--text-3)" }}>{fmt(new Date(t))}</text>
              )}
            </g>
          );
        })}
        {placed.map((p) => {
          const n = byCell.get(p.cell)!.length;
          const cy = (rowY.get(p.rowKey) ?? 0) + (p.slot - (n - 1) / 2) * (dot * 2 + 2);
          return (
            <circle key={`${p.rowKey}-${p.atMs}-${p.slot}`} cx={p.px} cy={cy} r={dot}
                    fill={tone} stroke="var(--panel)" strokeWidth={2} data-dot="true">
              <title>{p.title}</title>
            </circle>
          );
        })}
      </svg>
      <span style={{ fontSize: "var(--fs-1)", color: "var(--text-3)" }} className="mono">
        {dayFmt(new Date(fromMs))} {timeFormat("%H:%M")(new Date(fromMs))} → {dayFmt(new Date(toMs))} {timeFormat("%H:%M")(new Date(toMs))}
      </span>
    </div>
  );
}

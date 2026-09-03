import type { CSSProperties } from "react";
import {
  collapsesToNumber,
  labelForMeasurementState,
  shortLabelForMeasurementState,
  proportionInterval,
  type MeasurementState,
} from "@orca/contracts";

// The two display primitives that encode the n-gate rules. Every honesty decision
// on the metrics screen routes through one of them, so neither takes an `n`
// threshold from its caller — the rules live in @orca/contracts and these render
// what the rules return.
//
// Neither component ever uses opacity. Dimming reduces legibility while preserving
// the claim, and it reads as "less important" when the message is "different kind
// of thing". State is carried by form.

// Which band a point falls in: 0 below the first edge, 1 between the first and
// second, and so on. Edges must be ascending.
function bandIndex(point: number, edges: readonly number[]): number {
  let i = 0;
  while (i < edges.length && point >= edges[i]!) i++;
  return i;
}

const BAND_TONES = ["var(--err)", "var(--warn)", "var(--run)"];

function toneFor(point: number, edges: readonly number[]): string {
  if (edges.length === 0) return "var(--text)";
  const i = bandIndex(point, edges);
  return BAND_TONES[Math.min(i, BAND_TONES.length - 1)]!;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function RateInterval({
  pos,
  neg,
  bandEdges = [],
  label,
  outcomeWords = { pass: "passed", fail: "failed" },
  emptyState = "unknown",
  emptyReason,
  style,
}: {
  pos: number;
  neg: number;
  /** Ascending band edges this rate is judged against. Omitted means no verdict is
   *  at stake, so the interval is always drawn — an unknown verdict is not a settled one. */
  bandEdges?: readonly number[];
  /** What the count is a count OF, e.g. "passed". Used in the accessible text. */
  label?: string;
  outcomeWords?: { pass: string; fail: string };
  /** Why there are no observations. Defaults to the weakest claim available. */
  emptyState?: MeasurementState;
  emptyReason?: string;
  style?: CSSProperties;
}) {
  const interval = proportionInterval(pos, neg);
  // No observations is not zero percent — and it is not nothing, either. Returning
  // null here made the convention "the caller renders a MeasurementLabel" something
  // the type system never enforced, so a caller that forgot rendered an untyped
  // absence with no dash to notice it by: the one failure that never shows up in a
  // screenshot. The default states the weakest true thing (we have not established
  // why this is absent); a caller that knows better passes the state it knows.
  if (interval === null) {
    return <MeasurementLabel state={emptyState} reason={emptyReason} style={style} />;
  }

  const n = interval.n;
  const { point, lower, upper } = interval;

  // A rate over one observation is the observation wearing a percent sign.
  if (n === 1) {
    return (
      <span style={{ fontSize: 12.5, color: toneFor(point, bandEdges), ...style }}>
        {pos === 1 ? outcomeWords.pass : outcomeWords.fail}
      </span>
    );
  }

  const primary = n < 5 ? `${pos} of ${n}` : pct(point);
  const readout = `${pos} of ${n}${label ? ` ${label}` : ""}; between ${pct(lower)} and ${pct(upper)}`;

  // Decision-relevance, never width: the bar goes away only when the uncertainty
  // can no longer change which band the value sits in. With no bands supplied
  // there is no verdict to settle, so it stays.
  const collapsed = bandEdges.length > 0 && collapsesToNumber(interval, bandEdges);

  if (collapsed) {
    return (
      <span
        role="img"
        aria-label={readout}
        style={{ fontSize: 12.5, fontWeight: 600, color: toneFor(point, bandEdges), ...style }}
      >
        {primary}
      </span>
    );
  }

  return (
    <span
      role="img"
      aria-label={readout}
      style={{ display: "inline-flex", alignItems: "center", gap: 8, ...style }}
    >
      <span
        className="mono"
        style={{ fontSize: 12, fontWeight: 600, color: toneFor(point, bandEdges), whiteSpace: "nowrap" }}
      >
        {primary}
      </span>
      <span
        data-testid="interval-track"
        style={{
          position: "relative",
          flex: 1,
          minWidth: 56,
          height: 14,
          background: "var(--hairline)",
          borderRadius: 2,
        }}
      >
        {/* The span stays neutral so a bar straddling a band edge reads as
            straddling, rather than asserting the verdict its midpoint happens to fall in. */}
        <span
          data-testid="interval-span"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: `${lower * 100}%`,
            width: `${Math.max(upper - lower, 0) * 100}%`,
            background: "var(--text-4)",
            borderRadius: 2,
          }}
        />
        {bandEdges.map((edge) => (
          <span
            key={edge}
            style={{
              position: "absolute",
              top: -2,
              bottom: -2,
              left: `${edge * 100}%`,
              width: 1,
              background: "var(--hairline-strong)",
            }}
          />
        ))}
        {/* The observed rate, never a shrunken estimate: betaMean carries a designed
            prior that is right for scoring and unreconcilable with the reader's own count. */}
        <span
          data-testid="interval-point"
          style={{
            position: "absolute",
            top: -3,
            bottom: -3,
            left: `${point * 100}%`,
            width: 2,
            background: toneFor(point, bandEdges),
          }}
        />
      </span>
    </span>
  );
}

// Form per state — solid / dashed / dotted and a distinct hue, so the six states
// are told apart without reaching for opacity. `lossy` is the urgent uninstrumented
// case: the value is measured and then discarded, so data is being destroyed on
// every run until it is fixed.
function formFor(state: MeasurementState, lossy: boolean): { borderLeftStyle: string; borderLeftColor: string } {
  switch (state) {
    case "insufficient":
      return { borderLeftStyle: "dashed", borderLeftColor: "var(--accent)" };
    case "unmeasurable_coverage":
      return { borderLeftStyle: "dotted", borderLeftColor: "var(--warn)" };
    case "unmeasurable_structural":
      return { borderLeftStyle: "dotted", borderLeftColor: "var(--text-4)" };
    case "uninstrumented":
      return lossy
        ? { borderLeftStyle: "solid", borderLeftColor: "var(--err)" }
        : { borderLeftStyle: "solid", borderLeftColor: "var(--hairline-strong)" };
    case "unknown":
      // Absent with no established cause. Deliberately not borrowed from any of the
      // states above: each of those names a reason, and this one is the admission
      // that we don't have one yet. Provisional treatment — the visual language here
      // is the frontend owner's call, not this function's.
      return { borderLeftStyle: "dashed", borderLeftColor: "var(--text-4)" };
    case "measured":
      return { borderLeftStyle: "none", borderLeftColor: "transparent" };
  }
}

export function MeasurementLabel({
  state,
  needed,
  have,
  need,
  unit,
  checked,
  of,
  reason,
  lossy = false,
  fix,
  compact = false,
  style,
}: {
  state: MeasurementState;
  needed?: number;
  have?: number;
  need?: number;
  unit?: string;
  checked?: number;
  of?: number;
  /** What specifically cannot be formed or checked. Required in practice for
   *  unmeasurable_structural, which covers several situations sharing a remedy. */
  reason?: string;
  lossy?: boolean;
  /** The one change that would make this answerable. An absence the reader can act
   *  on beats an absence they can only notice. */
  fix?: string;
  /** Tag-length rendering for a state that repeats down a column. The full sentence
   *  still reaches a screen reader, and the caller is expected to state it once per
   *  screen — a tag alone is a caveat nobody can resolve. */
  compact?: boolean;
  style?: CSSProperties;
}) {
  const text = labelForMeasurementState(state, { needed, have, need, unit, checked, of, reason, lossy });
  if (text === null) return null;

  const form = formFor(state, lossy);

  if (compact) {
    return (
      <span
        role="note"
        aria-label={fix ? `${text} ${fix}` : text}
        data-compact="true"
        className="mono"
        style={{
          display: "inline-block",
          fontSize: 10,
          lineHeight: 1.5,
          padding: "0 4px",
          borderRadius: 2,
          borderWidth: 1,
          borderStyle: form.borderLeftStyle as CSSProperties["borderStyle"],
          borderColor: form.borderLeftColor,
          color: "var(--text-3)",
          whiteSpace: "nowrap",
          ...style,
        }}
      >
        {shortLabelForMeasurementState(state, { lossy })}
      </span>
    );
  }

  return (
    <div
      style={{
        borderLeftWidth: 3,
        borderLeftStyle: form.borderLeftStyle as CSSProperties["borderLeftStyle"],
        borderLeftColor: form.borderLeftColor,
        paddingLeft: 9,
        fontSize: 12,
        lineHeight: 1.45,
        color: "var(--text-2)",
        ...style,
      }}
    >
      <div>{text}</div>
      {fix && (
        <div className="mono" style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 2 }}>{fix}</div>
      )}
    </div>
  );
}

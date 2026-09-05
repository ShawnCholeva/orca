import type { CSSProperties } from "react";

// The span-interior bar: how a run's elapsed time decomposes into time we watched,
// time it spent waiting on a person, and time we cannot account for.
//
// Two refusals are built into this component on purpose.
//
// 1. It takes DURATIONS ONLY, never timestamps. `latency_ms` is a sum of model
//    turns with no start, so the fraction of a span is honest but the placement
//    inside it is not derivable. A positioned timeline would look authoritative
//    and be fabricated, so there is no prop that would let a caller ask for one.
//
// 2. It will not normalize a broken invariant. `working + parked + unaccounted`
//    must equal `elapsed`; when it doesn't, the bar says so rather than scaling
//    the parts to fit. Scaling to fit is precisely how a wrong-but-positive
//    unaccounted stays hidden — an integrity check catches a negative residual,
//    but only the reader catches a plausible one, and only if we show the terms.

const SECOND = 1000;

// Never render a nonzero quantity as zero: a floor label, not a rounded 0. A true
// zero is a measurement and keeps its "0s". Each tier promotes rather than letting
// rounding produce a full unit of the tier below it (59.7s is "1m 0s", not "60s").
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  if (ms === 0) return "0s";
  if (ms < SECOND) return "under 1s";

  const seconds = Math.round(ms / SECOND);
  if (seconds < 60) return `${seconds}s`;

  const totalMinutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (totalMinutes < 10) return `${totalMinutes}m ${remSeconds}s`;
  if (totalMinutes < 60) return `${totalMinutes}m`;

  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
}

type Ms = number | null | undefined;

export function IntervalBar({
  elapsedMs,
  workingMs,
  parkedMs,
  unaccountedMs,
  style,
}: {
  elapsedMs: Ms;
  workingMs: Ms;
  parkedMs: Ms;
  unaccountedMs: Ms;
  style?: CSSProperties;
}) {
  const parts = [workingMs, parkedMs, unaccountedMs];
  const anyPart = parts.some((p) => p != null);

  // A gate emits no harness transitions at all, so its interior was never measured.
  // Rendering that as a zero-width bar would assert "instant" — a duration nobody
  // took. It gets its own material and says what it is.
  if (elapsedMs == null || !anyPart) {
    return (
      <span
        role="img"
        aria-label={
          elapsedMs == null
            ? "Duration not recorded for this step."
            : `${formatDuration(elapsedMs)} elapsed; how it was spent is not recorded.`
        }
        data-seg="absent"
        style={{
          display: "inline-block",
          // 6px, not 10. The encoding and the hues are unchanged; this is purely ink.
          // With tone off the tags, these bars became the most saturated thing on both
          // screens — wider and brighter than the figures they sit beside, while
          // encoding measurement coverage rather than the run's headline fact. Halving
          // the height halves the area without touching what the bar says. It stays a
          // composition rather than a fill, and the hatched ground still reads.
          height: 6,
          width: "100%",
          minWidth: 48,
          borderRadius: 2,
          border: "1px dashed var(--hairline-strong)",
          background: "transparent",
          ...style,
        }}
      />
    );
  }

  const working = workingMs ?? 0;
  const parked = parkedMs ?? 0;
  const unaccounted = unaccountedMs ?? 0;
  const sum = working + parked + unaccounted;

  // Tolerate sub-second float drift, nothing more.
  const mismatch = elapsedMs <= 0 || Math.abs(sum - elapsedMs) > SECOND;

  const readout =
    `${formatDuration(elapsedMs)} elapsed · ${formatDuration(working)} working · ` +
    `${formatDuration(parked)} parked · ${formatDuration(unaccounted)} unaccounted` +
    (mismatch ? ` — these do not add up to the elapsed time, so the split can't be trusted.` : "");

  if (mismatch) {
    return (
      <span
        role="img"
        aria-label={readout}
        data-seg="mismatch"
        style={{
          display: "inline-block",
          // 6px, not 10. The encoding and the hues are unchanged; this is purely ink.
          // With tone off the tags, these bars became the most saturated thing on both
          // screens — wider and brighter than the figures they sit beside, while
          // encoding measurement coverage rather than the run's headline fact. Halving
          // the height halves the area without touching what the bar says. It stays a
          // composition rather than a fill, and the hatched ground still reads.
          height: 6,
          width: "100%",
          minWidth: 48,
          borderRadius: 2,
          border: "1px solid var(--err)",
          background: "transparent",
          ...style,
        }}
      />
    );
  }

  const pctOf = (v: number) => `${(v / elapsedMs) * 100}%`;

  // Two channels, each answering one question, because one channel answering three
  // was unreadable without a legend:
  //
  //   HUE      whose time was this   — green Orca, violet the reader
  //   MATERIAL did we measure it     — solid painted, hatched ground
  //
  // Unaccounted is the GROUND rather than a third segment. As a trailing block it
  // sat exactly where a progress bar's "remaining" lives, and a left-anchored green
  // fill growing rightward is over-determined before any of our semantics land — on
  // a mixed row it was literally a green bar at 26%. Painting the known parts onto
  // unknown ground removes the fill reading and removes a category the reader had to
  // learn: a run with nothing observed is now visibly all-ground rather than looking
  // like a broken row.
  //
  // Parked deliberately does NOT use --accent. That token is the link, the selected
  // tab and the `running` tone, so the widest band on most rows was reading as a
  // control. Violet is unspent here and carries no verdict — which is the point:
  // the park is Orca going quiet, not the reader being slow, and hue cannot hold a
  // caveat. Amber is reserved for a park the reader can act on right now, which is
  // a per-intervention state this bar cannot see and must not guess at.
  return (
    <span
      role="img"
      aria-label={readout}
      data-seg="unaccounted"
      data-material="hatched"
      style={{
        display: "flex",
        // 6px, not 10. The encoding and the hues are unchanged; this is purely ink.
        // With tone off the tags, these bars became the most saturated thing on both
        // screens — wider and brighter than the figures they sit beside, while
        // encoding measurement coverage rather than the run's headline fact. Halving
        // the height halves the area without touching what the bar says. It stays a
        // composition rather than a fill, and the hatched ground still reads.
        height: 6,
        width: "100%",
        minWidth: 48,
        borderRadius: 2,
        overflow: "hidden",
        backgroundImage:
          "repeating-linear-gradient(45deg, var(--hairline-strong) 0 2px, transparent 2px 5px)",
        ...style,
      }}
    >
      {/* Watched. */}
      <span data-seg="working" style={{ width: pctOf(working), background: "var(--run)" }} />
      {/* Waiting on a person — a different kind of time, not a lesser one. */}
      <span data-seg="parked" style={{ width: pctOf(parked), background: "var(--accent-2)" }} />
      {/* No third child: the width unaccounted would have occupied is the ground
          showing through. `unaccountedMs` is still taken as an INPUT and still
          checked against the sum above — deriving it as track-minus-painted would
          make a mismatch unrepresentable, and an undetectable discrepancy is worse
          than a visible one. A value you receive can disagree with you; one you
          compute cannot. */}
    </span>
  );
}

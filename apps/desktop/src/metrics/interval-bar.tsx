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
          height: 10,
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
          height: 10,
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

  return (
    <span
      role="img"
      aria-label={readout}
      style={{
        display: "flex",
        height: 10,
        width: "100%",
        minWidth: 48,
        borderRadius: 2,
        overflow: "hidden",
        background: "var(--hairline)",
        ...style,
      }}
    >
      {/* Watched. */}
      <span data-seg="working" style={{ width: pctOf(working), background: "var(--run)" }} />
      {/* Waiting on a person — a different kind of time, not a lesser one. */}
      <span data-seg="parked" style={{ width: pctOf(parked), background: "var(--accent)" }} />
      {/* Unobserved. Hatched rather than merely tinted, so it survives being read
          without colour and cannot be mistaken for a measured category. */}
      <span
        data-seg="unaccounted"
        data-material="hatched"
        style={{
          width: pctOf(unaccounted),
          backgroundImage:
            "repeating-linear-gradient(45deg, var(--hairline-strong) 0 2px, transparent 2px 5px)",
        }}
      />
    </span>
  );
}

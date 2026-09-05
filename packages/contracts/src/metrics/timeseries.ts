import { z } from "zod";

// ── Curated time series ──────────────────────────────────────────────────────
//
// Deliberately NOT a generic "group `events` by type". Those 47 type strings are
// internal plumbing: each is named by whichever subsystem happened to emit it,
// nothing has committed to their stability, and half are not run-attributable
// (`harness.transition.recorded` carries no run id). A chart keyed on them loses a
// series SILENTLY when a subsystem is refactored — no failure, just a line that
// stops — which is the worst way for a dashboard to be wrong.
//
// So the wire vocabulary is a closed set defined here, each series stating the
// source and the timestamp it is placed by. Adding a chart sometimes means adding
// a series. That is the feature: it forces someone to say what the new line means
// before it can be drawn.

export const TimeseriesId = z.enum(["session_started", "session_failed"]);
export type TimeseriesId = z.infer<typeof TimeseriesId>;

/**
 * Which record a series is placed by. Named on the wire for the same reason the
 * progress clocks name theirs: a bare count over time hides whether its timestamps
 * mean what the reader assumes.
 */
export const TimeseriesSpec: Record<
  TimeseriesId,
  { label: string; placedBy: string; caveat: string | null }
> = {
  session_started: {
    label: "Agent sessions started",
    placedBy: "sessions.created_at",
    caveat: null,
  },
  session_failed: {
    label: "Agent sessions that failed",
    placedBy: "sessions.exited_at",
    // The same hazard as `activities.updated_at`: a name that promises more than
    // the value carries. `exited_at` is when the daemon NOTICED and stamped the
    // failure, which the liveness watchdog does one grace window plus one tick
    // after the worker actually died. The shape of the series is right; the
    // placement lags reality by up to ~20s, and a reader comparing it against
    // something with a true event time should know that.
    caveat: "Stamped when the daemon noticed the failure, not when the worker died.",
  },
};

/**
 * The server chooses the bucket from the window and REPORTS it. A caller choosing
 * blindly gets a six-week window in hour buckets: a thousand buckets of mostly
 * zero, which is a chart that renders and says nothing.
 */
export const TimeseriesBucket = z.enum(["hour", "day", "week"]);
export type TimeseriesBucket = z.infer<typeof TimeseriesBucket>;

export const TimeseriesPoint = z.object({
  /** Bucket START, inclusive. A point covers [at, at + bucket). */
  at: z.string(),
  count: z.number().int().nonnegative(),
}).strict();
export type TimeseriesPoint = z.infer<typeof TimeseriesPoint>;

export const TimeseriesSeries = z.object({
  id: TimeseriesId,
  label: z.string(),
  placedBy: z.string(),
  caveat: z.string().nullable(),
  /**
   * Every bucket in the window, including empty ones. A zero here is an
   * observation — nothing happened in that hour — and omitting it would leave the
   * renderer to invent the difference between "no events" and "no bucket".
   */
  points: z.array(TimeseriesPoint),
}).strict();
export type TimeseriesSeries = z.infer<typeof TimeseriesSeries>;

export const TimeseriesResponse = z.object({
  from: z.string(),
  to: z.string(),
  bucket: TimeseriesBucket,
  series: z.array(TimeseriesSeries),
}).strict();
export type TimeseriesResponse = z.infer<typeof TimeseriesResponse>;

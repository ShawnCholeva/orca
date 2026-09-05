import type Database from "better-sqlite3";
import {
  TimeseriesSpec,
  type TimeseriesBucket,
  type TimeseriesId,
  type TimeseriesResponse,
  type TimeseriesSeries,
} from "@orca/contracts";

// Server-side bucketing. Returning raw rows would work today at ~1,400 and stop
// working exactly when the charts get interesting; the aggregation belongs on the
// side that can index for it.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export const BUCKET_MS: Record<TimeseriesBucket, number> = { hour: HOUR, day: DAY, week: WEEK };

/**
 * The bucket is derived from the window, never taken from the caller. Chosen to
 * keep a chart between roughly 12 and 200 points: below that the shape is noise,
 * above it every bucket is empty and the line says nothing.
 */
export function bucketFor(windowMs: number): TimeseriesBucket {
  if (windowMs <= 3 * DAY) return "hour";
  if (windowMs <= 16 * WEEK) return "day";
  return "week";
}

/** Floors a timestamp to its bucket start, in UTC. */
export function bucketStartMs(atMs: number, bucket: TimeseriesBucket): number {
  return Math.floor(atMs / BUCKET_MS[bucket]) * BUCKET_MS[bucket];
}

/**
 * The one place a series is bound to a source. Each returns the timestamps of its
 * own events; everything else — bucketing, zero-filling, the wire shape — is shared,
 * so a new series cannot accidentally invent a different notion of "when".
 */
const SERIES_SOURCE: Record<
  TimeseriesId,
  (db: Database.Database, fromIso: string, toIso: string) => string[]
> = {
  session_started: (db, fromIso, toIso) =>
    (db
      .prepare(
        "SELECT created_at AS at FROM sessions WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC"
      )
      .all(fromIso, toIso) as Array<{ at: string }>).map((r) => r.at),

  // Placed by `exited_at`, which is when the daemon NOTICED — see the caveat on
  // TimeseriesSpec. A failed session with no exited_at cannot be placed on a
  // timeline at all, so it is omitted rather than being given a made-up position.
  session_failed: (db, fromIso, toIso) =>
    (db
      .prepare(
        `SELECT exited_at AS at FROM sessions
         WHERE status = 'failed' AND exited_at IS NOT NULL
           AND exited_at >= ? AND exited_at < ?
         ORDER BY exited_at ASC`
      )
      .all(fromIso, toIso) as Array<{ at: string }>).map((r) => r.at),
};

/**
 * Every bucket in the window, including empty ones. A zero is an observation —
 * nothing happened in that hour — and omitting empty buckets would leave the
 * renderer to invent the difference between "no events" and "no bucket".
 */
function bucketize(
  timestamps: string[],
  fromMs: number,
  toMs: number,
  bucket: TimeseriesBucket
): TimeseriesSeries["points"] {
  const size = BUCKET_MS[bucket];
  const start = bucketStartMs(fromMs, bucket);
  const counts = new Map<number, number>();
  for (const iso of timestamps) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) continue;
    const b = bucketStartMs(t, bucket);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const points: TimeseriesSeries["points"] = [];
  for (let b = start; b < toMs; b += size) {
    points.push({ at: new Date(b).toISOString(), count: counts.get(b) ?? 0 });
  }
  return points;
}

export function computeTimeseries(
  db: Database.Database,
  input: { ids: TimeseriesId[]; fromIso: string; toIso: string }
): TimeseriesResponse {
  const fromMs = Date.parse(input.fromIso);
  const toMs = Date.parse(input.toIso);
  const bucket = bucketFor(Math.max(0, toMs - fromMs));
  return {
    from: input.fromIso,
    to: input.toIso,
    bucket,
    series: input.ids.map((id) => ({
      id,
      label: TimeseriesSpec[id].label,
      placedBy: TimeseriesSpec[id].placedBy,
      caveat: TimeseriesSpec[id].caveat,
      points: bucketize(SERIES_SOURCE[id](db, input.fromIso, input.toIso), fromMs, toMs, bucket),
    })),
  };
}

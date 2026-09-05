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
 * own events; everything else — bucketing, zero-filling, the wire shape — is
 * shared, so a new series cannot accidentally invent a different notion of "when".
 *
 * SOURCED FROM THE EVENT LOG, NOT THE `sessions` TABLE, and the reason is the
 * whole design. `sessions` rows are HARD-DELETED when their workspace is deleted
 * (`workspaces/usecases.ts` drops FK enforcement, deletes the goals, then deletes
 * every FK-violating row transitively). `events` has no FK on `goal_id`, so it
 * survives that purge.
 *
 * On this database the difference is already real: 56 `session.created` events
 * against 48 surviving rows, and 30 `session.failed` events against 27. All 30
 * are distinct session ids, 3 of them belonging to sessions that no longer exist.
 *
 * A table-sourced chart would not merely report a smaller number — **it would
 * report a different past tomorrow**, shrinking a historical spike every time a
 * workspace is deleted. A historical chart asks what HAPPENED; only an
 * append-only log can answer that. ("What IS" is the right question for a
 * population, and the wrong one for a timeline.)
 */
function sessionEventTimestamps(
  db: Database.Database,
  type: string,
  fromIso: string,
  toIso: string
): string[] {
  const rows = db
    .prepare(
      "SELECT payload, created_at FROM events WHERE type = ? AND created_at >= ? AND created_at < ? ORDER BY seq ASC"
    )
    .all(type, fromIso, toIso) as Array<{ payload: string; created_at: string }>;
  // Counted once per SESSION, not once per event. Today the two are identical —
  // 30 events, 30 distinct ids — so this changes no number; it makes the series
  // mean what its label says, so a duplicate emission could never silently
  // inflate it. The shape enforces it rather than a check catching it later.
  const firstSeen = new Map<string, string>();
  for (const r of rows) {
    let sid: unknown;
    try { sid = (JSON.parse(r.payload) as { sessionId?: unknown }).sessionId; } catch { continue; }
    if (typeof sid !== "string" || firstSeen.has(sid)) continue;
    firstSeen.set(sid, r.created_at);
  }
  return [...firstSeen.values()];
}

const SERIES_SOURCE: Record<
  TimeseriesId,
  (db: Database.Database, fromIso: string, toIso: string) => string[]
> = {
  session_started: (db, fromIso, toIso) =>
    sessionEventTimestamps(db, "session.created", fromIso, toIso),
  session_failed: (db, fromIso, toIso) =>
    sessionEventTimestamps(db, "session.failed", fromIso, toIso),
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

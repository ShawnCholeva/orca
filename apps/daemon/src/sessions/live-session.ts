/**
 * SQL predicate for "this session is still live" — expressed as the TERMINAL
 * statuses it excludes, never as a list of live ones.
 *
 * Nine separate queries hand-rolled `status IN ('running','starting')` and every
 * one of them was wrong the same way: sessions are INSERTed as `created` and stay
 * there for the whole of spawn(), and nothing in the daemon ever writes
 * `starting` at all. The allow-lists silently skipped live workers — in the boot
 * sweep that meant killing one mid-turn (defb43e), and elsewhere it meant
 * dropping the user's answer, ignoring an interrupt, or leaking a pane.
 *
 * A denylist is correct by construction: a new pre-running status is picked up
 * automatically, so the failure mode of forgetting one is at worst a stale row —
 * never a live agent treated as absent.
 *
 * Ordering note for callers: `started_at` is NULL until markRunning, so
 * `ORDER BY started_at DESC` sorts a just-spawned session LAST and defeats the
 * point of this predicate. Order by `created_at` (set at INSERT) or `rowid`.
 */
export function liveSessionSql(column = "status"): string {
  return `${column} NOT IN ('exited', 'failed', 'stopped', 'archived')`;
}

/** Convenience for unaliased `sessions` queries. */
export const LIVE_SESSION = liveSessionSql();

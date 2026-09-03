/**
 * Was this step blocked by the SUBSTRATE or by the workflow?
 *
 * `blocked_reason` is free text the daemon writes on the way down
 * ("crashed 3 times (worker_exited_no_signal)", "no progress after 3 restarts"),
 * and it is the only record of a step that never got to be judged. Until now it
 * reached the metrics surface as a raw five-item tail and nothing aggregated it,
 * which is why a step could score 16/100 with an EMPTY failure list: the score
 * counts blocked finals, while failureModes is built from evidence/refute facets
 * that all said "passed". Two sources, opposite stories, one tile.
 *
 * These stay in their own array rather than joining failureModes, because a run
 * that crashed out is not a low-quality run — it is a run that never got to be
 * judged, and the two must never share a tile.
 *
 * NOTE: `deriveTermination` in ./runs.ts classifies the same signals at RUN level
 * with its own copy of these markers. This module is the intended single home;
 * runs.ts should import from here rather than keep a second list, since a marker
 * added to one and not the other silently splits the taxonomy. Left to that
 * file's owner to switch over.
 */

/** Free-text blocked_reason markers the daemon writes for substrate failures. */
export const INFRA_REASON_MARKERS: readonly { marker: string; label: string }[] = [
  { marker: "worker_exited_no_signal", label: "Worker died without reporting why" },
  { marker: "worker_stalled", label: "Worker stopped making progress" },
  { marker: "no progress after", label: "Worker stopped making progress" },
  { marker: "crashed", label: "Worker crashed and could not be recovered" },
  { marker: "worker_answer_delivery_failed", label: "Could not deliver the answer to the worker" },
];

/**
 * A plain-language label when the reason names the substrate failing, else null.
 * Order matters: the specific markers are checked before the generic "crashed",
 * because the daemon writes "crashed 3 times (worker_exited_no_signal)" — which
 * matches both, and the parenthesised cause is the more useful of the two.
 */
export function classifyInfraReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const haystack = reason.toLowerCase();
  for (const { marker, label } of INFRA_REASON_MARKERS) {
    if (haystack.includes(marker)) return label;
  }
  return null;
}

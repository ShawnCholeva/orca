import type { Activity, ActivityDiff } from "@orca/contracts";

/**
 * One piece of an agent activity as it lands in the chat timeline.
 *
 * An activity is a WHOLE TURN, and its card grows for the turn's entire life. A
 * diff, meanwhile, renders as its own card so code changes break up the timeline
 * instead of hiding behind a toggle. Those two facts used to fight: every diff
 * was timestamped with `activity.createdAt` (the turn's START), so the timeline
 * read [whole card] → [all its diffs] and the rest of the turn streamed in ABOVE
 * a diff the reader had already scrolled past. A live eleven-row thread rendered
 * above a .gitignore edit that was its fourth step, and the run looked stuck.
 *
 * Splitting the turn at its diff boundaries fixes the ordering at its source: the
 * newest work is always the bottom-most thing on screen, which is the only
 * invariant that makes "is this still going?" answerable at a glance. Sorting
 * diffs by their own step's timestamp is NOT sufficient on its own — the card is
 * a single node, so it would still swallow every row that came after.
 */
export type ActivityPart =
  | {
      kind: "card";
      at: string;
      seq: number;
      /** The activity narrowed to this segment's steps. */
      activity: Activity;
      /** Only the first segment carries the step-name header. */
      head: boolean;
      /** Only the last segment carries the live pulse and the closing summary. */
      tail: boolean;
    }
  | { kind: "diff"; at: string; seq: number; diff: ActivityDiff; caption: string };

/** A step's own timestamp, falling back to its turn's when a row predates the field. */
function stepAt(stepCreatedAt: string | undefined, activity: Activity): string {
  return stepCreatedAt && stepCreatedAt.length > 0 ? stepCreatedAt : activity.createdAt;
}

/**
 * Would a trailing card with these steps render anything at all? An empty
 * segment is worth emitting only when it still owns the live pulse (the turn is
 * running) or the closing summary — otherwise it is an empty bordered box.
 */
function trailingCardHasContent(activity: Activity, steps: Activity["steps"]): boolean {
  if (steps.length > 0) return true;
  if (activity.status === "active") return true;
  return (
    activity.status === "completed" &&
    activity.finalSummary !== null &&
    activity.finalSummary.trim().length > 0
  );
}

/**
 * Splits one activity into time-ordered timeline parts, cutting a new segment
 * after every step that carried a diff. The diff-bearing step KEEPS its row in
 * the thread above its diff card (the row narrates the action, the card shows
 * the change), matching what the single-card layout already did.
 *
 * `renderCards` is false for an activity that earns no card of its own — an
 * orchestrator-reasoning turn, say — whose diffs must still reach the timeline.
 */
export function splitActivityAtDiffs(activity: Activity, renderCards: boolean): ActivityPart[] {
  const steps = activity.steps ?? [];
  const parts: ActivityPart[] = [];
  let buffer: Activity["steps"] = [];
  let anchor = activity.createdAt;
  let seq = 0;

  const pushCard = (segmentSteps: Activity["steps"], tail: boolean) => {
    parts.push({
      kind: "card",
      at: anchor,
      seq: seq++,
      activity: { ...activity, steps: segmentSteps },
      head: !parts.some((p) => p.kind === "card"),
      tail,
    });
  };

  for (const step of steps) {
    buffer.push(step);
    if (step.diff == null) continue;
    const at = stepAt(step.createdAt, activity);
    if (renderCards) pushCard(buffer, false);
    parts.push({ kind: "diff", at, seq: seq++, diff: step.diff, caption: step.text });
    buffer = [];
    anchor = at;
  }

  if (renderCards && trailingCardHasContent(activity, buffer)) pushCard(buffer, true);
  return parts;
}

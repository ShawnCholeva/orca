import type Database from "better-sqlite3";
import { ReplayPage } from "@orca/contracts";
import type { HarnessTransition } from "@orca/contracts";
import { listTransitionsByGoalPaged } from "../harness-transitions/usecases.js";

// Default page size keeps the replay wire shape slim; a goal with more
// transitions is reachable by following `page.nextCursor` from genesis forward.
const DEFAULT_PAGE_LIMIT = 1000;
const MAX_PAGE_LIMIT = 10_000;

interface ReplayCursor {
  createdAt: string;
  id: string;
  seq: number;
}

function encodeCursor(c: ReplayCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string): ReplayCursor {
  return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as ReplayCursor;
}

/**
 * Derive a one-line summary for a transition from its facets, keyed by boundary.
 * - `tool_gate`     -> the gate decision (allow / require_approval / deny).
 * - `step_complete` -> the evidence verdict, falling back to the telemetry outcome status.
 * Other boundaries (e.g. `step_launch`, `mark_done`) have no canonical facet summary,
 * so we fall back to the boundary name itself.
 */
function summarize(t: HarnessTransition): string {
  switch (t.boundary) {
    case "tool_gate":
      return t.risk?.gate_decision ?? t.boundary;
    case "step_complete":
      return t.evidence?.verdict ?? t.telemetry?.outcome.status ?? t.boundary;
    default:
      return t.boundary;
  }
}

/**
 * Read-only control-plane replay: an ordered (chronological) reconstruction of a
 * goal's transition trajectory. Locked design D5 — this is NOT full event-sourcing,
 * just a compact projection of recorded transitions in the order they occurred.
 *
 * Pages are keyset-ordered oldest-first (`created_at ASC, id ASC`), so a goal
 * exceeding one page reconstructs from genesis by following `page.nextCursor`
 * rather than dropping its oldest history. `seq` stays absolute across pages.
 * An existing goal with no transitions yields an empty, closed page.
 */
export function replayControlPlane(
  db: Database.Database,
  goalId: string,
  opts: { cursor?: string | null; limit?: number } = {}
): ReplayPage {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  // Over-fetch one row to detect whether a further page exists.
  const rows = listTransitionsByGoalPaged(db, goalId, {
    after: cursor ? { createdAt: cursor.createdAt, id: cursor.id } : null,
    limit: limit + 1,
  });
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const seqBase = cursor ? cursor.seq + 1 : 0;
  const steps = pageRows.map((t, i) => ({
    seq: seqBase + i,
    boundary: t.boundary,
    at: t.createdAt,
    summary: summarize(t),
    facets: { risk: t.risk, evidence: t.evidence, telemetry: t.telemetry },
  }));
  const lastRow = pageRows[pageRows.length - 1];
  const lastStep = steps[steps.length - 1];
  const nextCursor =
    hasMore && lastRow && lastStep
      ? encodeCursor({ createdAt: lastRow.createdAt, id: lastRow.id, seq: lastStep.seq })
      : null;
  return ReplayPage.parse({ steps, page: { nextCursor, hasMore } });
}

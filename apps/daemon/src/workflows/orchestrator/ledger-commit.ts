import type Database from "better-sqlite3";
import {
  LedgerUpdate,
  type DomainEvent,
  type WorkflowRun as WorkflowRunT,
  type WorkflowStepTemplate,
} from "@orca/contracts";
import { createArtifact } from "../artifacts/usecases.js";
import { commitLedgerVersion } from "../ledger/usecases.js";
import { latestCommittedLedger } from "../ledger/projection.js";
import { parseStepCompletionEnvelope } from "./orca-output.js";
import { reviewAndNormalizeLedgerUpdates } from "../ledger/review.js";
import type { GoalRow, StepRunRow } from "./db-rows.js";
import type { RequestNextDecisionOptions } from "./dispatch-types.js";

export async function completeStepWithLedger(
  db: Database.Database,
  now: () => string,
  ctx: {
    run: WorkflowRunT;
    stepRun: StepRunRow;
    stepTpl: WorkflowStepTemplate;
    goal: GoalRow;
  },
  block: unknown,
  options: RequestNextDecisionOptions,
  stagedEvents: DomainEvent[],
  onReject: "revise" | "drop" = "revise"
): Promise<{ rejections: string[] } | null> {
  const { output, ledgerUpdates } = parseStepCompletionEnvelope(block);

  // Guard the proposed updates even though parseStepCompletionEnvelope already
  // returns typed updates (defensive: bare-output back-compat returns []).
  const guard = LedgerUpdate.array().safeParse(ledgerUpdates);
  if (!guard.success) {
    if (onReject === "revise") return { rejections: ["ledger_updates failed schema validation"] };
    // drop: complete with an empty ledger version (the user already approved).
    commitStepOutputAndLedger(db, now, ctx, output, [], options, stagedEvents);
    return null;
  }

  // Async review/normalize MUST happen before opening the synchronous tx.
  const committed = latestCommittedLedger(db, ctx.run.id);
  const review = await reviewAndNormalizeLedgerUpdates(
    {},
    { committed, proposals: guard.data }
  );
  if (review.rejected.length > 0 && onReject === "revise") {
    return { rejections: review.rejected.map((r) => r.reason) };
  }
  if (review.rejected.length > 0 && onReject === "drop") {
    console.warn("[ledger] dropping rejected proposals on confirm (user already approved)", { stepRunId: ctx.stepRun.id, count: review.rejected.length, reasons: review.rejected.map((r) => r.reason) });
  }

  commitStepOutputAndLedger(db, now, ctx, output, review.accepted, options, stagedEvents);
  return null;
}

/** Atomic: step_output write + ledger version commit roll back together. */
export function commitStepOutputAndLedger(
  db: Database.Database,
  now: () => string,
  ctx: { run: WorkflowRunT; stepRun: StepRunRow; stepTpl: WorkflowStepTemplate; goal: GoalRow },
  output: unknown,
  updates: LedgerUpdate[],
  options: RequestNextDecisionOptions,
  stagedEvents: DomainEvent[]
): void {
  // Atomic: step_output write + ledger version commit roll back together.
  // (createArtifact and commitLedgerVersion each open their own tx; nested
  // here they become SAVEPOINTs under this single outer transaction.)
  db.transaction(() => {
    createStepOutputArtifact(db, now, ctx, JSON.stringify(output ?? {}), options, stagedEvents);
    commitLedgerVersion(db, now, {
      goalId: ctx.run.goalId,
      workflowRunId: ctx.run.id,
      sourceStepRunId: ctx.stepRun.id,
      traversalSeq: ctx.run.traversalSeq,
      updates,
    });
  })();
}

export function createStepOutputArtifact(
  db: Database.Database,
  now: () => string,
  ctx: {
    run: WorkflowRunT;
    stepRun: StepRunRow;
    stepTpl: WorkflowStepTemplate;
    goal: GoalRow;
  },
  body: string,
  options: RequestNextDecisionOptions,
  stagedEvents: DomainEvent[]
): void {
  createArtifact(
    db,
    now,
    {
      goalId: ctx.goal.id,
      workflowRunId: ctx.run.id,
      stepRunId: ctx.stepRun.id,
      type: "step_output",
      title: ctx.stepTpl.name.slice(0, 256),
      body,
      source: "orchestrator",
      linkedSessionId: null,
      linkedTaskId: null,
      linkedContextPackageId: null,
    },
    options.idFactory,
    stagedEvents
  );
}

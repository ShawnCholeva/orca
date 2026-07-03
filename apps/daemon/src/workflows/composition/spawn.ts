import type Database from "better-sqlite3";
import type { EventBus } from "../../events.js";
import { startWorkflowRun } from "../runs/usecases.js";
import { createArtifact } from "../artifacts/usecases.js";
import { insertComposition, nextSpawnSeq } from "./store.js";
import { resolveReads } from "./reads-writes.js";
import { delegationDepth, MAX_DELEGATION_DEPTH } from "./depth.js";
import { emitDelegateSpawn } from "../../harness-transitions/emit.js";

export class DelegationDepthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegationDepthError";
  }
}

export interface SpawnDeps {
  db: Database.Database;
  bus: EventBus;
  now: () => string;
  idFactory: () => string;
}

export function spawnChildRun(
  deps: SpawnDeps,
  args: {
    goalId: string;
    parentRun: { id: string };
    delegateNode: {
      id: string;
      childTemplateId: string;
      childTemplateVersion: number;
      reads: Record<string, string>;
      writes: Record<string, string>;
    };
    parentOutputs: Record<string, unknown>;
    workspaceSnapshotJson: string | null;
  },
): { childRunId: string; compositionId: string } {
  const { db, now, idFactory } = deps;

  // 1. Depth guard — check before any writes.
  const depth = delegationDepth(db, args.parentRun.id) + 1;
  if (depth > MAX_DELEGATION_DEPTH) {
    throw new DelegationDepthError(
      `delegation depth ${depth} exceeds MAX_DELEGATION_DEPTH (${MAX_DELEGATION_DEPTH})`
    );
  }

  // Steps 2–7 are wrapped in a single transaction so the delegation-entry state
  // mutation is atomic: parent parked → child created → composition row inserted →
  // child linked → entry artifact seeded → delegate_spawn emitted. A crash mid-
  // sequence previously orphaned the parent in 'delegating' with no active child.
  //
  // EVENT-ORDERING NUANCE: startWorkflowRun, createArtifact, and emitDelegateSpawn
  // each publish in-process EventBus events after their inner SAVEPOINTs release but
  // before the OUTER transaction commits. On the happy path this is fine. On a rare
  // rollback (a later step throwing), an already-published in-process event could
  // reference rolled-back DB state. Fully deferring event publication to after the
  // outer commit requires threading staged events through those callees and is out of
  // scope for this fix. DB atomicity is what matters most here and is now guaranteed.
  const { childRunId, compositionId } = db.transaction(() => {
    // 2. Park the parent to 'delegating' BEFORE startWorkflowRun.
    //    startWorkflowRun checks for status IN ('active','paused','blocked') — parking
    //    first moves the parent out of that set so the child can be created active.
    db.prepare(`UPDATE workflow_runs SET status = 'delegating' WHERE id = ?`).run(
      args.parentRun.id
    );

    // 3. Create the child run (own snapshot of the pinned child template).
    //    startWorkflowRun also sets goals.active_workflow_run_id = child.id.
    const child = startWorkflowRun(
      { db, bus: deps.bus, now, idFactory },
      { goalId: args.goalId, templateId: args.delegateNode.childTemplateId }
    );

    // 4. Composition row.
    const compositionId = idFactory();
    const seq = nextSpawnSeq(db, args.parentRun.id, args.delegateNode.id);
    insertComposition(
      db,
      {
        id: compositionId,
        goalId: args.goalId,
        parentRunId: args.parentRun.id,
        childRunId: child.id,
        delegateNodeId: args.delegateNode.id,
        spawnSeq: seq,
        reads: args.delegateNode.reads,
        writes: args.delegateNode.writes,
        depth,
        status: "active",
        costRollupUsd: null,
        createdAt: now(),
        finishedAt: null,
      },
      args.workspaceSnapshotJson
    );

    // 5. Link the child run back to the composition row.
    db.prepare(`UPDATE workflow_runs SET parent_composition_id = ? WHERE id = ?`).run(
      compositionId,
      child.id
    );

    // 6. Seed the child's isolated state: resolved reads as a synthetic entry artifact.
    //    workflow_artifacts.step_run_id has no NOT NULL constraint — null is valid here.
    const entry = resolveReads(args.delegateNode.reads, args.parentOutputs);
    createArtifact(
      db,
      now,
      {
        goalId: args.goalId,
        workflowRunId: child.id,
        stepRunId: null,
        type: "step_output",
        title: "delegation entry inputs",
        body: JSON.stringify(entry),
        source: "orchestrator",
        linkedSessionId: null,
        linkedTaskId: null,
        linkedContextPackageId: null,
      },
      idFactory,
      []
    );

    // 7. Emit the delegate_spawn harness transition (inspectable axis I7).
    emitDelegateSpawn(
      { db, bus: deps.bus, now, idFactory },
      {
        goalId: args.goalId,
        workflowRunId: args.parentRun.id,
        workflowStepRunId: null,
        composition: {
          childRunId: child.id,
          childTemplateId: args.delegateNode.childTemplateId,
          childTemplateVersion: args.delegateNode.childTemplateVersion,
          readsKeys: Object.keys(args.delegateNode.reads),
          writesKeys: Object.keys(args.delegateNode.writes),
          depth,
          costRollupUsd: null,
        },
      }
    );

    return { childRunId: child.id, compositionId };
  })();

  return { childRunId, compositionId };
}

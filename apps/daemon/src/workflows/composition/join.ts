import type Database from "better-sqlite3";
import type { WorkflowGraph } from "@orca/contracts";
import type { EventBus } from "../../events.js";
import { getCompositionByChildRun, updateCompositionStatus, descendantRunIds } from "./store.js";
import { mapWrites } from "./reads-writes.js";
import { createArtifact } from "../artifacts/usecases.js";
import { getWorkflowRunById } from "../runs/projection.js";
import { loadRunTemplate } from "../runs/run-template.js";
import { buildGoalCostRollup } from "../../harness-state/cost-rollup.js";
import { listTransitionsByGoal } from "../../harness-transitions/usecases.js";
import { emitDelegateJoin } from "../../harness-transitions/emit.js";
import { insertStepForRouting, nextAttemptForStep, stepFingerprint } from "../steps/usecases.js";
import { effectiveGraph } from "../graph/graph-routing.js";
import type { Destination } from "../graph/graph-routing.js";

export interface JoinDeps {
  db: Database.Database;
  bus: EventBus;
  now: () => string;
  idFactory: () => string;
}

/**
 * Resolve the next destination for a delegate node. Cannot use resolveStepNext
 * because that asserts node.type === "step".
 */
function resolveDelegateNext(graph: WorkflowGraph, delegateNodeId: string): Destination {
  const out = graph.edges.filter((e) => e.from === delegateNodeId);
  if (out.length !== 1) {
    throw new Error(`delegate node ${delegateNodeId} must have exactly one outgoing edge, found ${out.length}`);
  }
  const toNode = graph.nodes.find((n) => n.id === out[0].to);
  if (!toNode) throw new Error(`unknown target node: ${out[0].to}`);
  if (toNode.type === "gate") return { kind: "gate", nodeId: out[0].to };
  if (toNode.type === "splitter") return { kind: "splitter", nodeId: out[0].to };
  return { kind: "step", nodeId: out[0].to };
}

/**
 * Read the child run's terminal step output artifact body, parsed as a record.
 * Prefers the artifact for the known terminalStepRunId; falls back to the most
 * recent step_output in the run. Returns {} when nothing is found.
 */
function readChildTerminalStepOutput(
  db: Database.Database,
  childRunId: string,
  terminalStepRunId: string | null
): Record<string, unknown> {
  if (terminalStepRunId) {
    const row = db
      .prepare(
        `SELECT body FROM workflow_artifacts
         WHERE workflow_run_id = ? AND step_run_id = ? AND type = 'step_output'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(childRunId, terminalStepRunId) as { body: string } | undefined;
    if (row) {
      try {
        return JSON.parse(row.body) as Record<string, unknown>;
      } catch {
        // fall through to fallback
      }
    }
  }

  // Fallback: most recent step_output in the child run
  const fallback = db
    .prepare(
      `SELECT body FROM workflow_artifacts
       WHERE workflow_run_id = ? AND type = 'step_output'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(childRunId) as { body: string } | undefined;
  if (fallback) {
    try {
      return JSON.parse(fallback.body) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }

  return {};
}

/**
 * Join a completed child run back into its parent. Reads the child's verdict,
 * maps its writes into the parent namespace, advances the parent cursor to the
 * next node, and emits a delegate_join harness transition.
 *
 * Returns `outcome: "joined"` on a passed verdict, or `"propagated_failure"`
 * when the verdict is non-passing (parent is blocked and composition is failed).
 */
export function joinChildRun(
  deps: JoinDeps,
  childRunId: string
): { parentRunId: string; outcome: "joined" | "propagated_failure" } {
  const { db, bus, now, idFactory } = deps;

  // 1. Load composition (fail fast if missing — programming error)
  const composition = getCompositionByChildRun(db, childRunId);
  if (!composition) throw new Error(`no composition found for child run: ${childRunId}`);
  const { id: compositionId, goalId, parentRunId, delegateNodeId, reads, writes, depth } = composition;

  // 2. Read child evidence (OUTSIDE transaction — read-only)
  const transitions = listTransitionsByGoal(db, goalId, 10_000);

  let verdict: "passed" | "failed" | "partial" | null = null;
  let terminalStepRunId: string | null = null;
  let childUntestedRegions: string[] = [];
  let childResidualRisk: string[] = [];

  // Primary: most recent step_complete for this child run that has evidence.
  // listTransitionsByGoal returns DESC by created_at so first match = most recent.
  for (const t of transitions) {
    if (t.boundary === "step_complete" && t.workflowRunId === childRunId && t.evidence !== null) {
      verdict = t.evidence.verdict;
      terminalStepRunId = t.workflowStepRunId ?? null;
      childUntestedRegions = t.evidence.untestedRegions ?? [];
      childResidualRisk = t.evidence.residualRisk ?? [];
      break;
    }
  }

  // Fallback: read verdict from the terminal step run's step_result_json
  if (verdict === null) {
    const terminalRow = db
      .prepare(
        `SELECT id, step_result_json FROM workflow_step_runs
         WHERE workflow_run_id = ? ORDER BY ordinal DESC LIMIT 1`
      )
      .get(childRunId) as { id: string; step_result_json: string | null } | undefined;

    if (terminalRow) {
      terminalStepRunId = terminalRow.id;
      if (terminalRow.step_result_json) {
        try {
          const result = JSON.parse(terminalRow.step_result_json) as { stepStatus?: string };
          verdict = result.stepStatus === "completed" ? "passed" : "failed";
        } catch {
          // verdict stays null → conservative fallback below
        }
      }
    }
  }

  // Absent verdict: conservative stance — treat as failed (documented limitation)
  if (verdict === null) {
    verdict = "failed";
  }

  // 3. Load child run (OUTSIDE transaction — needed for templateId/Version in both paths)
  const childRun = getWorkflowRunById(db, childRunId);
  if (!childRun) throw new Error(`child run not found: ${childRunId}`);

  // 4. Verdict gate — non-passing verdict propagates failure to parent
  if (verdict !== "passed") {
    db.transaction(() => {
      updateCompositionStatus(db, compositionId, { status: "failed", finishedAt: now() });
      // Mark child run failed BEFORE setting parent to 'blocked' to avoid the
      // UNIQUE constraint: idx_workflow_runs_active_per_goal (goal_id WHERE status
      // IN ('active','paused','blocked')). Child must exit the constraint set first.
      db.prepare(`UPDATE workflow_runs SET status = 'failed', finished_at = ? WHERE id = ?`)
        .run(now(), childRunId);
      db.prepare(`UPDATE workflow_runs SET status = 'blocked', blocked_reason = 'child run failed' WHERE id = ?`)
        .run(parentRunId);
      db.prepare(`UPDATE goals SET active_workflow_run_id = ? WHERE id = ?`).run(parentRunId, goalId);

      // emit delegate_join (nested SAVEPOINT via better-sqlite3 transaction-in-transaction)
      emitDelegateJoin(
        { db, bus, now, idFactory },
        {
          goalId,
          workflowRunId: parentRunId,
          workflowStepRunId: null,
          composition: {
            childRunId,
            childTemplateId: childRun.templateId,
            childTemplateVersion: childRun.templateVersion,
            readsKeys: Object.keys(reads),
            writesKeys: Object.keys(writes),
            depth,
            costRollupUsd: null,
            childVerdict: verdict,
            childUntestedRegions,
            childResidualRisk,
            beliefDivergence: null,
            verifyResult: null,
          },
        }
      );
    })();

    return { parentRunId, outcome: "propagated_failure" };
  }

  // 5. Passed path — all mutations in one outer transaction
  let totalCostUsd: number | null = null;

  db.transaction(() => {
    // 5a. Map child outputs into parent namespace
    const childTerminalOutput = readChildTerminalStepOutput(db, childRunId, terminalStepRunId);
    const mappedWrites = mapWrites(writes, childTerminalOutput);

    // 5b. Create surrogate step run for the delegate node in the parent run.
    //     step_template_id = delegateNodeId so collectPriorStepArtifacts can find
    //     the writes artifact under the delegate node's identity.
    //     Use nextAttemptForStep so delegate re-entry (gate loop / backward edge)
    //     produces attempt=2, 3, … and never hits the UNIQUE fingerprint index.
    const surrogateStepRunId = idFactory();
    const timestamp = now();
    const surrogateAttempt = nextAttemptForStep(db, parentRunId, delegateNodeId);
    const fingerprint = stepFingerprint(parentRunId, delegateNodeId, surrogateAttempt);
    db.prepare(
      `INSERT INTO workflow_step_runs
         (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt,
          status, satisfied_exit_criteria_json, outstanding_exit_criteria_json,
          fingerprint, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, 'passed', '[]', '[]', ?, NULL, ?)`
    ).run(surrogateStepRunId, goalId, parentRunId, delegateNodeId, -1, surrogateAttempt, fingerprint, timestamp);

    // 5c. Writes artifact in parent namespace, attributed to the surrogate step run.
    //     (Nested SAVEPOINT via createArtifact's internal transaction.)
    createArtifact(
      db,
      now,
      {
        goalId,
        workflowRunId: parentRunId,
        stepRunId: surrogateStepRunId,
        type: "step_output",
        title: "delegate writes",
        body: JSON.stringify(mappedWrites),
        source: "orchestrator",
        linkedSessionId: null,
        linkedTaskId: null,
        linkedContextPackageId: null,
      },
      idFactory,
      []
    );

    // 5d. Belief-divergence detection — deferred (Task 9 concern).
    //     null = "not checked yet"; { diverged: false } would dishonestly claim the
    //     check ran and found no divergence. Keep null until Task 9 runs the check.
    const beliefDivergence = null;

    // 5e. Validation sensor veto — deferred (Task 9 concern)
    const verifyResult = { ran: false, vetoed: false };

    // 5f. Cost rollup: sum buildGoalCostRollup over all descendant run IDs.
    const runIds = descendantRunIds(db, childRunId);
    for (const runId of runIds) {
      const entry = buildGoalCostRollup(db, goalId, runId);
      if (entry !== null) {
        totalCostUsd = (totalCostUsd ?? 0) + entry.usd;
      }
    }

    // 5g. Mark child run completed (direct SQL; completeWorkflowRun resets goals.status)
    db.prepare(`UPDATE workflow_runs SET status = 'completed', finished_at = ? WHERE id = ?`)
      .run(now(), childRunId);

    // 5h. Mark composition completed
    updateCompositionStatus(db, compositionId, {
      status: "completed",
      costRollupUsd: totalCostUsd,
      finishedAt: now(),
    });

    // 5i. Restore parent run to active
    db.prepare(`UPDATE workflow_runs SET status = 'active' WHERE id = ?`).run(parentRunId);

    // 5j. Point the goal at the parent again
    db.prepare(`UPDATE goals SET active_workflow_run_id = ? WHERE id = ?`).run(parentRunId, goalId);

    // 5k. Advance the parent cursor past the delegate node.
    //     Best-effort: if graph is absent or cursor advance throws, log and continue.
    //     The parent is active; Task 9 must handle the resume.
    try {
      const parentRun = getWorkflowRunById(db, parentRunId);
      if (!parentRun) throw new Error("parent run not found after restoring active");

      const parentTemplate = loadRunTemplate(db, parentRun);
      if (!parentTemplate?.graph) {
        throw new Error("parent template has no graph; cursor advance deferred to Task 9");
      }

      const graph = effectiveGraph(parentTemplate.graph, parentTemplate.steps);
      const dest = resolveDelegateNext(graph, delegateNodeId);

      if (dest.kind === "step") {
        const toNode = graph.nodes.find((n) => n.id === dest.nodeId);
        const nextStepTemplateId =
          toNode?.type === "step" && toNode.stepId ? toNode.stepId : dest.nodeId;
        const stepDef = parentTemplate.steps.find((s) => s.id === nextStepTemplateId);
        const ordinal = stepDef?.ordinal ?? 0;
        const attempt = nextAttemptForStep(db, parentRunId, nextStepTemplateId);
        insertStepForRouting(db, now, goalId, parentRunId, nextStepTemplateId, ordinal, attempt, dest.nodeId);
      } else if (dest.kind === "gate") {
        db.prepare(
          `UPDATE workflow_runs SET current_step_run_id=NULL, current_node_id=?, current_node_kind='gate' WHERE id=?`
        ).run(dest.nodeId, parentRunId);
      } else if (dest.kind === "splitter") {
        db.prepare(
          `UPDATE workflow_runs SET current_step_run_id=NULL, current_node_id=?, current_node_kind='splitter' WHERE id=?`
        ).run(dest.nodeId, parentRunId);
      }
    } catch (err) {
      console.error("[joinChildRun] cursor advance failed — DONE_WITH_CONCERNS; Task 9 must handle resume", {
        parentRunId,
        delegateNodeId,
        err,
      });
    }

    // 5l. Emit delegate_join with full CompositionFacet (nested SAVEPOINT)
    emitDelegateJoin(
      { db, bus, now, idFactory },
      {
        goalId,
        workflowRunId: parentRunId,
        workflowStepRunId: null,
        composition: {
          childRunId,
          childTemplateId: childRun.templateId,
          childTemplateVersion: childRun.templateVersion,
          readsKeys: Object.keys(reads),
          writesKeys: Object.keys(writes),
          depth,
          costRollupUsd: totalCostUsd,
          childVerdict: "passed",
          childUntestedRegions,
          childResidualRisk,
          beliefDivergence,
          verifyResult,
        },
      }
    );
  })();

  return { parentRunId, outcome: "joined" };
}

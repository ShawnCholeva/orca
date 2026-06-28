import type { Database } from "better-sqlite3";

import type { StepResultScoringProposal } from "@orca/contracts";

import { ProviderRecoveryCheckpoint } from "@orca/contracts";

import { EventBus } from "../events.js";
import {
  openOrUpdateLive,
  pauseForConfirmation,
  pauseForProviderRecovery,
} from "../activities/store.js";
import { appendWorkflowEvent } from "./events.js";
import { summarizeScoring } from "./orchestrator/scoring-summary.js";

interface StaleLlmCallRow {
  id: string;
  goal_id: string;
  workflow_run_id: string | null;
  step_run_id: string | null;
}

interface DriftRunRow {
  run_id: string;
  goal_id: string;
}

export function reconcileWorkflowsOnBoot(db: Database, now: () => string): void {
  db.transaction(() => {
    const staleCalls = db
      .prepare(
        "SELECT id, goal_id, workflow_run_id, step_run_id FROM workflow_llm_calls WHERE status IN ('pending','running')"
      )
      .all() as StaleLlmCallRow[];

    for (const call of staleCalls) {
      db.prepare(
        "UPDATE workflow_llm_calls SET status='failed', failure_code='daemon_restart', failure_message='daemon restarted during LLM call' WHERE id=?"
      ).run(call.id);

      if (call.workflow_run_id) {
        db.prepare(
          "UPDATE workflow_runs SET status='blocked', blocked_reason='daemon_restart_during_llm_call' WHERE id=? AND status='active'"
        ).run(call.workflow_run_id);
      }

      appendWorkflowEvent(
        db,
        "workflow.run.blocked",
        {
          goalId: call.goal_id,
          workflowRunId: call.workflow_run_id,
          stepRunId: call.step_run_id,
          failureCode: "daemon_restart",
        },
        now()
      );
    }

    // A run parked at a splitter (current_step_run_id NULL, node kind 'splitter')
    // holding a pending_split_route_json is awaiting a supervised Continue or a
    // human routing choice — a valid paused state, not drift. Excluding it keeps
    // both the supervised-split park and the human-routing-choice park resumable.
    const driftRuns = db
      .prepare(
        "SELECT wr.id AS run_id, wr.goal_id AS goal_id FROM workflow_runs wr LEFT JOIN workflow_step_runs ws ON ws.id = wr.current_step_run_id WHERE wr.status = 'active' AND (wr.current_node_kind IS NULL OR wr.current_node_kind <> 'gate') AND wr.pending_split_route_json IS NULL AND (ws.id IS NULL OR ws.status IN ('passed','failed','skipped'))"
      )
      .all() as DriftRunRow[];

    for (const run of driftRuns) {
      db.prepare(
        "UPDATE workflow_runs SET status='blocked', blocked_reason='daemon_restart_state_drift' WHERE id=?"
      ).run(run.run_id);
      appendWorkflowEvent(
        db,
        "workflow.run.blocked",
        {
          goalId: run.goal_id,
          workflowRunId: run.run_id,
          failureCode: "daemon_restart_state_drift",
        },
        now()
      );
    }

    // A step stashed a revision (pending_revision_json) whose deferred delivery
    // did not survive the restart. The step is still active (so the drift clause
    // above misses it), and reconcile cannot reach the possibly-gone worker to
    // re-deliver. Block the run with a clear reason so the stalled step is
    // inspectable/resumable instead of silently active, and clear the stash so
    // it does not re-fire on the next boot.
    const pendingRevisions = db
      .prepare(
        `SELECT ws.id AS step_run_id, ws.workflow_run_id AS run_id, ws.goal_id AS goal_id
         FROM workflow_step_runs ws
         JOIN workflow_runs wr ON wr.id = ws.workflow_run_id
         WHERE ws.pending_revision_json IS NOT NULL AND ws.finished_at IS NULL AND wr.status = 'active'`
      )
      .all() as { step_run_id: string; run_id: string; goal_id: string }[];

    for (const pr of pendingRevisions) {
      db.prepare(
        "UPDATE workflow_step_runs SET pending_revision_json = NULL WHERE id = ?"
      ).run(pr.step_run_id);
      db.prepare(
        "UPDATE workflow_runs SET status='blocked', blocked_reason='revision_delivery_failed' WHERE id=? AND status='active'"
      ).run(pr.run_id);
      appendWorkflowEvent(
        db,
        "workflow.run.blocked",
        {
          goalId: pr.goal_id,
          workflowRunId: pr.run_id,
          stepRunId: pr.step_run_id,
          failureCode: "revision_delivery_failed",
        },
        now()
      );
    }
  })();

  // Re-assert supervised confirmation checkpoints for steps that were held
  // (stash present) but are still non-terminal — covers a crash after stashing
  // but before/while pausing the activity. Done outside the transaction above
  // because the activity-store helpers manage their own transactions.
  const held = db
    .prepare(
      `SELECT id AS step_run_id, workflow_run_id, goal_id, pending_completion_json AS stash
       FROM workflow_step_runs
       WHERE pending_completion_json IS NOT NULL AND finished_at IS NULL`
    )
    .all() as { step_run_id: string; workflow_run_id: string; goal_id: string; stash: string }[];

  if (held.length > 0) {
    const bus = new EventBus();
    for (const h of held) {
      let summary = "Step complete — review and Continue or send revisions.";
      try {
        const parsed = JSON.parse(h.stash) as { scoring: StepResultScoringProposal | null };
        summary = summarizeScoring(parsed.scoring ?? undefined);
      } catch {
        // keep the default summary
      }
      // After a restart there is no active worker row, so pauseForConfirmation
      // just (idempotently) inserts the confirmation gate row.
      pauseForConfirmation(
        { db, bus },
        {
          goalId: h.goal_id,
          workflowRunId: h.workflow_run_id,
          stepRunId: h.step_run_id,
          summary,
        }
      );
    }
  }

  // Re-assert provider-limit recovery checkpoints: a step paused for recovery
  // must surface its waiting card again on boot so the operator can act. The
  // worker reattach/missing decision is handled separately by resumeActiveRuns;
  // here we only ensure the activity exists in the paused recovery state.
  const recovering = db
    .prepare(
      `SELECT id AS step_run_id, workflow_run_id, goal_id,
              pending_provider_recovery_json AS recovery
       FROM workflow_step_runs
       WHERE pending_provider_recovery_json IS NOT NULL AND finished_at IS NULL`
    )
    .all() as {
    step_run_id: string;
    workflow_run_id: string;
    goal_id: string;
    recovery: string;
  }[];

  if (recovering.length > 0) {
    const bus = new EventBus();
    for (const r of recovering) {
      let checkpoint: ProviderRecoveryCheckpoint;
      try {
        checkpoint = ProviderRecoveryCheckpoint.parse(JSON.parse(r.recovery));
      } catch (err) {
        // Malformed/unparseable checkpoint must not crash boot. Clear only the
        // bad JSON and emit a bounded diagnostic.
        db.prepare(
          "UPDATE workflow_step_runs SET pending_provider_recovery_json = NULL WHERE id = ?"
        ).run(r.step_run_id);
        console.error(
          "[reconcile] dropped malformed provider recovery checkpoint",
          r.step_run_id,
          (err instanceof Error ? err.message : String(err)).slice(0, 256)
        );
        continue;
      }

      const summary = checkpoint.resetTimeText
        ? `${checkpoint.currentProviderName} reached its session limit. Available again at ${checkpoint.resetTimeText}.`
        : `${checkpoint.currentProviderName} reached its session limit. Reset time unavailable.`;
      // Recreate (or reuse) the live row tied to the preserved session, then
      // pause it for recovery. Idempotent on a re-run.
      openOrUpdateLive(
        { db, bus },
        {
          goalId: r.goal_id,
          workflowRunId: r.workflow_run_id,
          stepRunId: r.step_run_id,
          agentSessionId: checkpoint.currentSessionId,
          sourceKind: "step_started",
          currentText: summary,
          workCategory: null,
        }
      );
      pauseForProviderRecovery({ db, bus }, { stepRunId: r.step_run_id, summary });
    }
  }
}

import type { Database } from "better-sqlite3";

import { appendWorkflowEvent } from "./events.js";

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

    const driftRuns = db
      .prepare(
        "SELECT wr.id AS run_id, wr.goal_id AS goal_id FROM workflow_runs wr LEFT JOIN workflow_step_runs ws ON ws.id = wr.current_step_run_id WHERE wr.status = 'active' AND (ws.id IS NULL OR ws.status IN ('passed','failed','skipped'))"
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
  })();
}

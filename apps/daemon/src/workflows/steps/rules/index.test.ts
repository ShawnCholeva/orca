import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type { WorkflowArtifact } from "@orca/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../../config.js";
import { closeDatabase, openDatabase } from "../../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../../migrations.js";
import { createArtifact } from "../../artifacts/usecases.js";
import { resetWorkflowEventPreparedStatements } from "../../events.js";
import { stepRules, type StepRuleContext } from "./index.js";

const tempDirs: string[] = [];
const NOW = "2026-01-01T00:00:00.000Z";

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    getAuthToken: () => "test-token",
  };
}

function freshDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-step-rules-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function artifact(type: WorkflowArtifact["type"], body = "body"): WorkflowArtifact {
  return {
    id: `${type}-1`,
    goalId: "goal-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    type,
    title: type,
    body,
    source: "orchestrator",
    linkedSessionId: null,
    linkedTaskId: null,
    linkedContextPackageId: null,
    createdAt: NOW,
  };
}

function ctx(outstandingExitCriteria: string[], artifacts: WorkflowArtifact[] = []): StepRuleContext {
  return {
    goalId: "goal-1",
    workflowRunId: "run-1",
    stepRunId: "step-1",
    artifacts,
    satisfiedExitCriteria: [],
    outstandingExitCriteria,
  };
}

function seedGoal(db: Database.Database): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES ('goal-1', 'Goal', '', 'active', 1, ?, ?, NULL)"
  ).run(NOW, NOW);
}

function seedIssueBreakdownWorkflow(db: Database.Database): void {
  seedGoal(db);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', '', 1, 1, 1, '[]', '[]', ?, ?)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    `INSERT INTO workflow_step_runs
      (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status,
       satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason,
       started_at, finished_at, fingerprint)
     VALUES ('step-1', 'goal-1', 'run-1', 'issue_breakdown', 3, 1, 'active',
       '[]', ?, NULL, ?, NULL, 'fp-1')`
  ).run(
    JSON.stringify([
      "work split into clear tasks",
      "dependencies explicit",
      "first vertical slice reaches user/test-visible behavior where possible",
      "validation expectations exist",
      "suggested role or capabilities exist for each task",
    ]),
    NOW
  );
}

afterEach(() => {
  closeDatabase();
  resetWorkflowEventPreparedStatements();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Engineering step rules", () => {
  it("progresses intake questions and converts answers into bounded artifacts", () => {
    const rule = stepRules.intake!;
    const firstCtx = ctx([
      "goal brief captured",
      "constraints captured",
      "open questions captured",
      "success outcome captured",
      "relevant workspaces identified",
    ]);

    expect(rule.nextQuestion?.(firstCtx)?.question).toBe("What problem are we solving?");
    const first = rule.evaluateUserInputAsArtifact?.({
      answerText: "Need reliable workflow runs",
      ctx: firstCtx,
    });
    expect(first?.artifact).toMatchObject({
      type: "goal_brief",
      title: "Goal Brief (draft)",
    });
    expect(first?.satisfiedCriteria).toEqual(["goal brief captured"]);

    const secondCtx = {
      ...firstCtx,
      artifacts: [artifact("goal_brief", first?.artifact?.body ?? "")],
      satisfiedExitCriteria: ["goal brief captured"],
      outstandingExitCriteria: [
        "constraints captured",
        "open questions captured",
        "success outcome captured",
        "relevant workspaces identified",
      ],
    };
    expect(rule.nextQuestion?.(secondCtx)?.question).toBe(
      "What outcome should this optimize for?"
    );
    expect(
      rule.evaluateUserInputAsArtifact?.({
        answerText: "A completed proof loop",
        ctx: secondCtx,
      })?.artifact?.body
    ).toContain("## Success Outcome");
  });

  it("marks research, PRD, QA, Review, and Done artifacts against their criteria", () => {
    expect(
      stepRules.research?.evaluateArtifactSatisfies?.(
        artifact("research_summary"),
        ctx(["current implementation summarized", "unknowns captured"])
      )
    ).toEqual(["current implementation summarized", "unknowns captured"]);

    expect(
      stepRules.prd?.evaluateArtifactSatisfies?.(
        artifact("prd"),
        ctx(["acceptance criteria exist", "definition of done exists"])
      )
    ).toEqual(["acceptance criteria exist", "definition of done exists"]);

    expect(
      stepRules.qa?.evaluateArtifactSatisfies?.(
        artifact("qa_report"),
        ctx(["acceptance criteria checked", "bugs or gaps captured"])
      )
    ).toEqual(["acceptance criteria checked", "bugs or gaps captured"]);

    expect(
      stepRules.review?.evaluateArtifactSatisfies?.(
        artifact("review_report"),
        ctx(["test gaps assessed", "blocking issues identified or ruled out"])
      )
    ).toEqual(["test gaps assessed", "blocking issues identified or ruled out"]);

    expect(
      stepRules.done?.evaluateArtifactSatisfies?.(
        artifact("final_summary"),
        ctx(["final result summarized", "important decisions captured"])
      )
    ).toEqual(["final result summarized"]);
    expect(
      stepRules.done?.evaluateArtifactSatisfies?.(
        artifact("memory_update"),
        ctx(["important decisions captured"])
      )
    ).toEqual(["important decisions captured"]);
  });

  it("turns a QA answer into a QA report artifact", () => {
    const evaluated = stepRules.qa?.evaluateUserInputAsArtifact?.({
      answerText: "Acceptance checks passed. No rework required.",
      ctx: ctx(["acceptance criteria checked"]),
    });
    expect(evaluated?.artifact).toMatchObject({ type: "qa_report", title: "QA Report" });
    expect(evaluated?.satisfiedCriteria).toContain("acceptance criteria checked");
  });

  it("writes task DAG and satisfies issue-breakdown criteria when JSON artifact is created", () => {
    const db = freshDb();
    seedIssueBreakdownWorkflow(db);

    createArtifact(
      db,
      () => NOW,
      {
        goalId: "goal-1",
        workflowRunId: "run-1",
        stepRunId: "step-1",
        type: "issue_breakdown",
        title: "Issue Breakdown",
        body: JSON.stringify({
          tasks: [
            {
              title: "Implement vertical slice",
              description: "Build the smallest testable path",
              acceptanceCriteria: ["User-visible path works"],
              validationSteps: ["pnpm --filter @orca/daemon test workflows/steps/rules"],
              role: "engineer",
              dependencies: [],
            },
          ],
        }),
        source: "orchestrator",
      },
      () => "artifact-1"
    );

    const taskCount = db
      .prepare("SELECT COUNT(*) AS count FROM tasks WHERE workflow_step_run_id = 'step-1'")
      .get() as { count: number };
    expect(taskCount.count).toBe(1);

    const stepRow = db
      .prepare(
        "SELECT satisfied_exit_criteria_json, outstanding_exit_criteria_json FROM workflow_step_runs WHERE id = 'step-1'"
      )
      .get() as {
      satisfied_exit_criteria_json: string;
      outstanding_exit_criteria_json: string;
    };
    expect(JSON.parse(stepRow.outstanding_exit_criteria_json)).toEqual([]);
    expect(JSON.parse(stepRow.satisfied_exit_criteria_json)).toHaveLength(5);

    const eventTypes = db
      .prepare("SELECT type FROM events ORDER BY seq ASC")
      .all() as Array<{ type: string }>;
    expect(eventTypes.map((event) => event.type)).toEqual([
      "workflow.artifact.created",
      "workflow.task.dag.created",
    ]);
  });

  it("satisfies execution criteria from bounded session-summary projection text", () => {
    const satisfied = stepRules.execution?.evaluateSessionSummarySatisfies?.(
      {
        sessionId: "session-1",
        sessionStatus: "exited",
        headline: "Implementation completed",
        summaryText:
          "Changed files are summarized. Typecheck and tests passed. No failures.",
      },
      ctx([
        "assigned task completed or blocked with reason",
        "changed files summarized when applicable",
        "validation run or skipped with reason",
        "failures captured",
      ])
    );

    expect(satisfied).toEqual([
      "assigned task completed or blocked with reason",
      "changed files summarized when applicable",
      "validation run or skipped with reason",
      "failures captured",
    ]);
  });
});

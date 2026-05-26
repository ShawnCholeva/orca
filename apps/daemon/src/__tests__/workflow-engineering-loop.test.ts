import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcceptRecommendationResponse,
  CreateGoalResponse,
  CreateSessionResponse,
  ListWorkflowArtifactsResponse,
  ListWorkflowDecisionsResponse,
  NextOrchestratorDecisionResponse,
  WorkflowRunResponse,
} from "@orca/contracts";

import { closeDatabase } from "../db.js";
import { getLatestSummaryForSession } from "../extractions/projection.js";
import { bootDaemonForTest, type BootedDaemonForTest } from "./helpers/boot.js";

const AUTH_HEADERS = { authorization: "Bearer test-token" } as const;
const FORBIDDEN_EVENT_KEYS = new Set([
  "prompt",
  "response",
  "reasoning",
  "artifactBody",
  "summaryText",
  "terminalOutput",
  "decisionText",
  "rationale",
  "proposedAction",
]);
const FORBIDDEN_LLM_COLUMNS = new Set([
  "prompt",
  "response",
  "system_prompt",
  "user_prompt",
  "request_json",
  "response_json",
  "raw_request",
  "raw_response",
]);

const tempDirs: string[] = [];

function mktemp(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return realpathSync(dir);
}

function walkPayload(value: unknown, visit: (key: string) => void): void {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    visit(key);
    walkPayload(nested, visit);
  }
}

function latestRecommendation(
  db: Database.Database,
  goalId: string,
  type: string
): { id: string; type: string; workflow_step_run_id: string | null; proposed_action_json: string } {
  const row = db
    .prepare(
      `SELECT id, type, workflow_step_run_id, proposed_action_json
         FROM recommendations
        WHERE goal_id = ? AND type = ? AND status = 'proposed'
        ORDER BY created_at DESC, id DESC
        LIMIT 1`
    )
    .get(goalId, type) as
    | {
        id: string;
        type: string;
        workflow_step_run_id: string | null;
        proposed_action_json: string;
      }
    | undefined;
  expect(row, `missing proposed recommendation of type ${type}`).toBeDefined();
  return row!;
}

function currentWorkspaceId(db: Database.Database, goalId: string): string {
  const row = db
    .prepare("SELECT id FROM workspaces WHERE goal_id = ? ORDER BY attached_at ASC LIMIT 1")
    .get(goalId) as { id: string } | undefined;
  expect(row).toBeDefined();
  return row!.id;
}

function readRunStatus(
  db: Database.Database,
  runId: string
): { status: string; current_step_run_id: string | null } {
  return db
    .prepare("SELECT status, current_step_run_id FROM workflow_runs WHERE id = ?")
    .get(runId) as { status: string; current_step_run_id: string | null };
}

function insertExitedSummary(
  db: Database.Database,
  args: {
    goalId: string;
    sessionId: string;
    stepRunId: string;
    headline: string;
    summaryText: string;
    now: string;
  }
): void {
  const extractionId = `extract-${args.sessionId}`;
  const summaryId = `summary-${args.sessionId}`;
  db.prepare(
    "UPDATE sessions SET workflow_step_run_id = ?, status = 'exited', started_at = ?, exited_at = ? WHERE id = ?"
  ).run(args.stepRunId, args.now, args.now, args.sessionId);
  db.prepare(
    `INSERT INTO memory_extractions (
       id, goal_id, session_id, trigger, status, extractor_version, source_fingerprint,
       source_offset_first, source_offset_last, summary_id, item_count, decision_count,
       promoted_count, requested_at, started_at, finished_at
     ) VALUES (?, ?, ?, 'terminal_state', 'succeeded', 'test-extractor', ?, 0, 512, ?, 0, 0, 0, ?, ?, ?)`
  ).run(extractionId, args.goalId, args.sessionId, `fp-${args.sessionId}`, summaryId, args.now, args.now, args.now);
  db.prepare(
    `INSERT INTO session_summaries (
       id, session_id, goal_id, extraction_id, headline, summary_text,
       truncated, source_offset_first, source_offset_last, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 512, ?)`
  ).run(
    summaryId,
    args.sessionId,
    args.goalId,
    extractionId,
    args.headline,
    args.summaryText,
    args.now
  );
}

async function postJson(
  daemon: BootedDaemonForTest,
  args: { method: "POST" | "PATCH"; url: string; payload?: unknown; expectedStatus: number }
): Promise<unknown> {
  const request = {
    method: args.method,
    url: args.url,
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
  };
  const response =
    args.payload === undefined
      ? await daemon.server.inject(request)
      : await daemon.server.inject({
          ...request,
          payload: JSON.stringify(args.payload),
        });
  expect(response.statusCode, response.body).toBe(args.expectedStatus);
  return JSON.parse(response.body) as unknown;
}

async function getJson(
  daemon: BootedDaemonForTest,
  url: string,
  expectedStatus = 200
): Promise<unknown> {
  const response = await daemon.server.inject({
    method: "GET",
    url,
    headers: AUTH_HEADERS,
  });
  expect(response.statusCode, response.body).toBe(expectedStatus);
  return JSON.parse(response.body) as unknown;
}

async function acceptRecommendation(
  daemon: BootedDaemonForTest,
  recommendationId: string
): Promise<void> {
  AcceptRecommendationResponse.parse(
    await postJson(daemon, {
      method: "POST",
      url: `/v1/recommendations/${recommendationId}/accept`,
      payload: {},
      expectedStatus: 200,
    })
  );
}

async function requestNextDecision(
  daemon: BootedDaemonForTest,
  goalId: string,
  runId: string
): Promise<void> {
  NextOrchestratorDecisionResponse.parse(
    await postJson(daemon, {
      method: "POST",
      url: `/v1/goals/${goalId}/workflow-runs/${runId}/next-decision`,
      payload: { workflowRunId: runId },
      expectedStatus: 200,
    })
  );
}

async function createSessionWithSummary(
  daemon: BootedDaemonForTest,
  args: {
    goalId: string;
    workspaceId: string;
    stepRunId: string;
    adapterId: string;
    fromRecommendationId: string;
    title: string;
    headline: string;
    summaryText: string;
    now: string;
  }
): Promise<string> {
  const body = CreateSessionResponse.parse(
    await postJson(daemon, {
      method: "POST",
      url: `/v1/goals/${args.goalId}/sessions`,
      payload: {
        workspaceId: args.workspaceId,
        adapterId: args.adapterId,
        fromRecommendationId: args.fromRecommendationId,
        workflowStepRunId: args.stepRunId,
        title: args.title,
      },
      expectedStatus: 201,
    })
  );
  insertExitedSummary(daemon.db, {
    goalId: args.goalId,
    sessionId: body.session.id,
    stepRunId: args.stepRunId,
    headline: args.headline,
    summaryText: args.summaryText,
    now: args.now,
  });
  return body.session.id;
}

describe.sequential("M8 Engineering workflow end-to-end", () => {
  let daemon: BootedDaemonForTest | null = null;

  afterEach(async () => {
    if (daemon) {
      await daemon.close();
      daemon = null;
    }
    closeDatabase();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("happy-path Engineering loop runs end-to-end", async () => {
    const workspaceDir = mktemp("orca-m8-workspace-");
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 4, 25, 14, 0, tick++)).toISOString();
    let nextId = 0;

    daemon = await bootDaemonForTest({
      dataDir: mktemp("orca-m8-daemon-"),
      now,
      idFactory: () => `m8-e2e-${++nextId}`,
    });

    const createdGoal = CreateGoalResponse.parse(
      await postJson(daemon, {
        method: "POST",
        url: "/v1/goals",
        payload: {
          title: "M8 workflow proof loop",
          description: "Drive the built-in engineering workflow to completion.",
          workspaces: [{ inputPath: workspaceDir }],
          orchestratorModel: {
            providerId: "orca/anthropic",
            modelId: "claude-sonnet-4-6",
          },
        },
        expectedStatus: 201,
      })
    ).goal;
    expect(createdGoal.orchestratorProvider).toBe("orca/anthropic");
    expect(createdGoal.orchestratorModel).toBe("claude-sonnet-4-6");

    const goalId = createdGoal.id;
    const workspaceId = currentWorkspaceId(daemon.db, goalId);

    const startedRun = WorkflowRunResponse.parse(
      await postJson(daemon, {
        method: "POST",
        url: `/v1/goals/${goalId}/workflow-runs`,
        payload: { goalId, templateId: "orca/engineering" },
        expectedStatus: 201,
      })
    ).run;
    const runId = startedRun.id;
    expect(startedRun.status).toBe("active");
    expect(startedRun.currentStepRunId).toBeTruthy();
    const intakeStepRunId = startedRun.currentStepRunId!;

    await requestNextDecision(daemon, goalId, runId);
    let requestInputRec = latestRecommendation(daemon.db, goalId, "request_user_input");
    expect(JSON.parse(requestInputRec.proposed_action_json)).toMatchObject({
      kind: "request_user_input",
      question: "What problem are we solving?",
    });

    const intakeAnswers = [
      "Implement the bounded Milestone 8 workflow proof loop test without expanding scope.",
      "Optimize for deterministic proof-loop coverage and restart safety.",
      "Keep the implementation local-first, suggestion-only, and content-free in events.",
      `Only the workspace at ${workspaceDir} is relevant.`,
      "Flag whether workflow session linkage should later move fully through the session route.",
    ];

    for (let index = 0; index < intakeAnswers.length; index += 1) {
      await postJson(daemon, {
        method: "POST",
        url: `/v1/goals/${goalId}/workflow-step-runs/${intakeStepRunId}/submit-input`,
        payload: {
          stepRunId: intakeStepRunId,
          answerText: intakeAnswers[index],
        },
        expectedStatus: 200,
      });
      if (index < intakeAnswers.length - 1) {
        requestInputRec = latestRecommendation(daemon.db, goalId, "request_user_input");
      }
    }

    const advanceFromIntake = latestRecommendation(daemon.db, goalId, "advance_workflow_step");
    await acceptRecommendation(daemon, advanceFromIntake.id);

    let run = WorkflowRunResponse.parse(
      await getJson(daemon, `/v1/goals/${goalId}/workflow-runs/${runId}`)
    ).run;
    expect(run.currentStepRunId).toBeTruthy();
    const researchStepRunId = run.currentStepRunId!;

    await requestNextDecision(daemon, goalId, runId);
    const researchLaunch = latestRecommendation(daemon.db, goalId, "launch_workflow_session");
    await acceptRecommendation(daemon, researchLaunch.id);
    const researchSessionId = await createSessionWithSummary(daemon, {
      goalId,
      workspaceId,
      stepRunId: researchStepRunId,
      adapterId: "claude-code",
      fromRecommendationId: researchLaunch.id,
      title: "Research session",
      headline: "Research completed",
      summaryText: "Completed research. Changed files none. Validation skipped with reason. No failures.",
      now: now(),
    });
    await postJson(daemon, {
      method: "POST",
      url: `/v1/goals/${goalId}/workflow-artifacts`,
      payload: {
        workflowRunId: runId,
        stepRunId: researchStepRunId,
        type: "research_summary",
        title: "Research Summary",
        body: "Identified workflow daemon files, existing M8 routes, restart risks, and test seams.",
        source: "agent",
        linkedSessionId: researchSessionId,
      },
      expectedStatus: 201,
    });
    await requestNextDecision(daemon, goalId, runId);
    await acceptRecommendation(daemon, latestRecommendation(daemon.db, goalId, "advance_workflow_step").id);

    const statusBeforeRestart = readRunStatus(daemon.db, runId);
    expect(statusBeforeRestart.status).toBe("active");
    await daemon.restart();
    const statusAfterRestart = readRunStatus(daemon.db, runId);
    expect(statusAfterRestart).toEqual(statusBeforeRestart);

    run = WorkflowRunResponse.parse(
      await getJson(daemon, `/v1/goals/${goalId}/workflow-runs/${runId}`)
    ).run;
    const prdStepRunId = run.currentStepRunId!;
    await postJson(daemon, {
      method: "POST",
      url: `/v1/goals/${goalId}/workflow-artifacts`,
      payload: {
        workflowRunId: runId,
        stepRunId: prdStepRunId,
        type: "prd",
        title: "PRD",
        body: [
          "Problem: prove the Engineering workflow loop end-to-end.",
          "Solution: add one integration test with restart coverage.",
          "Acceptance criteria: run completes and restart survives.",
          "Non-goals: no architecture changes.",
          "Implementation decisions: reuse HTTP routes and direct DB summary seeding.",
          "Definition of done: gate note recorded after full-suite validation.",
        ].join("\n"),
        source: "user",
      },
      expectedStatus: 201,
    });
    await requestNextDecision(daemon, goalId, runId);
    await acceptRecommendation(daemon, latestRecommendation(daemon.db, goalId, "advance_workflow_step").id);

    run = WorkflowRunResponse.parse(
      await getJson(daemon, `/v1/goals/${goalId}/workflow-runs/${runId}`)
    ).run;
    const issueBreakdownStepRunId = run.currentStepRunId!;
    await postJson(daemon, {
      method: "POST",
      url: `/v1/goals/${goalId}/workflow-artifacts`,
      payload: {
        workflowRunId: runId,
        stepRunId: issueBreakdownStepRunId,
        type: "issue_breakdown",
        title: "Issue Breakdown",
        body: JSON.stringify({
          tasks: [
            {
              title: "Add M8 workflow loop test helper",
              description: "Boot a test daemon with fake model providers and restart support.",
              acceptanceCriteria: ["Helper boots and restarts a test daemon deterministically."],
              validationSteps: ["pnpm --filter @orca/daemon test workflow-engineering-loop"],
              role: "engineer",
              dependencies: [],
            },
            {
              title: "Add end-to-end engineering workflow test",
              description: "Drive the eight-step Engineering template to completion.",
              acceptanceCriteria: ["Workflow run completes after restart and persists decisions, artifacts, and tasks."],
              validationSteps: ["pnpm -r typecheck", "pnpm -r test"],
              role: "engineer",
              dependencies: [],
            },
          ],
        }),
        source: "user",
      },
      expectedStatus: 201,
    });
    await requestNextDecision(daemon, goalId, runId);
    await acceptRecommendation(daemon, latestRecommendation(daemon.db, goalId, "advance_workflow_step").id);

    run = WorkflowRunResponse.parse(
      await getJson(daemon, `/v1/goals/${goalId}/workflow-runs/${runId}`)
    ).run;
    const executionStepRunId = run.currentStepRunId!;
    await requestNextDecision(daemon, goalId, runId);
    const executionLaunch = latestRecommendation(daemon.db, goalId, "launch_workflow_session");
    await acceptRecommendation(daemon, executionLaunch.id);
    const executionSessionId = await createSessionWithSummary(daemon, {
      goalId,
      workspaceId,
      stepRunId: executionStepRunId,
      adapterId: "codex",
      fromRecommendationId: executionLaunch.id,
      title: "Execution session",
      headline: "Implementation completed",
      summaryText: "Completed implementation. Changed files summarized. Typecheck and tests run. No failures.",
      now: now(),
    });
    await postJson(daemon, {
      method: "POST",
      url: `/v1/goals/${goalId}/workflow-artifacts`,
      payload: {
        workflowRunId: runId,
        stepRunId: executionStepRunId,
        type: "implementation_result",
        title: "Implementation Result",
        body: "Added the workflow-loop helper, end-to-end test, gate note, and plan update.",
        source: "agent",
        linkedSessionId: executionSessionId,
      },
      expectedStatus: 201,
    });
    await postJson(daemon, {
      method: "POST",
      url: `/v1/goals/${goalId}/workflow-artifacts`,
      payload: {
        workflowRunId: runId,
        stepRunId: executionStepRunId,
        type: "test_report",
        title: "Test Report",
        body: "Ran focused daemon test, typecheck, and full test suite.",
        source: "agent",
        linkedSessionId: executionSessionId,
      },
      expectedStatus: 201,
    });
    await requestNextDecision(daemon, goalId, runId);
    await acceptRecommendation(daemon, latestRecommendation(daemon.db, goalId, "advance_workflow_step").id);

    run = WorkflowRunResponse.parse(
      await getJson(daemon, `/v1/goals/${goalId}/workflow-runs/${runId}`)
    ).run;
    const qaStepRunId = run.currentStepRunId!;
    await requestNextDecision(daemon, goalId, runId);
    await postJson(daemon, {
      method: "POST",
      url: `/v1/goals/${goalId}/workflow-step-runs/${qaStepRunId}/submit-input`,
      payload: {
        stepRunId: qaStepRunId,
        answerText:
          "Acceptance criteria checked. Passing items recorded. No bugs or gaps found. No rework required.",
      },
      expectedStatus: 200,
    });
    await acceptRecommendation(daemon, latestRecommendation(daemon.db, goalId, "advance_workflow_step").id);

    run = WorkflowRunResponse.parse(
      await getJson(daemon, `/v1/goals/${goalId}/workflow-runs/${runId}`)
    ).run;
    const reviewStepRunId = run.currentStepRunId!;
    await requestNextDecision(daemon, goalId, runId);
    const reviewLaunch = latestRecommendation(daemon.db, goalId, "launch_workflow_session");
    await acceptRecommendation(daemon, reviewLaunch.id);
    const reviewSessionId = await createSessionWithSummary(daemon, {
      goalId,
      workspaceId,
      stepRunId: reviewStepRunId,
      adapterId: "claude-code",
      fromRecommendationId: reviewLaunch.id,
      title: "Review session",
      headline: "Review completed",
      summaryText: "Completed review. Architecture stable. Test gaps assessed. No blocking issues.",
      now: now(),
    });
    await postJson(daemon, {
      method: "POST",
      url: `/v1/goals/${goalId}/workflow-artifacts`,
      payload: {
        workflowRunId: runId,
        stepRunId: reviewStepRunId,
        type: "review_report",
        title: "Review Report",
        body: "Architecture drift assessed. Test gaps assessed. Maintainability risks low. No blockers.",
        source: "agent",
        linkedSessionId: reviewSessionId,
      },
      expectedStatus: 201,
    });
    await requestNextDecision(daemon, goalId, runId);
    await acceptRecommendation(daemon, latestRecommendation(daemon.db, goalId, "advance_workflow_step").id);

    run = WorkflowRunResponse.parse(
      await getJson(daemon, `/v1/goals/${goalId}/workflow-runs/${runId}`)
    ).run;
    const doneStepRunId = run.currentStepRunId!;
    await postJson(daemon, {
      method: "POST",
      url: `/v1/goals/${goalId}/workflow-artifacts`,
      payload: {
        workflowRunId: runId,
        stepRunId: doneStepRunId,
        type: "final_summary",
        title: "Final Summary",
        body: "Workflow proof loop implemented, validated, and ready for the documentation pass.",
        source: "user",
      },
      expectedStatus: 201,
    });
    await postJson(daemon, {
      method: "POST",
      url: `/v1/goals/${goalId}/workflow-artifacts`,
      payload: {
        workflowRunId: runId,
        stepRunId: doneStepRunId,
        type: "memory_update",
        title: "Memory Update",
        body: "Capture that workflow proof-loop testing relies on fake providers and persisted summaries.",
        source: "user",
      },
      expectedStatus: 201,
    });
    await requestNextDecision(daemon, goalId, runId);
    await acceptRecommendation(daemon, latestRecommendation(daemon.db, goalId, "complete_workflow_run").id);

    const completedRun = WorkflowRunResponse.parse(
      await getJson(daemon, `/v1/goals/${goalId}/workflow-runs/${runId}`)
    ).run;
    expect(completedRun.status).toBe("completed");
    expect(completedRun.currentStepRunId).toBeNull();

    const stepRuns = daemon.db
      .prepare(
        `SELECT step_template_id, status
           FROM workflow_step_runs
          WHERE workflow_run_id = ?
          ORDER BY ordinal ASC`
      )
      .all(runId) as Array<{ step_template_id: string; status: string }>;
    expect(stepRuns).toHaveLength(8);
    expect(stepRuns.map((row) => row.status)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
    ]);

    const artifactTypes = new Set(
      ListWorkflowArtifactsResponse.parse(
        await getJson(daemon, `/v1/goals/${goalId}/workflow-runs/${runId}/artifacts`)
      ).artifacts.map((artifact) => artifact.type)
    );
    expect(artifactTypes).toEqual(
      new Set([
        "goal_brief",
        "open_questions",
        "research_summary",
        "prd",
        "issue_breakdown",
        "implementation_result",
        "test_report",
        "qa_report",
        "review_report",
        "final_summary",
        "memory_update",
      ])
    );

    const decisions = ListWorkflowDecisionsResponse.parse(
      await getJson(daemon, `/v1/goals/${goalId}/workflow-runs/${runId}/decisions`)
    ).decisions;
    expect(decisions.length).toBeGreaterThanOrEqual(10);

    const workflowLlmCalls = daemon.db
      .prepare(
        "SELECT provider_id, model, status, usage_tokens_input, usage_tokens_output, latency_ms FROM workflow_llm_calls ORDER BY created_at ASC, id ASC"
      )
      .all() as Array<{
      provider_id: string;
      model: string;
      status: string;
      usage_tokens_input: number | null;
      usage_tokens_output: number | null;
      latency_ms: number | null;
    }>;
    if (workflowLlmCalls.length > 0) {
      expect(workflowLlmCalls.length).toBeGreaterThanOrEqual(3);
      expect(workflowLlmCalls.every((row) => row.status === "succeeded")).toBe(true);
      expect(workflowLlmCalls.every((row) => row.provider_id === "orca/anthropic")).toBe(true);
    } else {
      const operatorSelectedEvents = daemon.db
        .prepare(
          "SELECT payload FROM events WHERE goal_id = ? AND type = 'workflow.operator.selected' ORDER BY seq ASC"
        )
        .all(goalId) as Array<{ payload: string }>;
      expect(operatorSelectedEvents.length).toBeGreaterThanOrEqual(3);
      expect(
        operatorSelectedEvents.every((event) => {
          const payload = JSON.parse(event.payload) as { source?: string };
          return payload.source === "fallback";
        })
      ).toBe(true);
    }

    const llmColumns = (
      daemon.db.prepare("PRAGMA table_info(workflow_llm_calls)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const forbidden of FORBIDDEN_LLM_COLUMNS) {
      expect(llmColumns).not.toContain(forbidden);
    }

    const linkedTasks = daemon.db
      .prepare(
        `SELECT origin, status, workflow_step_run_id
           FROM tasks
          WHERE goal_id = ?
          ORDER BY created_at ASC`
      )
      .all(goalId) as Array<{
      origin: string;
      status: string;
      workflow_step_run_id: string | null;
    }>;
    expect(linkedTasks).toHaveLength(2);
    expect(linkedTasks.every((task) => task.origin === "generator")).toBe(true);
    expect(linkedTasks.every((task) => task.workflow_step_run_id === issueBreakdownStepRunId)).toBe(true);

    const sessionRows = daemon.db
      .prepare(
        `SELECT id, workflow_step_run_id
           FROM sessions
          WHERE goal_id = ?
          ORDER BY created_at ASC`
      )
      .all(goalId) as Array<{ id: string; workflow_step_run_id: string | null }>;
    expect(sessionRows).toHaveLength(3);
    for (const session of sessionRows) {
      expect(session.workflow_step_run_id).toBeTruthy();
      expect(getLatestSummaryForSession(daemon.db, session.id)?.headline).toBeTruthy();
    }

    const workflowEvents = daemon.db
      .prepare(
        `SELECT type, payload
           FROM events
          WHERE goal_id = ? AND type LIKE 'workflow.%'
          ORDER BY seq ASC`
      )
      .all(goalId) as Array<{ type: string; payload: string }>;
    const eventTypes = new Set(workflowEvents.map((event) => event.type));
    for (const requiredType of [
      "workflow.run.started",
      "workflow.step.started",
      "workflow.decision.requested",
      "workflow.decision.recorded",
      "workflow.recommendation.created",
      "workflow.user.input.requested",
      "workflow.user.input.submitted",
      "workflow.artifact.created",
      "workflow.guardrail.evaluated",
      "workflow.operator.selected",
      "workflow.recommendation.accepted",
      "workflow.task.dag.created",
      "workflow.step.completed",
      "workflow.run.completed",
    ]) {
      expect(eventTypes.has(requiredType), `missing workflow event ${requiredType}`).toBe(true);
    }

    for (const event of workflowEvents) {
      const bytes = Buffer.byteLength(event.payload, "utf8");
      expect(bytes).toBeLessThanOrEqual(4096);
      const parsed = JSON.parse(event.payload) as Record<string, unknown>;
      walkPayload(parsed, (key) => {
        expect(FORBIDDEN_EVENT_KEYS.has(key)).toBe(false);
      });
    }
  });
});

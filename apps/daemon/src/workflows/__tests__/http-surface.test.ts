import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  CreateGoalResponse,
  GetOrchestrationWorkerResponse,
  GetWorkflowTemplateResponse,
  ListOrchestrationAttemptsResponse,
  ListOrchestrationWorkersResponse,
  ListModelProvidersResponse,
  ListOperatorsResponse,
  ListWorkflowArtifactsResponse,
  ListWorkflowRunsResponse,
  ListWorkflowTemplatesResponse,
  UpdateGoalOrchestratorModelResponse,
  WorkflowArtifactResponse,
  WorkflowRunResponse,
  WorkflowStepRunResponse,
  WorkflowTemplateResponse,
} from "@orca/contracts";

import type { Config } from "../../config.js";
import { closeDatabase, openDatabase } from "../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import { bootstrapRegistries } from "../../registry/bootstrap.js";
import { createServer } from "../../server.js";

const tempDirs: string[] = [];
const AUTH_HEADERS = { authorization: "Bearer test-token" } as const;

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

beforeAll(() => {
  bootstrapRegistries();
});

describe("M8 HTTP surface", () => {
  let server: FastifyInstance;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-m8-http-surface-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    server = createServer(config);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mounts all M8 routes with expected 200/400/404 patterns", async () => {
    const goalResp = await server.inject({
      method: "POST",
      url: "/v1/goals",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: { title: "m8-http-goal", description: "route test" },
    });
    expect(goalResp.statusCode).toBe(201);
    const goal = CreateGoalResponse.parse(JSON.parse(goalResp.body)).goal;

    const providersResp = await server.inject({
      method: "GET",
      url: "/v1/model-providers",
      headers: AUTH_HEADERS,
    });
    expect(providersResp.statusCode).toBe(200);
    ListModelProvidersResponse.parse(JSON.parse(providersResp.body));

    const updateModelResp = await server.inject({
      method: "PATCH",
      url: `/v1/goals/${goal.id}/orchestrator-model`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: { providerId: "orca/openai", modelId: "gpt-5" },
    });
    expect(updateModelResp.statusCode).toBe(200);
    UpdateGoalOrchestratorModelResponse.parse(JSON.parse(updateModelResp.body));

    const operatorsMissingGoalResp = await server.inject({
      method: "GET",
      url: "/v1/operators",
      headers: AUTH_HEADERS,
    });
    expect(operatorsMissingGoalResp.statusCode).toBe(400);

    const operatorsMissingResp = await server.inject({
      method: "GET",
      url: "/v1/operators?goalId=goal-does-not-exist",
      headers: AUTH_HEADERS,
    });
    expect(operatorsMissingResp.statusCode).toBe(404);

    const operatorsResp = await server.inject({
      method: "GET",
      url: `/v1/operators?goalId=${goal.id}`,
      headers: AUTH_HEADERS,
    });
    expect(operatorsResp.statusCode).toBe(200);
    ListOperatorsResponse.parse(JSON.parse(operatorsResp.body));

    const createTemplateResp = await server.inject({
      method: "POST",
      url: "/v1/workflow-templates",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        name: "HTTP Surface Template",
        description: "Used for M8 route verification",
        steps: [
          {
            id: "intake",
            name: "Intake",
            instructions: "Capture a brief from the user.",
            outputSchema: [{ key: "goal_brief", type: "string", required: true }],
          },
        ],
        guardrails: [],
      },
    });
    expect(createTemplateResp.statusCode).toBe(201);
    const createdTemplate = WorkflowTemplateResponse.parse(
      JSON.parse(createTemplateResp.body)
    ).template;

    const listTemplatesResp = await server.inject({
      method: "GET",
      url: "/v1/workflow-templates",
      headers: AUTH_HEADERS,
    });
    expect(listTemplatesResp.statusCode).toBe(200);
    ListWorkflowTemplatesResponse.parse(JSON.parse(listTemplatesResp.body));

    const getTemplateResp = await server.inject({
      method: "GET",
      url: `/v1/workflow-templates/${encodeURIComponent(createdTemplate.id)}`,
      headers: AUTH_HEADERS,
    });
    expect(getTemplateResp.statusCode).toBe(200);
    GetWorkflowTemplateResponse.parse(JSON.parse(getTemplateResp.body));

    const patchTemplateResp = await server.inject({
      method: "PATCH",
      url: `/v1/workflow-templates/${encodeURIComponent(createdTemplate.id)}`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        name: "HTTP Surface Template v2",
        description: "Updated",
        steps: [
          {
            id: "intake",
            ordinal: 0,
            name: "Intake",
            instructions: "Capture a brief from the user.",
            outputSchema: [{ key: "goal_brief", type: "string", required: true }],
          },
        ],
        guardrails: [],
      },
    });
    expect(patchTemplateResp.statusCode).toBe(200);
    WorkflowTemplateResponse.parse(JSON.parse(patchTemplateResp.body));

    const duplicateTemplateResp = await server.inject({
      method: "POST",
      url: `/v1/workflow-templates/${encodeURIComponent(createdTemplate.id)}/duplicate`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: { sourceTemplateId: createdTemplate.id, name: "HTTP Surface Copy" },
    });
    expect(duplicateTemplateResp.statusCode).toBe(201);
    WorkflowTemplateResponse.parse(JSON.parse(duplicateTemplateResp.body));

    const startRunResp = await server.inject({
      method: "POST",
      url: `/v1/goals/${goal.id}/workflow-runs`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: { goalId: goal.id, templateId: createdTemplate.id },
    });
    expect(startRunResp.statusCode).toBe(201);
    const startedRun = WorkflowRunResponse.parse(JSON.parse(startRunResp.body)).run;
    expect(startedRun.currentStepRunId).toBeTruthy();
    const stepRunId = startedRun.currentStepRunId as string;

    const listRunsResp = await server.inject({
      method: "GET",
      url: `/v1/goals/${goal.id}/workflow-runs`,
      headers: AUTH_HEADERS,
    });
    expect(listRunsResp.statusCode).toBe(200);
    ListWorkflowRunsResponse.parse(JSON.parse(listRunsResp.body));

    const getRunResp = await server.inject({
      method: "GET",
      url: `/v1/goals/${goal.id}/workflow-runs/${startedRun.id}`,
      headers: AUTH_HEADERS,
    });
    expect(getRunResp.statusCode).toBe(200);
    WorkflowRunResponse.parse(JSON.parse(getRunResp.body));

    const wrongGoalRunResp = await server.inject({
      method: "GET",
      url: `/v1/goals/goal-wrong/workflow-runs/${startedRun.id}`,
      headers: AUTH_HEADERS,
    });
    expect(wrongGoalRunResp.statusCode).toBe(404);

    // NOTE: The live next-decision skill loop (and the decision-list / get-decision /
    // submit-input flow that depends on a produced decision) is exercised by
    // service.skill-step.test.ts, decisions/routes.test.ts, and steps/routes.skill-input.test.ts.
    // Driving it here over HTTP would require stubbing the broker + selector + operator
    // registry through createServer (no injection seam), so this route-mounting test only
    // verifies mounting/scoping for the routes it can drive without a live model turn.

    const getStepRunResp = await server.inject({
      method: "GET",
      url: `/v1/goals/${goal.id}/workflow-step-runs/${stepRunId}`,
      headers: AUTH_HEADERS,
    });
    expect(getStepRunResp.statusCode).toBe(200);
    WorkflowStepRunResponse.parse(JSON.parse(getStepRunResp.body));

    const wrongGoalStepRunResp = await server.inject({
      method: "GET",
      url: `/v1/goals/goal-wrong/workflow-step-runs/${stepRunId}`,
      headers: AUTH_HEADERS,
    });
    expect(wrongGoalStepRunResp.statusCode).toBe(404);

    const submitInputValidationResp = await server.inject({
      method: "POST",
      url: `/v1/goals/${goal.id}/workflow-step-runs/${stepRunId}/submit-input`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: { stepRunId: "not-matching-route" },
    });
    expect(submitInputValidationResp.statusCode).toBe(400);

    // The successful submit-input flow (which requires an active question decision produced
    // by the skill loop) is covered by steps/routes.skill-input.test.ts.

    const createArtifactResp = await server.inject({
      method: "POST",
      url: `/v1/goals/${goal.id}/workflow-artifacts`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        workflowRunId: startedRun.id,
        stepRunId,
        type: "open_questions",
        title: "Open Questions",
        body: "Question list",
        source: "user",
      },
    });
    expect(createArtifactResp.statusCode).toBe(201);
    const createdArtifact = WorkflowArtifactResponse.parse(
      JSON.parse(createArtifactResp.body)
    ).artifact;

    const runArtifactsResp = await server.inject({
      method: "GET",
      url: `/v1/goals/${goal.id}/workflow-runs/${startedRun.id}/artifacts`,
      headers: AUTH_HEADERS,
    });
    expect(runArtifactsResp.statusCode).toBe(200);
    const runArtifacts = ListWorkflowArtifactsResponse.parse(
      JSON.parse(runArtifactsResp.body)
    );
    expect(runArtifacts.artifacts.length).toBeGreaterThan(0);

    const runArtifactsWrongGoalResp = await server.inject({
      method: "GET",
      url: `/v1/goals/goal-wrong/workflow-runs/${startedRun.id}/artifacts`,
      headers: AUTH_HEADERS,
    });
    expect(runArtifactsWrongGoalResp.statusCode).toBe(404);

    const listArtifactsResp = await server.inject({
      method: "GET",
      url: `/v1/goals/${goal.id}/workflow-artifacts`,
      headers: AUTH_HEADERS,
    });
    expect(listArtifactsResp.statusCode).toBe(200);
    ListWorkflowArtifactsResponse.parse(JSON.parse(listArtifactsResp.body));

    const getArtifactResp = await server.inject({
      method: "GET",
      url: `/v1/goals/${goal.id}/workflow-artifacts/${createdArtifact.id}`,
      headers: AUTH_HEADERS,
    });
    expect(getArtifactResp.statusCode).toBe(200);
    WorkflowArtifactResponse.parse(JSON.parse(getArtifactResp.body));

    const wrongGoalArtifactResp = await server.inject({
      method: "GET",
      url: `/v1/goals/goal-wrong/workflow-artifacts/${createdArtifact.id}`,
      headers: AUTH_HEADERS,
    });
    expect(wrongGoalArtifactResp.statusCode).toBe(404);

    const pauseResp = await server.inject({
      method: "POST",
      url: `/v1/goals/${goal.id}/workflow-runs/${startedRun.id}/pause`,
      headers: AUTH_HEADERS,
    });
    expect(pauseResp.statusCode).toBe(200);
    WorkflowRunResponse.parse(JSON.parse(pauseResp.body));

    const resumeResp = await server.inject({
      method: "POST",
      url: `/v1/goals/${goal.id}/workflow-runs/${startedRun.id}/resume`,
      headers: AUTH_HEADERS,
    });
    expect(resumeResp.statusCode).toBe(200);
    WorkflowRunResponse.parse(JSON.parse(resumeResp.body));

    const cancelResp = await server.inject({
      method: "POST",
      url: `/v1/goals/${goal.id}/workflow-runs/${startedRun.id}/cancel`,
      headers: AUTH_HEADERS,
    });
    expect(cancelResp.statusCode).toBe(200);
    WorkflowRunResponse.parse(JSON.parse(cancelResp.body));

    const attemptSeedTime = new Date().toISOString();
    const reviewId = "review-http-1";
    const reviewPayload = {
      id: reviewId,
      goalId: goal.id,
      workflowRunId: startedRun.id,
      stepRunId,
      attemptId: "attempt-http-2",
      kind: "select_operator" as const,
      providerId: "orca/openai" as const,
      modelId: "gpt-5",
      title: "Choose an operator",
      summary: "Step purpose: Select the best operator\nFailed transports: hidden_interactive:fallback:interactive_output_invalid",
      choices: [
        {
          id: "human",
          label: "human",
          description: "Continue with explicit human supervision.",
          proposal: {
            orcaProposalVersion: 1 as const,
            kind: "select_operator" as const,
            payload: {
              operatorId: "human",
              operatorKind: "human" as const,
              reason: "Human review fallback",
              requiredCapabilities: [],
              alternativesConsidered: [],
              confidence: 0.5,
              requiresUserApproval: false,
            },
          },
        },
      ],
      createdAt: attemptSeedTime,
    };
    db.prepare(
      "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, current_goal_id, current_workflow_run_id, current_step_run_id, last_health_at, created_at) VALUES ('worker-http-1', 'orca/openai', 'gpt-5', 'codex', 'ready', ?, ?, ?, ?, ?)"
    ).run(goal.id, startedRun.id, stepRunId, attemptSeedTime, attemptSeedTime);
    db.prepare(
      "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES ('attempt-http-1', ?, ?, ?, NULL, 'orca/openai', 'gpt-5', 'hidden_interactive', 'worker-http-1', 'fallback', 'interactive_output_invalid', 'invalid envelope', 55, 100, 'fp-http-1', ?, ?)"
    ).run(goal.id, startedRun.id, stepRunId, attemptSeedTime, attemptSeedTime);
    db.prepare(
      "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES ('attempt-http-2', ?, ?, ?, NULL, 'orca/openai', 'gpt-5', 'human_review', NULL, 'pending', NULL, NULL, 0, NULL, 'fp-http-2', ?, NULL)"
    ).run(goal.id, startedRun.id, stepRunId, attemptSeedTime);
    db.prepare(
      "INSERT INTO orchestration_human_reviews (id, goal_id, workflow_run_id, step_run_id, attempt_id, decision_kind, payload_json, status, submitted_proposal_json, created_at, submitted_at) VALUES (?, ?, ?, ?, 'attempt-http-2', 'select_operator', ?, 'pending', NULL, ?, NULL)"
    ).run(
      reviewId,
      goal.id,
      startedRun.id,
      stepRunId,
      JSON.stringify(reviewPayload),
      attemptSeedTime,
    );
    db.prepare(
      "INSERT INTO orchestration_worker_hook_traces (id, attempt_id, worker_id, provider_id, hook_event_name, hook_status, summary, failure_reason, created_at) VALUES ('trace-http-1', 'attempt-http-1', 'worker-http-1', 'orca/openai', 'AfterTool', 'succeeded', 'tool completed', NULL, ?)"
    ).run(attemptSeedTime);
    db.prepare(
      "INSERT INTO orchestration_worker_output_chunks (worker_id, seq, byte_offset, byte_length, written_at, data) VALUES ('worker-http-1', 0, 0, 5, ?, ?)"
    ).run(attemptSeedTime, Buffer.from("hello"));

    const attemptsResp = await server.inject({
      method: "GET",
      url: `/v1/goals/${goal.id}/orchestration-attempts?workflowRunId=${startedRun.id}`,
      headers: AUTH_HEADERS,
    });
    expect(attemptsResp.statusCode).toBe(200);
    const attemptsBody = ListOrchestrationAttemptsResponse.parse(JSON.parse(attemptsResp.body));
    expect(attemptsBody.attempts.find((attempt) => attempt.id === "attempt-http-2")?.humanReview?.id).toBe(reviewId);

    const attemptsWrongGoalResp = await server.inject({
      method: "GET",
      url: `/v1/goals/goal-wrong/orchestration-attempts?workflowRunId=${startedRun.id}`,
      headers: AUTH_HEADERS,
    });
    expect(attemptsWrongGoalResp.statusCode).toBe(404);

    const workersResp = await server.inject({
      method: "GET",
      url: "/v1/orchestration-workers",
      headers: AUTH_HEADERS,
    });
    expect(workersResp.statusCode).toBe(200);
    ListOrchestrationWorkersResponse.parse(JSON.parse(workersResp.body));

    const workerResp = await server.inject({
      method: "GET",
      url: "/v1/orchestration-workers/worker-http-1",
      headers: AUTH_HEADERS,
    });
    expect(workerResp.statusCode).toBe(200);
    GetOrchestrationWorkerResponse.parse(JSON.parse(workerResp.body));

    const workerMissingResp = await server.inject({
      method: "GET",
      url: "/v1/orchestration-workers/worker-missing",
      headers: AUTH_HEADERS,
    });
    expect(workerMissingResp.statusCode).toBe(404);
  });
});

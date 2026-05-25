import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  CreateGoalResponse,
  GetWorkflowTemplateResponse,
  ListModelProvidersResponse,
  ListOperatorsResponse,
  ListWorkflowArtifactsResponse,
  ListWorkflowDecisionsResponse,
  ListWorkflowRunsResponse,
  ListWorkflowTemplatesResponse,
  NextOrchestratorDecisionResponse,
  UpdateGoalOrchestratorModelResponse,
  WorkflowArtifactResponse,
  WorkflowDecisionResponse,
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

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "orca-m8-http-surface-"));
    tempDirs.push(dir);
    const config = createConfig(dir);
    const db = openDatabase(config);
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
            purpose: "Capture brief from user",
            requiredInputs: [],
            requiredOutputs: ["goal_brief"],
            gateType: "human-input",
            recommendedCapabilities: [],
            validationExpectations: [],
            exitCriteria: ["brief captured"],
            recommendedOperatorIds: [],
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
            purpose: "Capture brief from user",
            requiredInputs: [],
            requiredOutputs: ["goal_brief"],
            gateType: "human-input",
            recommendedCapabilities: [],
            validationExpectations: [],
            exitCriteria: ["brief captured"],
            recommendedOperatorIds: [],
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

    const nextDecisionResp = await server.inject({
      method: "POST",
      url: `/v1/goals/${goal.id}/workflow-runs/${startedRun.id}/next-decision`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: { workflowRunId: startedRun.id },
    });
    expect(nextDecisionResp.statusCode).toBe(200);
    const nextDecision = NextOrchestratorDecisionResponse.parse(
      JSON.parse(nextDecisionResp.body)
    ).decision;

    const listDecisionsResp = await server.inject({
      method: "GET",
      url: `/v1/goals/${goal.id}/workflow-runs/${startedRun.id}/decisions`,
      headers: AUTH_HEADERS,
    });
    expect(listDecisionsResp.statusCode).toBe(200);
    ListWorkflowDecisionsResponse.parse(JSON.parse(listDecisionsResp.body));

    const wrongGoalDecisionsResp = await server.inject({
      method: "GET",
      url: `/v1/goals/goal-wrong/workflow-runs/${startedRun.id}/decisions`,
      headers: AUTH_HEADERS,
    });
    expect(wrongGoalDecisionsResp.statusCode).toBe(404);

    const getDecisionResp = await server.inject({
      method: "GET",
      url: `/v1/goals/${goal.id}/workflow-decisions/${nextDecision.decisionId}`,
      headers: AUTH_HEADERS,
    });
    expect(getDecisionResp.statusCode).toBe(200);
    WorkflowDecisionResponse.parse(JSON.parse(getDecisionResp.body));

    const wrongGoalDecisionResp = await server.inject({
      method: "GET",
      url: `/v1/goals/goal-wrong/workflow-decisions/${nextDecision.decisionId}`,
      headers: AUTH_HEADERS,
    });
    expect(wrongGoalDecisionResp.statusCode).toBe(404);

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

    const submitInputResp = await server.inject({
      method: "POST",
      url: `/v1/goals/${goal.id}/workflow-step-runs/${stepRunId}/submit-input`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        stepRunId,
        answerText: "Goal: route coverage",
        satisfiedExitCriteria: ["brief captured"],
        artifactInputs: [
          {
            type: "goal_brief",
            title: "Goal Brief",
            body: "Goal details",
          },
        ],
      },
    });
    expect(submitInputResp.statusCode).toBe(200);
    WorkflowStepRunResponse.parse(JSON.parse(submitInputResp.body));

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
  });
});

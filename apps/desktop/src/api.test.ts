import { beforeEach, describe, expect, it, vi } from "vitest";
import { GuidedRefinementOutput, type AdapterId } from "@orca/contracts";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: vi.fn(),
}));

type ApiModule = typeof import("./api");

const now = "2026-01-01T00:00:00.000Z";

const draft = GuidedRefinementOutput.parse({
  skillId: "guided-goal-refinement",
  title: "Ship guided goal flow",
  description: "Refine and attach workspace",
  successCriteria: ["detail view shows refinement"],
  constraints: ["deterministic only"],
  assumptions: ["local daemon available"],
});

const goal = {
  id: "goal-1",
  title: "Ship guided goal flow",
  description: "Refine and attach workspace",
  status: "active" as const,
  autonomyLevel: 1,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
};

const workspace = {
  id: "ws-1",
  goalId: "goal-1",
  path: "/tmp/workspace",
  name: "workspace",
  workspaceType: "folder" as const,
  branch: null,
  isDirty: null,
  gitProbe: "not_a_repo" as const,
  attachedAt: now,
};

const memoryItem = {
  id: "mem-1",
  goalId: "goal-1",
  type: "constraint" as const,
  status: "candidate" as const,
  content: "Use deterministic extraction only.",
  contentHash: "hash-1",
  confidence: 0.9,
  sourceType: "manual" as const,
  sourceId: null,
  sourceSessionId: null,
  sourceExtractionId: null,
  sourceOffsetFirst: null,
  sourceOffsetLast: null,
  createdAt: now,
  updatedAt: now,
  promotedAt: null,
  archivedAt: null,
};

const decision = {
  id: "dec-1",
  goalId: "goal-1",
  title: "Retry extraction manually",
  decisionText: "Use manual retry for failed extraction rows.",
  rationale: null,
  status: "proposed" as const,
  confirmationRequired: true,
  confidence: 0.8,
  sourceType: "manual" as const,
  sourceId: null,
  sourceSessionId: null,
  sourceExtractionId: null,
  sourceOffsetFirst: null,
  sourceOffsetLast: null,
  createdAt: now,
  updatedAt: now,
  confirmedAt: null,
  archivedAt: null,
};

const orchestratorUserMessage = {
  id: "msg-user",
  goalId: "goal-1",
  role: "user" as const,
  kind: "message" as const,
  body: "Need a rollout plan.",
  correlationId: "corr-1",
  createdAt: now,
};

const orchestratorReplyMessage = {
  id: "msg-orca",
  goalId: "goal-1",
  role: "orchestrator" as const,
  kind: "message" as const,
  body: "Start with a bounded verification pass.",
  correlationId: "corr-1",
  createdAt: now,
};

const summary = {
  id: "sum-1",
  sessionId: "sess-1",
  goalId: "goal-1",
  extractionId: "ext-1",
  headline: "Session completed with one blocker",
  summaryText: "Build passed after retrying tests.",
  truncated: false,
  sourceOffsetFirst: 0,
  sourceOffsetLast: 120,
  createdAt: now,
};

const extraction = {
  id: "ext-1",
  goalId: "goal-1",
  sessionId: "sess-1",
  trigger: "manual" as const,
  status: "pending" as const,
  extractorVersion: "memory-deterministic-v1",
  sourceFingerprint: "fp-1",
  sourceOffsetFirst: 0,
  sourceOffsetLast: 120,
  summaryId: null,
  itemCount: 0,
  decisionCount: 0,
  promotedCount: 0,
  failureCode: null,
  failureMessage: null,
  requestedAt: now,
  startedAt: null,
  finishedAt: null,
};

const taskGeneration = {
  id: "tg-1",
  goalId: "goal-1",
  trigger: "manual" as const,
  triggerSourceId: null,
  generatorId: "orca-task-generator",
  generatorVersion: "1.0.0",
  inputFingerprint: "input-fp-1",
  requestFingerprint: "request-fp-1",
  status: "succeeded" as const,
  failureCode: null,
  failureMessage: null,
  sparse: false,
  requestedAt: now,
  startedAt: now,
  finishedAt: now,
};

const task = {
  id: "task-1",
  goalId: "goal-1",
  parentTaskId: null,
  workspaceId: "ws-1",
  role: "engineer" as const,
  status: "open" as const,
  origin: "generator" as const,
  title: "Implement desktop wrappers",
  description: "Add typed wrappers and tests for task, recommendation, and conflict endpoints.",
  acceptanceCriteria: [{ id: "ac-1", text: "All wrappers parse responses" }],
  validationSteps: [{ id: "vs-1", text: "Run desktop tests", kind: "test" as const }],
  dependencies: [],
  sources: [{ type: "refinement" as const, id: "ref-1", reason: "Derived from refinement" }],
  generationId: "tg-1",
  fingerprint: "task-fp-1",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
};

const recommendationGeneration = {
  id: "rg-1",
  goalId: "goal-1",
  trigger: "manual" as const,
  triggerSourceId: "manual",
  providerId: "orca-recommendation-provider",
  providerVersion: "1.0.0",
  inputFingerprint: "input-fp-rec-1",
  requestFingerprint: "request-fp-rec-1",
  status: "succeeded" as const,
  failureCode: null,
  failureMessage: null,
  sparse: false,
  requestedAt: now,
  startedAt: now,
  finishedAt: now,
};

const recommendation = {
  id: "rec-1",
  goalId: "goal-1",
  type: "run_validation" as const,
  status: "proposed" as const,
  source: "deterministic_provider" as const,
  title: "Run validation pass",
  rationale: "Implementation-like activity was detected.",
  proposedAction: {
    kind: "run_validation" as const,
    taskId: "task-1",
    suggestedRole: "reviewer" as const,
    objective: "Run tests and review output",
  },
  confidence: 0.82,
  sources: [{ type: "task" as const, id: "task-1", reason: "Task moved to in_progress" }],
  relatedTaskId: "task-1",
  relatedSessionId: null,
  relatedContextPackageId: null,
  relatedConflictId: null,
  generationId: "rg-1",
  fingerprint: "rec-fp-1",
  supersededById: null,
  createdAt: now,
  updatedAt: now,
};

const recommendationFeedback = {
  id: "rf-1",
  goalId: "goal-1",
  recommendationId: "rec-1",
  action: "accept" as const,
  note: "Looks good",
  modifiedPayloadJson: null,
  createdAt: now,
};

const conflict = {
  id: "conf-1",
  goalId: "goal-1",
  conflictType: "workspace_overlap" as const,
  severity: "warning" as const,
  status: "open" as const,
  title: "Workspace overlap",
  description: "Two active tasks target the same workspace.",
  sources: [{ type: "workspace" as const, id: "ws-1", role: "context" as const }],
  fingerprint: "conf-fp-1",
  resolutionNote: null,
  detectedAt: now,
  resolvedAt: null,
};

const contextPackage = {
  id: "pkg-1",
  goalId: "goal-1",
  supersedesPackageId: null,
  adapterId: "shell-manual" as const,
  workspaceId: "ws-1",
  taskId: "task-1",
  fromRecommendationId: "rec-1",
  role: "engineer" as const,
  objective: "Implement wrapper and verify",
  status: "ready" as const,
  renderedContext: "bounded context",
  renderedBytes: 15,
  estimatedTokens: 4,
  truncated: false,
  sparse: false,
  sourceCount: 1,
  sources: [
    {
      type: "goal" as const,
      id: "goal-1",
      sourceSessionId: null,
      label: "Goal",
      reason: "required" as const,
      marker: "goal",
    },
  ],
  warnings: [],
  sourceFingerprint: "ctx-fp-1",
  assemblerVersion: "context-deterministic-v1",
  createdAt: now,
};

const contextAssembly = {
  id: "asm-1",
  goalId: "goal-1",
  packageId: "pkg-1",
  replacePackageId: null,
  adapterId: "shell-manual" as const,
  workspaceId: "ws-1",
  role: "engineer" as const,
  objectiveHash: "objective-hash",
  sourceFingerprint: "ctx-fp-1",
  assemblerVersion: "context-deterministic-v1",
  requestFingerprint: "asm-request-fp-1",
  status: "succeeded" as const,
  trigger: "prepare" as const,
  failureCode: null,
  failureMessage: null,
  requestedAt: now,
  startedAt: now,
  finishedAt: now,
};

const workflowRun = {
  id: "run-1",
  goalId: "goal-1",
  templateId: "orca/engineering",
  templateVersion: 1,
  status: "active" as const,
  currentStepRunId: "step-1",
  startedAt: now,
  finishedAt: null,
  blockedReason: null,
};

const workflowStepRun = {
  id: "step-1",
  goalId: "goal-1",
  workflowRunId: "run-1",
  stepTemplateId: "intake",
  ordinal: 0,
  attempt: 1,
  status: "active" as const,
  startedAt: now,
  finishedAt: null,
  blockedReason: null,
  satisfiedExitCriteria: [],
  outstandingExitCriteria: ["goal brief captured"],
};

const workflowDecision = {
  decisionId: "wf-dec-1",
  goalId: "goal-1",
  workflowRunId: "run-1",
  stepRunId: "step-1",
  decisionType: "request_user_input" as const,
  selectedAction: "request_input:intake",
  reason: "Need the initial project brief.",
  influencedBy: [
    {
      kind: "artifact" as const,
      id: "goal_brief",
      label: "goal_brief",
      effect: "missing" as const,
    },
  ],
  createdAt: now,
};

const workflowArtifact = {
  id: "art-1",
  goalId: "goal-1",
  workflowRunId: "run-1",
  stepRunId: "step-1",
  type: "goal_brief" as const,
  title: "Goal Brief",
  body: "# Goal",
  source: "user" as const,
  linkedSessionId: null,
  linkedTaskId: null,
  linkedContextPackageId: null,
  createdAt: now,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("desktop api client", () => {
  let api: ApiModule;
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    api = await import("./api");
  });

  it("createGoal accepts refined + workspaces and returns CreateGoalResponse", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { goal }));

    const response = await api.createGoal({
      title: "Ship guided goal flow",
      description: "Refine and attach workspace",
      refined: draft,
      workspaces: [{ inputPath: "/tmp/workspace", name: "workspace" }],
    });

    expect(response.goal.id).toBe("goal-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Ship guided goal flow",
      description: "Refine and attach workspace",
      refined: draft,
      workspaces: [{ inputPath: "/tmp/workspace", name: "workspace" }],
    });
  });

  it("createGoal forwards orchestratorModel when selected", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { goal }));

    await api.createGoal({
      title: "Workflow goal",
      description: "Has orchestrator model",
      orchestratorModel: {
        providerId: "orca/openai",
        modelId: "gpt-5",
      },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Workflow goal",
      description: "Has orchestrator model",
      orchestratorModel: {
        providerId: "orca/openai",
        modelId: "gpt-5",
      },
    });
  });

  it("listModelProviders fetches configured providers", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        providers: [
          {
            id: "orca/openai",
            displayName: "OpenAI",
            available: true,
            models: [
              { id: "gpt-5", displayName: "GPT 5", capabilities: ["planning"] },
            ],
          },
        ],
      }),
    );

    const response = await api.listModelProviders();

    expect(response).toHaveLength(1);
    expect(response[0]!.id).toBe("orca/openai");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/model-providers");
  });

  it("refineGoal posts payload and returns draft", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { draft }));

    const response = await api.refineGoal({ title: "Ship guided goal flow", description: "desc" });

    expect(response.draft.skillId).toBe("guided-goal-refinement");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/refine");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Ship guided goal flow",
      description: "desc",
    });
  });

  it("getGoalDetail fetches goal detail", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        goal,
        refinement: {
          goalId: goal.id,
          skillId: "guided-goal-refinement",
          successCriteria: ["detail view shows refinement"],
          constraints: ["deterministic only"],
          assumptions: ["local daemon available"],
          refinedAt: now,
        },
        workspaces: [workspace],
      }),
    );

    const response = await api.getGoalDetail("goal-1");

    expect(response.goal.id).toBe("goal-1");
    expect(response.workspaces).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1");
    expect(init?.method).toBeUndefined();
  });

  it("inspectWorkspace returns preview", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        preview: {
          path: workspace.path,
          name: workspace.name,
          workspaceType: workspace.workspaceType,
          branch: workspace.branch,
          isDirty: workspace.isDirty,
          gitProbe: workspace.gitProbe,
        },
      }),
    );

    const response = await api.inspectWorkspace({ inputPath: "/tmp/workspace" });

    expect(response.preview.path).toBe("/tmp/workspace");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/workspaces/inspect");
    expect(init?.method).toBe("POST");
  });

  it("attachWorkspace posts request and returns workspace", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { workspace }));

    const response = await api.attachWorkspace("goal-1", {
      inputPath: "/tmp/workspace",
      name: "workspace",
    });

    expect(response.workspace.id).toBe("ws-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/workspaces");
    expect(init?.method).toBe("POST");
  });

  it("detachWorkspace issues DELETE and resolves void", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(api.detachWorkspace("goal-1", "ws-1")).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/workspaces/ws-1");
    expect(init?.method).toBe("DELETE");
  });

  it("maps structured 400 code into ApiError.code", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, {
        error: { code: "invalid_input", message: "Title is required" },
      }),
    );

    await expect(api.refineGoal({ title: "x", description: "" })).rejects.toMatchObject({
      name: "ApiError",
      message: "Title is required",
      code: "invalid_input",
    });
  });

  it("returns ApiError for 401 unauthorized", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: "unauthorized" }));

    await expect(api.getGoalDetail("goal-1")).rejects.toMatchObject({
      name: "ApiError",
      message: "unauthorized",
      code: undefined,
    });
  });

  it("returns ApiError for 404", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { error: { code: "not_found", message: "Goal not found: goal-1" } }),
    );

    await expect(api.getGoalDetail("goal-1")).rejects.toMatchObject({
      name: "ApiError",
      message: "Goal not found: goal-1",
      code: "not_found",
    });
  });

  it("returns workspace_duplicate code on 409", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: { code: "workspace_duplicate", message: "Workspace already attached" },
      }),
    );

    await expect(
      api.attachWorkspace("goal-1", { inputPath: "/tmp/workspace", name: "workspace" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "workspace_duplicate",
    });
  });

  it("returns inspection_timeout code on 504", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(504, {
        error: { code: "inspection_timeout", message: "Inspection timed out" },
      }),
    );

    await expect(api.inspectWorkspace({ inputPath: "/tmp/workspace" })).rejects.toMatchObject({
      name: "ApiError",
      code: "inspection_timeout",
    });
  });

  it("listAdapters fetches adapter list", async () => {
    const adapters = [
      { id: "shell-manual" as AdapterId, title: "Shell / Manual", availability: "available" as const },
      { id: "claude-code" as AdapterId, title: "Claude Code", availability: "unavailable" as const, detail: "binary not found" },
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { adapters }));

    const response = await api.listAdapters();

    expect(response.adapters).toHaveLength(2);
    expect(response.adapters[0]!.id).toBe("shell-manual");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/adapters");
    expect(init?.method).toBeUndefined();
  });

  it("listSessions fetches sessions for goal", async () => {
    const sessions = [
      {
        id: "sess-1",
        goalId: "goal-1",
        workspaceId: "ws-1",
        adapterId: "shell-manual" as AdapterId,
        role: null,
        title: "shell-manual session",
        status: "created" as const,
        createdAt: now,
        startedAt: null,
        exitedAt: null,
      },
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { sessions }));

    const response = await api.listSessions("goal-1");

    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0]!.id).toBe("sess-1");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/sessions");
  });

  it("workflow wrappers hit the goal-scoped routes with validated payloads", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { run: workflowRun }))
      .mockResolvedValueOnce(
        jsonResponse(200, { decision: workflowDecision, recommendationIds: ["rec-1"] }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { stepRun: workflowStepRun }))
      .mockResolvedValueOnce(jsonResponse(200, { decisions: [workflowDecision] }))
      .mockResolvedValueOnce(jsonResponse(200, { artifacts: [workflowArtifact] }))
      .mockResolvedValueOnce(jsonResponse(200, { stepRun: workflowStepRun }));

    const started = await api.startWorkflowRun("goal-1", {
      goalId: "goal-1",
      templateId: "orca/engineering",
    });
    expect(started.run.id).toBe("run-1");

    const decision = await api.requestNextOrchestratorDecision("goal-1", "run-1", {
      workflowRunId: "run-1",
    });
    expect(decision.recommendationIds).toEqual(["rec-1"]);

    const step = await api.getWorkflowStepRun("goal-1", "step-1");
    expect(step.stepRun.id).toBe("step-1");

    const decisions = await api.listWorkflowDecisions("goal-1", "run-1");
    expect(decisions.decisions).toHaveLength(1);

    const artifacts = await api.listWorkflowRunArtifacts("goal-1", "run-1");
    expect(artifacts.artifacts[0]!.id).toBe("art-1");

    await api.submitWorkflowUserInput("goal-1", "step-1", {
      stepRunId: "step-1",
      answerText: "We need a safe workflow UI.",
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:8787/v1/goals/goal-1/workflow-runs",
      "http://127.0.0.1:8787/v1/goals/goal-1/workflow-runs/run-1/next-decision",
      "http://127.0.0.1:8787/v1/goals/goal-1/workflow-step-runs/step-1",
      "http://127.0.0.1:8787/v1/goals/goal-1/workflow-runs/run-1/decisions",
      "http://127.0.0.1:8787/v1/goals/goal-1/workflow-runs/run-1/artifacts",
      "http://127.0.0.1:8787/v1/goals/goal-1/workflow-step-runs/step-1/submit-input",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      goalId: "goal-1",
      templateId: "orca/engineering",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      workflowRunId: "run-1",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[5]![1]?.body))).toEqual({
      stepRunId: "step-1",
      answerText: "We need a safe workflow UI.",
    });
  });

  it("listOrchestratorMessages fetches goal-scoped chat rows", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { messages: [orchestratorUserMessage, orchestratorReplyMessage] }),
    );

    const response = await api.listOrchestratorMessages("goal-1");

    expect(response.messages.map((message) => message.id)).toEqual(["msg-user", "msg-orca"]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/orchestrator-messages");
    expect(init?.method).toBeUndefined();
  });

  it("createOrchestratorMessage posts a goal-scoped chat message", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        message: orchestratorUserMessage,
        reply: orchestratorReplyMessage,
      }),
    );

    const response = await api.createOrchestratorMessage("goal-1", {
      body: "Need a rollout plan.",
    });

    expect(response.reply.role).toBe("orchestrator");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/orchestrator-messages");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ body: "Need a rollout plan." });
  });

  it("createSession posts to goal sessions endpoint", async () => {
    const session = {
      id: "sess-1",
      goalId: "goal-1",
      workspaceId: "ws-1",
      adapterId: "shell-manual" as AdapterId,
      role: null,
      title: "shell-manual session",
      status: "created" as const,
      createdAt: now,
      startedAt: null,
      exitedAt: null,
      instruction: null,
      pid: null,
      command: null,
      args: null,
      cwd: null,
      terminalCols: null,
      terminalRows: null,
      exitCode: null,
      exitSignal: null,
      failureReason: null,
      failureDetail: null,
      archivedAt: null,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { session }));

    const response = await api.createSession("goal-1", {
      workspaceId: "ws-1",
      adapterId: "shell-manual",
    });

    expect(response.session.id).toBe("sess-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/sessions");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      workspaceId: "ws-1",
      adapterId: "shell-manual",
    });
  });

  it("createSession includes contextPackageId when provided", async () => {
    const session = {
      id: "sess-ctx-1",
      goalId: "goal-1",
      workspaceId: "ws-1",
      adapterId: "shell-manual" as AdapterId,
      contextPackageId: "pkg-1",
      role: null,
      title: "shell-manual session",
      status: "created" as const,
      createdAt: now,
      startedAt: null,
      exitedAt: null,
      instruction: null,
      pid: null,
      command: null,
      args: null,
      cwd: null,
      terminalCols: null,
      terminalRows: null,
      exitCode: null,
      exitSignal: null,
      failureReason: null,
      failureDetail: null,
      archivedAt: null,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { session }));

    const response = await api.createSession("goal-1", {
      workspaceId: "ws-1",
      adapterId: "shell-manual",
      contextPackageId: "pkg-1",
    });

    expect(response.session.contextPackageId).toBe("pkg-1");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      workspaceId: "ws-1",
      adapterId: "shell-manual",
      contextPackageId: "pkg-1",
    });
  });

  it("createSession includes task and recommendation association fields when provided", async () => {
    const session = {
      id: "sess-linked-1",
      goalId: "goal-1",
      workspaceId: "ws-1",
      adapterId: "shell-manual" as AdapterId,
      contextPackageId: "pkg-1",
      taskId: "task-1",
      fromRecommendationId: "rec-1",
      role: null,
      title: "shell-manual session",
      status: "created" as const,
      createdAt: now,
      startedAt: null,
      exitedAt: null,
      instruction: null,
      pid: null,
      command: null,
      args: null,
      cwd: null,
      terminalCols: null,
      terminalRows: null,
      exitCode: null,
      exitSignal: null,
      failureReason: null,
      failureDetail: null,
      archivedAt: null,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { session }));

    const response = await api.createSession("goal-1", {
      workspaceId: "ws-1",
      adapterId: "shell-manual",
      contextPackageId: "pkg-1",
      taskId: "task-1",
      fromRecommendationId: "rec-1",
    });

    expect(response.session.taskId).toBe("task-1");
    expect(response.session.fromRecommendationId).toBe("rec-1");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      workspaceId: "ws-1",
      adapterId: "shell-manual",
      contextPackageId: "pkg-1",
      taskId: "task-1",
      fromRecommendationId: "rec-1",
    });
  });

  it("startSession posts to session start endpoint", async () => {
    const session = {
      id: "sess-1",
      goalId: "goal-1",
      workspaceId: "ws-1",
      adapterId: "shell-manual" as AdapterId,
      role: null,
      title: "shell-manual session",
      status: "running" as const,
      createdAt: now,
      startedAt: now,
      exitedAt: null,
      instruction: null,
      pid: 1234,
      command: "/bin/sh",
      args: null,
      cwd: "/tmp",
      terminalCols: 80,
      terminalRows: 24,
      exitCode: null,
      exitSignal: null,
      failureReason: null,
      failureDetail: null,
      archivedAt: null,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { session }));

    const response = await api.startSession("sess-1", { terminalCols: 80, terminalRows: 24 });

    expect(response.session.status).toBe("running");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/sessions/sess-1/start");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ terminalCols: 80, terminalRows: 24 });
  });

  it("stopSession posts to session stop endpoint", async () => {
    const session = {
      id: "sess-1",
      goalId: "goal-1",
      workspaceId: "ws-1",
      adapterId: "shell-manual" as AdapterId,
      role: null,
      title: "shell-manual session",
      status: "stopped" as const,
      createdAt: now,
      startedAt: now,
      exitedAt: now,
      instruction: null,
      pid: null,
      command: null,
      args: null,
      cwd: null,
      terminalCols: null,
      terminalRows: null,
      exitCode: null,
      exitSignal: null,
      failureReason: null,
      failureDetail: null,
      archivedAt: null,
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { session }));

    const response = await api.stopSession("sess-1");

    expect(response.session.status).toBe("stopped");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/sessions/sess-1/stop");
    expect(init?.method).toBe("POST");
  });

  it("listGoalMemory fetches and returns parsed items", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [memoryItem] }));

    const response = await api.listGoalMemory("goal-1");

    expect(response).toHaveLength(1);
    expect(response[0]!.id).toBe("mem-1");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/memory");
  });

  it("listGoalMemory includes archived filter when requested", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [memoryItem] }));

    await api.listGoalMemory("goal-1", { includeArchived: true });

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/memory?includeArchived=1");
  });

  it("listGoalMemory throws on unexpected response shape", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [{ id: "missing-fields" }] }));

    await expect(api.listGoalMemory("goal-1")).rejects.toMatchObject({
      name: "ApiError",
      message: "Response validation failed",
    });
  });

  it("createGoalMemory posts and returns created item", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { item: memoryItem }));

    const response = await api.createGoalMemory("goal-1", {
      type: "constraint",
      content: "Use deterministic extraction only.",
      confidence: 0.9,
    });

    expect(response.id).toBe("mem-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/memory");
    expect(init?.method).toBe("POST");
  });

  it("patchMemoryItem patches and returns item", async () => {
    const promoted = { ...memoryItem, status: "promoted" as const, promotedAt: now, updatedAt: now };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { item: promoted }));

    const response = await api.patchMemoryItem("mem-1", { status: "promoted" });

    expect(response.status).toBe("promoted");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/memory/mem-1");
    expect(init?.method).toBe("PATCH");
  });

  it("listGoalDecisions fetches and returns parsed items", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { items: [decision] }));

    const response = await api.listGoalDecisions("goal-1");

    expect(response).toHaveLength(1);
    expect(response[0]!.id).toBe("dec-1");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/decisions");
  });

  it("createGoalDecision posts and returns created item", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { item: decision }));

    const response = await api.createGoalDecision("goal-1", {
      title: "Retry extraction manually",
      decisionText: "Use manual retry for failed extraction rows.",
      confirmationRequired: true,
    });

    expect(response.id).toBe("dec-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/decisions");
    expect(init?.method).toBe("POST");
  });

  it("patchDecision patches and returns item", async () => {
    const confirmed = { ...decision, status: "confirmed" as const, confirmedAt: now, updatedAt: now };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { item: confirmed }));

    const response = await api.patchDecision("dec-1", { status: "confirmed" });

    expect(response.status).toBe("confirmed");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/decisions/dec-1");
    expect(init?.method).toBe("PATCH");
  });

  it("getSessionSummary returns parsed summary", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { summary }));

    const response = await api.getSessionSummary("sess-1");

    expect(response?.id).toBe("sum-1");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/sessions/sess-1/summary");
  });

  it("getSessionSummary returns null on 404", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { error: { code: "summary_not_found", message: "No summary found" } }),
    );

    await expect(api.getSessionSummary("sess-1")).resolves.toBeNull();
  });

  it("extractSessionMemory parses created and existing extraction responses", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(201, { extraction }))
      .mockResolvedValueOnce(jsonResponse(200, { extraction }));

    const first = await api.extractSessionMemory("sess-1");
    const second = await api.extractSessionMemory("sess-1");

    expect(first.id).toBe("ext-1");
    expect(second.id).toBe("ext-1");
    const [firstUrl, firstInit] = fetchMock.mock.calls[0]!;
    expect(firstUrl).toBe("http://127.0.0.1:8787/v1/sessions/sess-1/extract-memory");
    expect(firstInit?.method).toBe("POST");
    expect(firstInit?.body).toBe("{}");
  });

  it("extractSessionMemory surfaces structured 409 errors", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: { code: "session_not_terminal", message: "Session is not terminal" },
      }),
    );

    await expect(api.extractSessionMemory("sess-1")).rejects.toMatchObject({
      name: "ApiError",
      code: "session_not_terminal",
    });
  });

  it("createSession rejects with ApiError on 422", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, {
        error: { code: "workspace_unavailable", message: "Workspace path not accessible" },
      }),
    );

    await expect(
      api.createSession("goal-1", { workspaceId: "ws-1", adapterId: "shell-manual" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "workspace_unavailable",
    });
  });

  it("createContextPackage includes task and recommendation association fields when provided", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, {
        package: contextPackage,
        assembly: contextAssembly,
        reused: false,
      }),
    );

    const response = await api.createContextPackage("goal-1", {
      adapterId: "shell-manual",
      role: "engineer",
      objective: "Implement wrapper and verify",
      workspaceId: "ws-1",
      taskId: "task-1",
      fromRecommendationId: "rec-1",
    });

    expect(response.package?.taskId).toBe("task-1");
    expect(response.package?.fromRecommendationId).toBe("rec-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/context-packages");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      adapterId: "shell-manual",
      role: "engineer",
      objective: "Implement wrapper and verify",
      workspaceId: "ws-1",
      taskId: "task-1",
      fromRecommendationId: "rec-1",
    });
  });

  it("generateTasks posts manual trigger and parses response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(202, { generation: taskGeneration }));

    const response = await api.generateTasks("goal-1");

    expect(response.generation.id).toBe("tg-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/tasks/generate");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ trigger: "manual" });
  });

  it("listTasks serializes query and parses task list response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { tasks: [task], generations: [taskGeneration] }),
    );

    const response = await api.listTasks("goal-1", {
      status: "open",
      workspaceId: "ws-1",
      role: "engineer",
      parentTaskId: "task-parent",
      includeArchived: true,
      limit: 10,
      cursor: "cursor-1",
    });

    expect(response.tasks).toHaveLength(1);
    expect(response.generations).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "http://127.0.0.1:8787/v1/goals/goal-1/tasks?status=open&workspaceId=ws-1&role=engineer&parentTaskId=task-parent&includeArchived=true&limit=10&cursor=cursor-1",
    );
  });

  it("createTask posts payload and parses response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { task }));

    const response = await api.createTask("goal-1", {
      title: "Implement desktop wrappers",
      description: "Add typed wrappers and tests for task, recommendation, and conflict endpoints.",
      role: "engineer",
      workspaceId: "ws-1",
      parentTaskId: null,
      acceptanceCriteria: ["All wrappers parse responses"],
      validationSteps: [{ text: "Run desktop tests", kind: "test" }],
      dependencies: [],
      sources: [{ type: "refinement", id: "ref-1", reason: "Derived from refinement" }],
    });

    expect(response.task.id).toBe("task-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/tasks");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      title: "Implement desktop wrappers",
      role: "engineer",
      workspaceId: "ws-1",
    });
  });

  it("patchTask maps 409 to ApiError with code", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: { code: "invalid_task_status", message: "Task status transition is not allowed" },
      }),
    );

    await expect(api.patchTask("task-1", { status: "done" })).rejects.toMatchObject({
      name: "ApiError",
      code: "invalid_task_status",
      message: "Task status transition is not allowed",
    });
  });

  it("splitTask posts payload and parses response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        parentTask: { ...task, status: "blocked" },
        childTasks: [{ ...task, id: "task-2", parentTaskId: "task-1", status: "open" }],
      }),
    );

    const response = await api.splitTask("task-1", {
      children: [
        {
          title: "Write wrapper tests",
          description: "",
          role: "qa",
          acceptanceCriteria: [],
          validationSteps: [],
          dependencies: [],
          sources: [],
        },
      ],
      setParentStatus: "blocked",
    });

    expect(response.parentTask.status).toBe("blocked");
    expect(response.childTasks[0]?.parentTaskId).toBe("task-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/tasks/task-1/split");
    expect(init?.method).toBe("POST");
  });

  it("associateTaskWithSession posts session id and parses response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        task: { ...task, status: "in_progress" },
      }),
    );

    const response = await api.associateTaskWithSession("task-1", "sess-1");

    expect(response.task.status).toBe("in_progress");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/tasks/task-1/associate-session");
    expect(JSON.parse(String(init?.body))).toEqual({ sessionId: "sess-1" });
  });

  it("generateRecommendations posts manual trigger and parses response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(202, { generation: recommendationGeneration }),
    );

    const response = await api.generateRecommendations("goal-1");

    expect(response.generation.id).toBe("rg-1");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/goals/goal-1/recommendations/generate");
    expect(JSON.parse(String(init?.body))).toEqual({ trigger: "manual" });
  });

  it("listRecommendations serializes query and parses response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        recommendations: [recommendation],
        generations: [recommendationGeneration],
      }),
    );

    const response = await api.listRecommendations("goal-1", {
      status: "proposed",
      type: "run_validation",
      relatedTaskId: "task-1",
      includeGenerations: false,
      limit: 20,
      cursor: "rec-cursor-1",
    });

    expect(response.recommendations).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "http://127.0.0.1:8787/v1/goals/goal-1/recommendations?status=proposed&type=run_validation&relatedTaskId=task-1&limit=20&cursor=rec-cursor-1&includeGenerations=false",
    );
  });

  it("getRecommendation maps 404 to ApiError with code", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, {
        error: { code: "recommendation_not_found", message: "Recommendation not found: rec-404" },
      }),
    );

    await expect(api.getRecommendation("rec-404")).rejects.toMatchObject({
      name: "ApiError",
      code: "recommendation_not_found",
    });
  });

  it("acceptRecommendation posts feedback and parses proposedAction response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        recommendation: { ...recommendation, status: "accepted" },
        proposedAction: recommendation.proposedAction,
        feedback: recommendationFeedback,
      }),
    );

    const response = await api.acceptRecommendation("rec-1", { note: "Proceed" });

    expect(response.recommendation.status).toBe("accepted");
    expect(response.proposedAction.kind).toBe("run_validation");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/recommendations/rec-1/accept");
    expect(JSON.parse(String(init?.body))).toEqual({ note: "Proceed" });
  });

  it("rejectRecommendation maps 409 to ApiError with code", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: { code: "invalid_recommendation_status", message: "Recommendation is terminal" },
      }),
    );

    await expect(api.rejectRecommendation("rec-1", { note: "Not needed" })).rejects.toMatchObject({
      name: "ApiError",
      code: "invalid_recommendation_status",
    });
  });

  it("dismissRecommendation posts feedback and parses response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        recommendation: { ...recommendation, status: "dismissed" },
        feedback: { ...recommendationFeedback, action: "dismiss" },
      }),
    );

    const response = await api.dismissRecommendation("rec-1", { note: "Later" });

    expect(response.recommendation.status).toBe("dismissed");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/recommendations/rec-1/dismiss");
  });

  it("modifyRecommendation patches and parses response", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        recommendation: {
          ...recommendation,
          status: "modified",
          source: "user_modified",
          title: "Run full validation pass",
        },
        feedback: {
          ...recommendationFeedback,
          action: "modify",
          modifiedPayloadJson: JSON.stringify(recommendation.proposedAction),
        },
      }),
    );

    const response = await api.modifyRecommendation("rec-1", {
      title: "Run full validation pass",
    });

    expect(response.recommendation.status).toBe("modified");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8787/v1/recommendations/rec-1");
    expect(init?.method).toBe("PATCH");
  });

  it("listConflicts serializes query and parses response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { conflicts: [conflict] }));

    const response = await api.listConflicts("goal-1", {
      status: "open",
      severity: "warning",
      limit: 5,
      cursor: "conf-cursor-1",
    });

    expect(response.conflicts).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      "http://127.0.0.1:8787/v1/goals/goal-1/conflicts?status=open&severity=warning&limit=5&cursor=conf-cursor-1",
    );
  });

  it("resolveConflict posts request and maps 404 to ApiError with code", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, {
        error: { code: "conflict_not_found", message: "Conflict not found: conf-404" },
      }),
    );

    await expect(
      api.resolveConflict("conf-404", { resolution: "resolved", note: "Handled manually" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "conflict_not_found",
    });
  });

  describe("readiness api", () => {
    it("runReadinessCheck POSTs and returns reports", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            reports: [
              {
                agentId: "claude-code",
                status: "ready",
                steps: [],
                checkedAt: "2026-05-22T00:00:00.000Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      const reports = await api.runReadinessCheck();
      expect(reports).toHaveLength(1);
      expect(reports[0].status).toBe("ready");
    });

    it("runReadinessCheckForAgent POSTs to per-agent endpoint", async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            report: {
              agentId: "codex",
              status: "needs_auth",
              steps: [],
              repair: { kind: "run_command", command: "codex login", label: "Sign in" },
              checkedAt: "2026-05-22T00:00:00.000Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      const report = await api.runReadinessCheckForAgent("codex");
      expect(report.status).toBe("needs_auth");
      const call = fetchMock.mock.calls[0][0];
      expect(call).toContain("/v1/agents/codex/readiness:check");
    });
  });
});

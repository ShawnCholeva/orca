import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  AppSettings,
  type PutSettingsRequest,
  AcceptRecommendationResponse,
  Agent,
  ListAgentsResponse,
  UpdateAgentResponse,
  ArchiveGoalResponse,
  AssociateTaskSessionRequest,
  AssociateTaskSessionResponse,
  AttachWorkspaceRequest,
  AttachWorkspaceResponse,
  CheckReadinessAllResponse,
  CheckReadinessOneResponse,
  CheckSystemReadinessResponse,
  CreateContextPackageRequest,
  CreateContextPackageResponse,
  CreateGoalDecisionRequest,
  CreateGoalMemoryRequest,
  CreateGoalRequest,
  CreateGoalResponse,
  CreateGoalAndStartWorkflowRequest,
  CreateGoalAndStartWorkflowResponse,
  CreateOrchestratorMessageRequest,
  CreateOrchestratorMessageResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  CreateWorkflowArtifactRequest,
  CreateTaskRequest,
  CreateTaskResponse,
  GetWorkflowTemplateResponse,
  CreateWorkflowTemplateRequest,
  DismissRecommendationResponse,
  DuplicateWorkflowTemplateRequest,
  DomainEvent,
  ExtractSessionMemoryResponse,
  GetRecommendationResponse,
  GetContextPackageResponse,
  GetSessionResponse,
  GetSessionMemorySummaryResponse,
  GoalDecision,
  GoalDetailResponse,
  GoalMemoryItem,
  HealthResponse,
  InspectWorkspaceRequest,
  InspectWorkspaceResponse,
  ListConflictsQuery,
  ListConflictsResponse,
  ListAdaptersResponse,
  ListActivitiesResponse,
  ListContextPackagesQuery,
  ListContextPackagesResponse,
  ListGoalDecisionsResponse,
  ListGoalMemoryResponse,
  ListGoalsResponse,
  ListModelProvidersResponse,
  ListOrchestrationAttemptsResponse,
  ListOrchestratorMessagesResponse,
  ListPluginsResponse,
  ListRecommendationsQuery,
  ListRecommendationsResponse,
  ListSessionsResponse,
  ListSkillsResponse,
  ListTasksQuery,
  ListTasksResponse,
  ListWorkflowArtifactsResponse,
  ListWorkflowDecisionsResponse,
  ListWorkflowRunsResponse,
  ListWorkflowTemplatesResponse,
  MemoryExtraction,
  ModifyRecommendationRequest,
  ModifyRecommendationResponse,
  NextOrchestratorDecisionResponse,
  GetOrchestrationWorkerResponse,
  PatchGoalDecisionRequest,
  PatchGoalMemoryRequest,
  RecommendationFeedbackRequest,
  RecommendationGenerationRequest,
  RecommendationGenerationResponse,
  RejectRecommendationResponse,
  RefineGoalRequest,
  RefineGoalResponse,
  ResolveConflictRequest,
  ResolveConflictResponse,
  RequestNextOrchestratorDecisionRequest,
  SessionErrorFrame,
  SessionMemorySummary,
  SessionOutputFrame,
  SplitTaskRequest,
  SplitTaskResponse,
  StartWorkflowRunRequest,
  StartSessionRequest,
  StartSessionResponse,
  StopSessionResponse,
  SubmitHumanReviewDecisionRequest,
  SubmitWorkflowUserInputRequest,
  TaskGenerationRequest,
  TaskGenerationResponse,
  UpdateGoalOrchestratorModelRequest,
  UpdateGoalOrchestratorModelResponse,
  UpdateTaskRequest,
  UpdateTaskResponse,
  UpdateGoalRequest,
  UpdateGoalResponse,
  UpdateWorkflowTemplateRequest,
  WorkflowArtifactResponse,
  WorkflowDecisionResponse,
  WorkflowRunResponse,
  WorkflowStepRunResponse,
  WorkflowTemplateResponse,
  ListBuiltInTemplateCatalogResponse,
  InstallBuiltInTemplatesResponse,
  type BuiltInTemplateSummary,
  type WorkflowTemplate,
  type Activity,
  type AgentReadinessReport,
  type SystemReadinessReport,
  type PluginSummary,
  type SessionErrorFrame as SessionErrorFrameData,
  type SessionInputFrame as SessionInputFrameData,
  type SessionOutputFrame as SessionOutputFrameData,
  type SessionResizeFrame as SessionResizeFrameData,
  type SessionSubscribeFrame as SessionSubscribeFrameData,
  type SessionUnsubscribeFrame as SessionUnsubscribeFrameData,
  type SkillSummary,
  type ProviderRecoveryActionRequest,
  type ProviderRecoverySwitchRequest,
} from "@orca/contracts";

export type {
  AcceptRecommendationResponse,
  AssociateTaskSessionResponse,
  Conflict,
  CreateTaskRequest,
  CreateTaskResponse,
  DismissRecommendationResponse,
  GetRecommendationResponse,
  ListConflictsQuery,
  ListConflictsResponse,
  ListRecommendationsQuery,
  ListRecommendationsResponse,
  ListTasksQuery,
  ListTasksResponse,
  ModifyRecommendationRequest,
  ModifyRecommendationResponse,
  Recommendation,
  RecommendationFeedbackRequest,
  RecommendationGenerationResponse,
  RejectRecommendationResponse,
  ResolveConflictRequest,
  ResolveConflictResponse,
  SplitTaskRequest,
  SplitTaskResponse,
  Task,
  TaskGenerationResponse,
  UpdateTaskRequest,
  UpdateTaskResponse,
} from "@orca/contracts";

interface Config {
  baseUrl: string;
  token: string;
}

interface DaemonEndpoint {
  url: string;
  token: string;
}

let configPromise: Promise<Config> | null = null;

const GoalMemoryItemResponse = {
  parse(data: unknown): { item: GoalMemoryItem } {
    if (!isRecord(data) || !("item" in data) || Object.keys(data).length !== 1) {
      throw new Error("invalid goal memory item response");
    }
    return { item: GoalMemoryItem.parse(data.item) };
  },
};

const GoalDecisionResponse = {
  parse(data: unknown): { item: GoalDecision } {
    if (!isRecord(data) || !("item" in data) || Object.keys(data).length !== 1) {
      throw new Error("invalid goal decision response");
    }
    return { item: GoalDecision.parse(data.item) };
  },
};

type CreateGoalMemoryInput = Parameters<typeof CreateGoalMemoryRequest.parse>[0];
type PatchGoalMemoryInput = Parameters<typeof PatchGoalMemoryRequest.parse>[0];
type CreateGoalDecisionInput = Parameters<typeof CreateGoalDecisionRequest.parse>[0];
type PatchGoalDecisionInput = Parameters<typeof PatchGoalDecisionRequest.parse>[0];
type CreateWorkflowTemplateInput = Parameters<typeof CreateWorkflowTemplateRequest.parse>[0];
type DuplicateWorkflowTemplateInput = Parameters<typeof DuplicateWorkflowTemplateRequest.parse>[0];
type UpdateWorkflowTemplateInput = Parameters<typeof UpdateWorkflowTemplateRequest.parse>[0];

function loadConfig(): Promise<Config> {
  if (configPromise) return configPromise;

  configPromise = (async () => {
    if (isTauri()) {
      const ep = await invoke<DaemonEndpoint>("get_daemon_endpoint");
      return { baseUrl: ep.url, token: ep.token };
    }
    return {
      baseUrl:
        (import.meta.env.VITE_ORCA_BASE_URL as string | undefined) ||
        "http://127.0.0.1:8787",
      token: (import.meta.env.VITE_ORCA_TOKEN as string | undefined) || "",
    };
  })();

  return configPromise;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function toErrorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function authHeaders(token: string): HeadersInit {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

async function parseResponse<T>(
  res: Response,
  schema: { parse(data: unknown): T },
): Promise<T> {
  const json: unknown = await res.json();
  try {
    return schema.parse(json);
  } catch (err) {
    throw new ApiError("Response validation failed", err);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJsonBody(res: Response): Promise<unknown | undefined> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function toApiError(
  res: Response,
  body: unknown,
  fallbackMessage: string,
): ApiError {
  let message = `${fallbackMessage} (${res.status})`;
  let code: string | undefined;

  if (isRecord(body)) {
    const error = body["error"];
    if (typeof error === "string" && error.length > 0) {
      message = error;
    } else if (isRecord(error)) {
      const bodyMessage = error["message"];
      const bodyCode = error["code"];
      if (typeof bodyMessage === "string" && bodyMessage.length > 0) {
        message = bodyMessage;
      }
      if (typeof bodyCode === "string" && bodyCode.length > 0) {
        code = bodyCode;
      }
    }
  }

  return new ApiError(message, body, code);
}

async function requestJson<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  schema: { parse(data: unknown): T },
  fallbackMessage: string,
): Promise<T> {
  const res = await fetch(input, init);
  const json = await readJsonBody(res);
  if (!res.ok) {
    throw toApiError(res, json, fallbackMessage);
  }
  try {
    return schema.parse(json);
  } catch (err) {
    throw new ApiError("Response validation failed", err);
  }
}

async function requestVoid(
  input: RequestInfo | URL,
  init: RequestInit,
  fallbackMessage: string,
): Promise<void> {
  const res = await fetch(input, init);
  if (!res.ok) {
    const json = await readJsonBody(res);
    throw toApiError(res, json, fallbackMessage);
  }
}

export async function fetchHealth(): Promise<HealthResponse> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/health`, {
    headers: authHeaders(token),
  });
  return parseResponse(res, HealthResponse);
}

export async function listGoals(): Promise<ListGoalsResponse> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/goals`, {
    headers: authHeaders(token),
  });
  return parseResponse(res, ListGoalsResponse);
}

export async function listPlugins(): Promise<PluginSummary[]> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/plugins`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new ApiError(`List plugins failed (${res.status})`);
  }
  const body = await parseResponse(res, ListPluginsResponse);
  return body.plugins;
}

export async function listSkills(): Promise<SkillSummary[]> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/skills`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new ApiError(`List skills failed (${res.status})`);
  }
  const body = await parseResponse(res, ListSkillsResponse);
  return body.skills;
}

export async function listAgents(): Promise<Agent[]> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/agents`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new ApiError(`List agents failed (${res.status})`);
  }
  const body = await parseResponse(res, ListAgentsResponse);
  return body.agents;
}

export async function updateAgentConnection(id: string, connected: boolean): Promise<Agent> {
  const { baseUrl, token } = await loadConfig();
  const body = await requestJson<UpdateAgentResponse>(
    `${baseUrl}/v1/agents/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify({ connected }),
    },
    UpdateAgentResponse,
    `Update agent ${id} failed`,
  );
  return body.agent;
}

export async function runReadinessCheck(): Promise<AgentReadinessReport[]> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/agents/readiness:check`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: "{}",
  });
  if (!res.ok) throw new ApiError(`Readiness check failed (${res.status})`);
  const body = await parseResponse(res, CheckReadinessAllResponse);
  return body.reports;
}

export async function runReadinessCheckForAgent(id: string): Promise<AgentReadinessReport> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/agents/${encodeURIComponent(id)}/readiness:check`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: "{}",
  });
  if (!res.ok) throw new ApiError(`Readiness check for ${id} failed (${res.status})`);
  const body = await parseResponse(res, CheckReadinessOneResponse);
  return body.report;
}

export async function runSystemReadinessCheck(): Promise<SystemReadinessReport> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/system/readiness:check`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(token) },
    body: "{}",
  });
  if (!res.ok) throw new ApiError(`System readiness check failed (${res.status})`);
  const body = await parseResponse(res, CheckSystemReadinessResponse);
  return body.report;
}

export async function createGoal(
  input: CreateGoalRequest,
): Promise<CreateGoalResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(CreateGoalRequest.parse(input)),
    },
    CreateGoalResponse,
    "Create goal failed",
  );
}

export async function createGoalAndStartWorkflow(
  input: CreateGoalAndStartWorkflowRequest,
): Promise<CreateGoalAndStartWorkflowResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/create-and-start-workflow`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(CreateGoalAndStartWorkflowRequest.parse(input)),
    },
    CreateGoalAndStartWorkflowResponse,
    "Create goal and start workflow failed",
  );
}

export async function refineGoal(
  input: RefineGoalRequest,
): Promise<RefineGoalResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/refine`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(RefineGoalRequest.parse(input)),
    },
    RefineGoalResponse,
    "Refine goal failed",
  );
}

export async function getGoalDetail(goalId: string): Promise<GoalDetailResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}`,
    {
      headers: authHeaders(token),
    },
    GoalDetailResponse,
    "Get goal detail failed",
  );
}

export async function listGoalMemory(
  goalId: string,
  options?: { includeArchived?: boolean },
): Promise<GoalMemoryItem[]> {
  const { baseUrl, token } = await loadConfig();
  const url = new URL(`${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/memory`);
  if (options?.includeArchived) {
    url.searchParams.set("includeArchived", "1");
  }
  const body = await requestJson(
    url.toString(),
    { headers: authHeaders(token) },
    ListGoalMemoryResponse,
    "List goal memory failed",
  );
  return body.items;
}

export async function createGoalMemory(
  goalId: string,
  input: CreateGoalMemoryInput,
): Promise<GoalMemoryItem> {
  const { baseUrl, token } = await loadConfig();
  const body = await requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/memory`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(CreateGoalMemoryRequest.parse(input)),
    },
    GoalMemoryItemResponse,
    "Create goal memory failed",
  );
  return body.item;
}

export async function patchMemoryItem(
  id: string,
  patch: PatchGoalMemoryInput,
): Promise<GoalMemoryItem> {
  const { baseUrl, token } = await loadConfig();
  const body = await requestJson(
    `${baseUrl}/v1/memory/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(PatchGoalMemoryRequest.parse(patch)),
    },
    GoalMemoryItemResponse,
    "Patch memory item failed",
  );
  return body.item;
}

export async function listGoalDecisions(goalId: string): Promise<GoalDecision[]> {
  const { baseUrl, token } = await loadConfig();
  const body = await requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/decisions`,
    { headers: authHeaders(token) },
    ListGoalDecisionsResponse,
    "List goal decisions failed",
  );
  return body.items;
}

export async function createGoalDecision(
  goalId: string,
  input: CreateGoalDecisionInput,
): Promise<GoalDecision> {
  const { baseUrl, token } = await loadConfig();
  const body = await requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/decisions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(CreateGoalDecisionRequest.parse(input)),
    },
    GoalDecisionResponse,
    "Create goal decision failed",
  );
  return body.item;
}

export async function patchDecision(
  id: string,
  patch: PatchGoalDecisionInput,
): Promise<GoalDecision> {
  const { baseUrl, token } = await loadConfig();
  const body = await requestJson(
    `${baseUrl}/v1/decisions/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(PatchGoalDecisionRequest.parse(patch)),
    },
    GoalDecisionResponse,
    "Patch decision failed",
  );
  return body.item;
}

export async function getSessionSummary(
  sessionId: string,
): Promise<SessionMemorySummary | null> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(
    `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/summary`,
    { headers: authHeaders(token) },
  );
  if (res.status === 404) {
    return null;
  }

  const json = await readJsonBody(res);
  if (!res.ok) {
    throw toApiError(res, json, "Get session summary failed");
  }

  try {
    return GetSessionMemorySummaryResponse.parse(json).summary;
  } catch (err) {
    throw new ApiError("Response validation failed", err);
  }
}

export async function extractSessionMemory(
  sessionId: string,
): Promise<MemoryExtraction> {
  const { baseUrl, token } = await loadConfig();
  const body = await requestJson(
    `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/extract-memory`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify({}),
    },
    ExtractSessionMemoryResponse,
    "Extract session memory failed",
  );
  return body.extraction;
}

export async function inspectWorkspace(
  input: InspectWorkspaceRequest,
): Promise<InspectWorkspaceResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/workspaces/inspect`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(InspectWorkspaceRequest.parse(input)),
    },
    InspectWorkspaceResponse,
    "Inspect workspace failed",
  );
}

export async function attachWorkspace(
  goalId: string,
  input: AttachWorkspaceRequest,
): Promise<AttachWorkspaceResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/workspaces`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(AttachWorkspaceRequest.parse(input)),
    },
    AttachWorkspaceResponse,
    "Attach workspace failed",
  );
}

export async function detachWorkspace(
  goalId: string,
  workspaceId: string,
): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  return requestVoid(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/workspaces/${encodeURIComponent(workspaceId)}`,
    {
      method: "DELETE",
      headers: authHeaders(token),
    },
    "Detach workspace failed",
  );
}

export async function updateGoal(
  id: string,
  patch: UpdateGoalRequest,
): Promise<UpdateGoalResponse> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/goals/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
    },
    body: JSON.stringify(UpdateGoalRequest.parse(patch)),
  });
  if (!res.ok) {
    throw new ApiError(`Update failed (${res.status})`);
  }
  return parseResponse(res, UpdateGoalResponse);
}

export async function archiveGoal(id: string): Promise<ArchiveGoalResponse> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(
    `${baseUrl}/v1/goals/${encodeURIComponent(id)}/archive`,
    {
      method: "POST",
      headers: authHeaders(token),
    },
  );
  if (!res.ok) {
    throw new ApiError(`Archive failed (${res.status})`);
  }
  return parseResponse(res, ArchiveGoalResponse);
}

export async function listAdapters(): Promise<ListAdaptersResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/adapters`,
    { headers: authHeaders(token) },
    ListAdaptersResponse,
    "List adapters failed",
  );
}

export async function listModelProviders(): Promise<ListModelProvidersResponse["providers"]> {
  const { baseUrl, token } = await loadConfig();
  const body = await requestJson(
    `${baseUrl}/v1/model-providers`,
    { headers: authHeaders(token) },
    ListModelProvidersResponse,
    "List model providers failed",
  );
  return body.providers;
}

export async function updateGoalOrchestratorModel(
  goalId: string,
  body: UpdateGoalOrchestratorModelRequest,
): Promise<UpdateGoalOrchestratorModelResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/orchestrator-model`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(UpdateGoalOrchestratorModelRequest.parse(body)),
    },
    UpdateGoalOrchestratorModelResponse,
    "Update orchestrator model failed",
  );
}

export async function listWorkflowTemplates(): Promise<ListWorkflowTemplatesResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/workflow-templates`,
    { headers: authHeaders(token) },
    ListWorkflowTemplatesResponse,
    "List workflow templates failed",
  );
}

export async function getWorkflowTemplate(id: string): Promise<GetWorkflowTemplateResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/workflow-templates/${encodeURIComponent(id)}`,
    { headers: authHeaders(token) },
    GetWorkflowTemplateResponse,
    "Get workflow template failed",
  );
}

export async function createWorkflowTemplate(
  body: CreateWorkflowTemplateInput,
): Promise<WorkflowTemplateResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/workflow-templates`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(CreateWorkflowTemplateRequest.parse(body)),
    },
    WorkflowTemplateResponse,
    "Create workflow template failed",
  );
}

export async function updateWorkflowTemplate(
  id: string,
  body: UpdateWorkflowTemplateInput,
): Promise<WorkflowTemplateResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/workflow-templates/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(UpdateWorkflowTemplateRequest.parse(body)),
    },
    WorkflowTemplateResponse,
    "Update workflow template failed",
  );
}

export async function duplicateWorkflowTemplate(
  id: string,
  body: DuplicateWorkflowTemplateInput,
): Promise<WorkflowTemplateResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/workflow-templates/${encodeURIComponent(id)}/duplicate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(DuplicateWorkflowTemplateRequest.parse(body)),
    },
    WorkflowTemplateResponse,
    "Duplicate workflow template failed",
  );
}

export async function listTemplateCatalog(): Promise<BuiltInTemplateSummary[]> {
  const { baseUrl, token } = await loadConfig();
  const res = await fetch(`${baseUrl}/v1/workflow-templates/catalog`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    throw new ApiError(`List template catalog failed (${res.status})`);
  }
  const body = await parseResponse(res, ListBuiltInTemplateCatalogResponse);
  return body.catalog;
}

export async function installTemplates(ids: string[]): Promise<WorkflowTemplate[]> {
  const { baseUrl, token } = await loadConfig();
  const body = await requestJson(
    `${baseUrl}/v1/workflow-templates/install`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(token) },
      body: JSON.stringify({ ids }),
    },
    InstallBuiltInTemplatesResponse,
    "Install workflow templates failed",
  );
  return body.templates;
}

export async function startWorkflowRun(
  goalId: string,
  body: StartWorkflowRunRequest,
): Promise<WorkflowRunResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/workflow-runs`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(StartWorkflowRunRequest.parse(body)),
    },
    WorkflowRunResponse,
    "Start workflow run failed",
  );
}

export async function getWorkflowRun(
  goalId: string,
  runId: string,
): Promise<WorkflowRunResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/workflow-runs/${encodeURIComponent(runId)}`,
    { headers: authHeaders(token) },
    WorkflowRunResponse,
    "Get workflow run failed",
  );
}

export async function listWorkflowRuns(
  goalId: string,
): Promise<ListWorkflowRunsResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/workflow-runs`,
    { headers: authHeaders(token) },
    ListWorkflowRunsResponse,
    "List workflow runs failed",
  );
}

export async function requestNextOrchestratorDecision(
  goalId: string,
  runId: string,
  body: RequestNextOrchestratorDecisionRequest,
): Promise<NextOrchestratorDecisionResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/workflow-runs/${encodeURIComponent(runId)}/next-decision`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(RequestNextOrchestratorDecisionRequest.parse(body)),
    },
    NextOrchestratorDecisionResponse,
    "Request next orchestrator decision failed",
  );
}

export async function listOrchestratorMessages(
  goalId: string,
): Promise<ListOrchestratorMessagesResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/orchestrator-messages`,
    { headers: authHeaders(token) },
    ListOrchestratorMessagesResponse,
    "List orchestrator messages failed",
  );
}

export async function createOrchestratorMessage(
  goalId: string,
  body: CreateOrchestratorMessageRequest,
): Promise<CreateOrchestratorMessageResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/orchestrator-messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(CreateOrchestratorMessageRequest.parse(body)),
    },
    CreateOrchestratorMessageResponse,
    "Create orchestrator message failed",
  );
}

export async function submitWorkerAnswers(
  goalId: string,
  questionId: string,
  answers: { questionIndex: number; selectedLabels: string[] }[],
): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  return requestVoid(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/worker-questions/${encodeURIComponent(questionId)}/answer`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify({ answers }),
    },
    "Submit worker answers failed",
  );
}

export async function submitOrchestratorAnswer(
  goalId: string,
  questionId: string,
  body: { answers: { questionIndex: number; selectedLabels: string[] }[] } | { freeText: string },
): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  return requestVoid(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/orchestrator-questions/${encodeURIComponent(questionId)}/answer`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(body),
    },
    "Submit orchestrator answer failed",
  );
}

export async function submitWorkerFreeText(
  goalId: string,
  questionId: string,
  freeText: string,
  opts?: { fromChat?: boolean },
): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  return requestVoid(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/worker-questions/${encodeURIComponent(questionId)}/answer`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify({ freeText, ...(opts?.fromChat ? { fromChat: true } : {}) }),
    },
    "Submit worker free-text answer failed",
  );
}

export async function submitPermissionDecision(
  goalId: string,
  approvalId: string,
  decision: "allow" | "deny",
  remember = false,
): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  return requestVoid(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/permission-approvals/${encodeURIComponent(approvalId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify({ decision, remember }),
    },
    "Submit permission decision failed",
  );
}

export async function setWorkerPermissionMode(
  goalId: string,
  workerPermissionMode: "ask" | "auto",
): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  return requestVoid(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/worker-permission-mode`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify({ workerPermissionMode }),
    },
    "Set worker permission mode failed",
  );
}

export async function listWorkflowDecisions(
  goalId: string,
  runId: string,
): Promise<ListWorkflowDecisionsResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/workflow-runs/${encodeURIComponent(runId)}/decisions`,
    { headers: authHeaders(token) },
    ListWorkflowDecisionsResponse,
    "List workflow decisions failed",
  );
}

export async function listOrchestrationAttempts(
  goalId: string,
  workflowRunId: string,
): Promise<ListOrchestrationAttemptsResponse> {
  const { baseUrl, token } = await loadConfig();
  const url = new URL(`${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/orchestration-attempts`);
  url.searchParams.set("workflowRunId", workflowRunId);
  return requestJson(
    url,
    { headers: authHeaders(token) },
    ListOrchestrationAttemptsResponse,
    "List orchestration attempts failed",
  );
}

export async function getOrchestrationWorker(
  workerId: string,
): Promise<GetOrchestrationWorkerResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/orchestration-workers/${encodeURIComponent(workerId)}`,
    { headers: authHeaders(token) },
    GetOrchestrationWorkerResponse,
    "Get orchestration worker failed",
  );
}

export async function submitHumanReviewDecision(
  goalId: string,
  runId: string,
  attemptId: string,
  body: SubmitHumanReviewDecisionRequest,
): Promise<NextOrchestratorDecisionResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/workflow-runs/${encodeURIComponent(runId)}/human-review/${encodeURIComponent(attemptId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(SubmitHumanReviewDecisionRequest.parse(body)),
    },
    NextOrchestratorDecisionResponse,
    "Submit human review decision failed",
  );
}

export async function getWorkflowDecision(
  goalId: string,
  decisionId: string,
): Promise<WorkflowDecisionResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/workflow-decisions/${encodeURIComponent(decisionId)}`,
    { headers: authHeaders(token) },
    WorkflowDecisionResponse,
    "Get workflow decision failed",
  );
}

export async function getWorkflowStepRun(
  goalId: string,
  stepRunId: string,
): Promise<WorkflowStepRunResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/workflow-step-runs/${encodeURIComponent(stepRunId)}`,
    { headers: authHeaders(token) },
    WorkflowStepRunResponse,
    "Get workflow step run failed",
  );
}

export async function submitWorkflowUserInput(
  goalId: string,
  stepRunId: string,
  body: SubmitWorkflowUserInputRequest,
): Promise<WorkflowStepRunResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/workflow-step-runs/${encodeURIComponent(stepRunId)}/submit-input`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(SubmitWorkflowUserInputRequest.parse(body)),
    },
    WorkflowStepRunResponse,
    "Submit workflow input failed",
  );
}

export async function createWorkflowArtifact(
  goalId: string,
  body: CreateWorkflowArtifactRequest,
): Promise<WorkflowArtifactResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/workflow-artifacts`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(CreateWorkflowArtifactRequest.parse(body)),
    },
    WorkflowArtifactResponse,
    "Create workflow artifact failed",
  );
}

export async function listWorkflowRunArtifacts(
  goalId: string,
  runId: string,
): Promise<ListWorkflowArtifactsResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/workflow-runs/${encodeURIComponent(runId)}/artifacts`,
    { headers: authHeaders(token) },
    ListWorkflowArtifactsResponse,
    "List workflow run artifacts failed",
  );
}

export async function listSessions(goalId: string): Promise<ListSessionsResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/sessions`,
    { headers: authHeaders(token) },
    ListSessionsResponse,
    "List sessions failed",
  );
}

export async function listActivities(goalId: string): Promise<Activity[]> {
  const { baseUrl, token } = await loadConfig();
  const body = await requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/activities`,
    { headers: authHeaders(token) },
    ListActivitiesResponse,
    "List activities failed",
  );
  return body.items;
}

export async function createContextPackage(
  goalId: string,
  request: CreateContextPackageRequest,
): Promise<CreateContextPackageResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/context-packages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(CreateContextPackageRequest.parse(request)),
    },
    CreateContextPackageResponse,
    "Create context package failed",
  );
}

export async function generateTasks(
  goalId: string,
): Promise<TaskGenerationResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/tasks/generate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(TaskGenerationRequest.parse({ trigger: "manual" })),
    },
    TaskGenerationResponse,
    "Generate tasks failed",
  );
}

export async function listTasks(
  goalId: string,
  query?: ListTasksQuery,
): Promise<ListTasksResponse> {
  const { baseUrl, token } = await loadConfig();
  const parsed = ListTasksQuery.parse(query ?? {});
  const url = new URL(`${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/tasks`);
  if (parsed.status !== undefined) {
    url.searchParams.set("status", parsed.status);
  }
  if (parsed.workspaceId !== undefined) {
    url.searchParams.set("workspaceId", parsed.workspaceId);
  }
  if (parsed.role !== undefined) {
    url.searchParams.set("role", parsed.role);
  }
  if (parsed.parentTaskId !== undefined) {
    url.searchParams.set("parentTaskId", parsed.parentTaskId);
  }
  if (query?.includeArchived !== undefined) {
    url.searchParams.set("includeArchived", String(parsed.includeArchived));
  }
  if (query?.limit !== undefined) {
    url.searchParams.set("limit", String(parsed.limit));
  }
  if (parsed.cursor !== undefined) {
    url.searchParams.set("cursor", parsed.cursor);
  }

  return requestJson(
    url.toString(),
    { headers: authHeaders(token) },
    ListTasksResponse,
    "List tasks failed",
  );
}

export async function createTask(
  goalId: string,
  body: CreateTaskRequest,
): Promise<CreateTaskResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/tasks`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(CreateTaskRequest.parse(body)),
    },
    CreateTaskResponse,
    "Create task failed",
  );
}

export async function patchTask(
  id: string,
  patch: UpdateTaskRequest,
): Promise<UpdateTaskResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/tasks/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(UpdateTaskRequest.parse(patch)),
    },
    UpdateTaskResponse,
    "Patch task failed",
  );
}

export async function splitTask(
  id: string,
  body: SplitTaskRequest,
): Promise<SplitTaskResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/tasks/${encodeURIComponent(id)}/split`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(SplitTaskRequest.parse(body)),
    },
    SplitTaskResponse,
    "Split task failed",
  );
}

export async function associateTaskWithSession(
  id: string,
  sessionId: string,
): Promise<AssociateTaskSessionResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/tasks/${encodeURIComponent(id)}/associate-session`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(AssociateTaskSessionRequest.parse({ sessionId })),
    },
    AssociateTaskSessionResponse,
    "Associate task with session failed",
  );
}

export async function generateRecommendations(
  goalId: string,
): Promise<RecommendationGenerationResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/recommendations/generate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(RecommendationGenerationRequest.parse({ trigger: "manual" })),
    },
    RecommendationGenerationResponse,
    "Generate recommendations failed",
  );
}

export async function listRecommendations(
  goalId: string,
  query?: ListRecommendationsQuery,
): Promise<ListRecommendationsResponse> {
  const { baseUrl, token } = await loadConfig();
  const parsed = ListRecommendationsQuery.parse(query ?? {});
  const url = new URL(`${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/recommendations`);
  if (parsed.status !== undefined) {
    url.searchParams.set("status", parsed.status);
  }
  if (parsed.type !== undefined) {
    url.searchParams.set("type", parsed.type);
  }
  if (parsed.relatedTaskId !== undefined) {
    url.searchParams.set("relatedTaskId", parsed.relatedTaskId);
  }
  if (query?.limit !== undefined) {
    url.searchParams.set("limit", String(parsed.limit));
  }
  if (parsed.cursor !== undefined) {
    url.searchParams.set("cursor", parsed.cursor);
  }
  if (query?.includeGenerations !== undefined) {
    url.searchParams.set("includeGenerations", String(parsed.includeGenerations));
  }

  return requestJson(
    url.toString(),
    { headers: authHeaders(token) },
    ListRecommendationsResponse,
    "List recommendations failed",
  );
}

export async function getRecommendation(
  id: string,
): Promise<GetRecommendationResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/recommendations/${encodeURIComponent(id)}`,
    { headers: authHeaders(token) },
    GetRecommendationResponse,
    "Get recommendation failed",
  );
}

export async function acceptRecommendation(
  id: string,
  body: RecommendationFeedbackRequest,
): Promise<AcceptRecommendationResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/recommendations/${encodeURIComponent(id)}/accept`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(RecommendationFeedbackRequest.parse(body)),
    },
    AcceptRecommendationResponse,
    "Accept recommendation failed",
  );
}

export async function rejectRecommendation(
  id: string,
  body: RecommendationFeedbackRequest,
): Promise<RejectRecommendationResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/recommendations/${encodeURIComponent(id)}/reject`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(RecommendationFeedbackRequest.parse(body)),
    },
    RejectRecommendationResponse,
    "Reject recommendation failed",
  );
}

export async function dismissRecommendation(
  id: string,
  body: RecommendationFeedbackRequest,
): Promise<DismissRecommendationResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/recommendations/${encodeURIComponent(id)}/dismiss`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(RecommendationFeedbackRequest.parse(body)),
    },
    DismissRecommendationResponse,
    "Dismiss recommendation failed",
  );
}

export async function modifyRecommendation(
  id: string,
  patch: ModifyRecommendationRequest,
): Promise<ModifyRecommendationResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/recommendations/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(ModifyRecommendationRequest.parse(patch)),
    },
    ModifyRecommendationResponse,
    "Modify recommendation failed",
  );
}

export async function listConflicts(
  goalId: string,
  query?: ListConflictsQuery,
): Promise<ListConflictsResponse> {
  const { baseUrl, token } = await loadConfig();
  const parsed = ListConflictsQuery.parse(query ?? {});
  const url = new URL(`${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/conflicts`);
  if (query?.status !== undefined) {
    url.searchParams.set("status", parsed.status);
  }
  if (parsed.severity !== undefined) {
    url.searchParams.set("severity", parsed.severity);
  }
  if (query?.limit !== undefined) {
    url.searchParams.set("limit", String(parsed.limit));
  }
  if (parsed.cursor !== undefined) {
    url.searchParams.set("cursor", parsed.cursor);
  }

  return requestJson(
    url.toString(),
    { headers: authHeaders(token) },
    ListConflictsResponse,
    "List conflicts failed",
  );
}

export async function resolveConflict(
  id: string,
  body: ResolveConflictRequest,
): Promise<ResolveConflictResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/conflicts/${encodeURIComponent(id)}/resolve`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(ResolveConflictRequest.parse(body)),
    },
    ResolveConflictResponse,
    "Resolve conflict failed",
  );
}

export async function listContextPackages(
  goalId: string,
  query?: ListContextPackagesQuery,
): Promise<ListContextPackagesResponse> {
  const { baseUrl, token } = await loadConfig();
  const parsed = ListContextPackagesQuery.parse(query ?? {});
  const url = new URL(`${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/context-packages`);
  if (parsed.sessionId !== undefined) {
    url.searchParams.set("sessionId", parsed.sessionId);
  }
  if (parsed.adapterId !== undefined) {
    url.searchParams.set("adapterId", parsed.adapterId);
  }
  if (query?.limit !== undefined) {
    url.searchParams.set("limit", String(parsed.limit));
  }

  return requestJson(
    url.toString(),
    { headers: authHeaders(token) },
    ListContextPackagesResponse,
    "List context packages failed",
  );
}

export async function getContextPackage(packageId: string): Promise<GetContextPackageResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/context-packages/${encodeURIComponent(packageId)}`,
    { headers: authHeaders(token) },
    GetContextPackageResponse,
    "Get context package failed",
  );
}

export async function getSession(sessionId: string): Promise<GetSessionResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`,
    { headers: authHeaders(token) },
    GetSessionResponse,
    "Get session failed",
  );
}

export async function createSession(
  goalId: string,
  body: CreateSessionRequest,
): Promise<CreateSessionResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/goals/${encodeURIComponent(goalId)}/sessions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(CreateSessionRequest.parse(body)),
    },
    CreateSessionResponse,
    "Create session failed",
  );
}

export async function startSession(
  sessionId: string,
  body: StartSessionRequest,
): Promise<StartSessionResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/start`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify(StartSessionRequest.parse(body)),
    },
    StartSessionResponse,
    "Start session failed",
  );
}

export async function stopSession(sessionId: string): Promise<StopSessionResponse> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}/stop`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(token),
      },
      body: JSON.stringify({}),
    },
    StopSessionResponse,
    "Stop session failed",
  );
}

export async function getSettings(): Promise<AppSettings> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/settings`,
    { headers: authHeaders(token) },
    AppSettings,
    "Failed to load settings",
  );
}

export async function putSettings(body: PutSettingsRequest): Promise<AppSettings> {
  const { baseUrl, token } = await loadConfig();
  return requestJson(
    `${baseUrl}/v1/settings`,
    {
      method: "PUT",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    AppSettings,
    "Failed to update settings",
  );
}

export async function confirmStep(runId: string): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  await requestVoid(
    `${baseUrl}/v1/workflows/runs/${runId}/confirm-step`,
    { method: "POST", headers: authHeaders(token) },
    "Failed to confirm step",
  );
}

async function postProviderRecovery(
  runId: string,
  action: "wait" | "retry" | "refresh" | "switch",
  body: ProviderRecoveryActionRequest | ProviderRecoverySwitchRequest,
  fallbackMessage: string,
): Promise<void> {
  const { baseUrl, token } = await loadConfig();
  await requestVoid(
    `${baseUrl}/v1/workflows/runs/${encodeURIComponent(runId)}/provider-recovery/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(token) },
      body: JSON.stringify(body),
    },
    fallbackMessage,
  );
}

export async function waitForProviderRecovery(
  runId: string,
  body: ProviderRecoveryActionRequest,
): Promise<void> {
  await postProviderRecovery(runId, "wait", body, "Failed to start provider wait");
}

export async function retryProviderRecovery(
  runId: string,
  body: ProviderRecoveryActionRequest,
): Promise<void> {
  await postProviderRecovery(runId, "retry", body, "Failed to retry provider");
}

export async function refreshProviderRecovery(
  runId: string,
  body: ProviderRecoveryActionRequest,
): Promise<void> {
  await postProviderRecovery(runId, "refresh", body, "Failed to refresh provider recovery");
}

export async function switchProviderRecovery(
  runId: string,
  body: ProviderRecoverySwitchRequest,
): Promise<void> {
  await postProviderRecovery(runId, "switch", body, "Failed to switch provider");
}

export type ConnectionStatus = "connecting" | "open" | "closed";

interface EventStreamHandlers {
  onEvent(event: DomainEvent): void;
  onStatus(status: ConnectionStatus): void;
}

export function openEventStream(handlers: EventStreamHandlers): {
  close(): void;
} {
  const { onEvent, onStatus } = handlers;
  let ws: WebSocket | null = null;
  let stopped = false;

  async function connect() {
    if (stopped) return;
    const { baseUrl, token } = await loadConfig();
    if (stopped) return;

    const wsBase = baseUrl.replace(/^http/, "ws");
    const url = new URL(`${wsBase}/v1/events`);
    if (token) url.searchParams.set("token", token);

    onStatus("connecting");
    ws = new WebSocket(url.toString());

    ws.addEventListener("open", () => {
      onStatus("open");
    });

    ws.addEventListener("message", (ev) => {
      try {
        const event = DomainEvent.parse(JSON.parse(ev.data as string));
        onEvent(event);
      } catch {
        // ignore malformed events
      }
    });

    ws.addEventListener("close", () => {
      if (!stopped) {
        onStatus("closed");
        setTimeout(() => {
          void connect();
        }, 1000);
      }
    });

    ws.addEventListener("error", () => {
      ws?.close();
    });
  }

  void connect();

  return {
    close() {
      stopped = true;
      ws?.close();
      onStatus("closed");
    },
  };
}

export type SessionClientFrame =
  | SessionSubscribeFrameData
  | SessionUnsubscribeFrameData
  | SessionInputFrameData
  | SessionResizeFrameData;

export type SessionServerFrame = SessionOutputFrameData | SessionErrorFrameData;

interface SessionStreamHandlers {
  onOpen(): void;
  onFrame(frame: SessionServerFrame): void;
  onStatus(status: ConnectionStatus): void;
}

function parseSessionServerFrame(data: unknown): SessionServerFrame | null {
  if (typeof data !== "object" || data === null || !("type" in data)) return null;
  const type = (data as Record<string, unknown>).type;
  if (type === "session.output") {
    const result = SessionOutputFrame.safeParse(data);
    return result.success ? result.data : null;
  }
  if (type === "session.error") {
    const result = SessionErrorFrame.safeParse(data);
    return result.success ? result.data : null;
  }
  return null;
}

export function openSessionStream(handlers: SessionStreamHandlers): {
  send(frame: SessionClientFrame): boolean;
  close(): void;
} {
  const { onOpen, onFrame, onStatus } = handlers;
  let ws: WebSocket | null = null;
  let stopped = false;

  async function connect() {
    if (stopped) return;
    const { baseUrl, token } = await loadConfig();
    if (stopped) return;

    const wsBase = baseUrl.replace(/^http/, "ws");
    const url = new URL(`${wsBase}/v1/events`);
    if (token) url.searchParams.set("token", token);

    onStatus("connecting");
    ws = new WebSocket(url.toString());

    ws.addEventListener("open", () => {
      onStatus("open");
      onOpen();
    });

    ws.addEventListener("message", (ev) => {
      try {
        const frame = parseSessionServerFrame(JSON.parse(ev.data as string));
        if (frame !== null) onFrame(frame);
      } catch {
        // ignore malformed session frames
      }
    });

    ws.addEventListener("close", () => {
      if (!stopped) {
        onStatus("closed");
        setTimeout(() => {
          void connect();
        }, 1000);
      }
    });

    ws.addEventListener("error", () => {
      ws?.close();
    });
  }

  void connect();

  return {
    send(frame: SessionClientFrame) {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(frame));
      return true;
    },
    close() {
      stopped = true;
      ws?.close();
      onStatus("closed");
    },
  };
}

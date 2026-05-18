import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  AttachWorkspaceRequest,
  AttachWorkspaceResponse,
  GoalDetailResponse,
  HealthResponse,
  InspectWorkspaceRequest,
  InspectWorkspaceResponse,
  ListGoalsResponse,
  ListPluginsResponse,
  ListSkillsResponse,
  CreateGoalRequest,
  CreateGoalResponse,
  RefineGoalRequest,
  RefineGoalResponse,
  UpdateGoalRequest,
  UpdateGoalResponse,
  ArchiveGoalResponse,
  DomainEvent,
  type PluginSummary,
  type SkillSummary,
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

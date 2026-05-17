import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  HealthResponse,
  ListGoalsResponse,
  ListPluginsResponse,
  ListSkillsResponse,
  CreateGoalRequest,
  CreateGoalResponse,
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
  const res = await fetch(`${baseUrl}/v1/goals`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(token),
    },
    body: JSON.stringify(CreateGoalRequest.parse(input)),
  });
  return parseResponse(res, CreateGoalResponse);
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

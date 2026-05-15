import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  HealthResponse,
  ListGoalsResponse,
  CreateGoalRequest,
  CreateGoalResponse,
  DomainEvent,
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

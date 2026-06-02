export type ModelProviderId = "orca/anthropic" | "orca/openai";

export interface ModelCompletionRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchemaName: string;
  responseSchema: unknown;
  maxOutputTokens?: number;
  temperature?: number;
  callMetadata: {
    goalId?: string;
    workflowRunId?: string;
    stepRunId?: string;
    decisionId?: string;
  };
}

export interface ModelCompletionResponse<T = unknown> {
  parsed: T;
  rawTextLength: number;
  usageTokensInput?: number;
  usageTokensOutput?: number;
  latencyMs: number;
  providerVersion: string;
}

export interface ModelProvider {
  readonly id: ModelProviderId;
  readonly displayName: string;
  readonly version: string;
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  listModels(): Promise<Array<{ id: string; displayName: string; capabilities: string[] }>>;
  complete<T>(req: ModelCompletionRequest): Promise<ModelCompletionResponse<T>>;
}

export type ProviderFailureCode =
  | "missing_api_key"
  | "provider_error"
  | "invalid_output"
  | "rate_limited"
  | "timeout"
  | "internal_error";

export class ProviderError extends Error {
  constructor(
    public readonly code: ProviderFailureCode,
    message: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

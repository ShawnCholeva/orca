export function agentHookUrl(port: number, sessionId: string, failure = false): string {
  const base = `http://127.0.0.1:${port}/v1/agent-hooks/stop?sessionId=${encodeURIComponent(sessionId)}`;
  return failure ? `${base}&failure=1` : base;
}

export function elicitHookUrl(port: number, sessionId: string): string {
  return `http://127.0.0.1:${port}/v1/agent-hooks/elicit?sessionId=${encodeURIComponent(sessionId)}`;
}

interface HttpHook {
  type: "http";
  url: string;
  headers: Record<string, string>;
}

export interface AgentHookSettings {
  hooks: {
    Stop: Array<{ hooks: HttpHook[] }>;
    StopFailure: Array<{ hooks: HttpHook[] }>;
    PreToolUse?: Array<{ matcher: string; hooks: HttpHook[] }>;
  };
}

export function buildAgentHookSettings(args: {
  sessionId: string;
  port: number;
  authToken: string;
}): AgentHookSettings {
  const headers = { Authorization: `Bearer ${args.authToken}` };
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "http", url: agentHookUrl(args.port, args.sessionId, false), headers }] }],
      StopFailure: [{ hooks: [{ type: "http", url: agentHookUrl(args.port, args.sessionId, true), headers }] }],
      PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ type: "http", url: elicitHookUrl(args.port, args.sessionId), headers }] }],
    },
  };
}

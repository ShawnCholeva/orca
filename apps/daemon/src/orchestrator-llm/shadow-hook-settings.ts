export function shadowHookUrl(port: number, goalId: string, failure = false): string {
  const base = `http://127.0.0.1:${port}/v1/orchestrator-hooks/stop?goalId=${encodeURIComponent(goalId)}`;
  return failure ? `${base}&failure=1` : base;
}

interface HttpHook {
  type: "http";
  url: string;
  headers: Record<string, string>;
}

export interface ShadowHookSettings {
  hooks: {
    Stop: Array<{ hooks: HttpHook[] }>;
    StopFailure: Array<{ hooks: HttpHook[] }>;
  };
}

export function buildShadowHookSettings(args: {
  goalId: string;
  port: number;
  authToken: string;
}): ShadowHookSettings {
  // The hook endpoint sits behind the daemon's Bearer auth; without this header
  // Claude's http hook POST is rejected 401 and the reply is never delivered.
  const headers = { Authorization: `Bearer ${args.authToken}` };
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "http", url: shadowHookUrl(args.port, args.goalId, false), headers }] }],
      StopFailure: [{ hooks: [{ type: "http", url: shadowHookUrl(args.port, args.goalId, true), headers }] }],
    },
  };
}

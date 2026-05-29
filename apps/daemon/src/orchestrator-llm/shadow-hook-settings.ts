export function shadowHookUrl(port: number, goalId: string, failure = false): string {
  const base = `http://127.0.0.1:${port}/v1/orchestrator-hooks/stop?goalId=${encodeURIComponent(goalId)}`;
  return failure ? `${base}&failure=1` : base;
}

export interface ShadowHookSettings {
  hooks: {
    Stop: Array<{ hooks: Array<{ type: "http"; url: string }> }>;
    StopFailure: Array<{ hooks: Array<{ type: "http"; url: string }> }>;
  };
}

export function buildShadowHookSettings(args: { goalId: string; port: number }): ShadowHookSettings {
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "http", url: shadowHookUrl(args.port, args.goalId, false) }] }],
      StopFailure: [{ hooks: [{ type: "http", url: shadowHookUrl(args.port, args.goalId, true) }] }],
    },
  };
}

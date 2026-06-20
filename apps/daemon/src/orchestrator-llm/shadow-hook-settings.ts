function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_/.:=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function resolverCmd(prefix: string[], relUrl: string, spool: boolean): string {
  const parts = [...prefix, "hook", relUrl, ...(spool ? ["--spool"] : [])];
  return parts.map(shellQuote).join(" ");
}

interface CommandHook {
  type: "command";
  command: string;
}

export interface ShadowHookSettings {
  hooks: {
    Stop: Array<{ hooks: CommandHook[] }>;
    StopFailure: Array<{ hooks: CommandHook[] }>;
  };
}

export function buildShadowHookSettings(args: {
  goalId: string;
  resolverCommand: string[];
}): ShadowHookSettings {
  const gid = encodeURIComponent(args.goalId);
  const cmd = (relUrl: string, spool: boolean) => resolverCmd(args.resolverCommand, relUrl, spool);
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: cmd(`/v1/shadow-hooks/stop?goalId=${gid}`, true) }] }],
      StopFailure: [{ hooks: [{ type: "command", command: cmd(`/v1/shadow-hooks/stop?goalId=${gid}&failure=1`, true) }] }],
    },
  };
}

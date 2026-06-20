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
  timeout?: number;
}

export interface AgentHookSettings {
  hooks: {
    Stop: Array<{ hooks: CommandHook[] }>;
    StopFailure: Array<{ hooks: CommandHook[] }>;
    PreToolUse?: Array<{ matcher: string; hooks: CommandHook[] }>;
    PermissionRequest?: Array<{ matcher: string; hooks: CommandHook[] }>;
  };
}

export function buildAgentHookSettings(args: {
  sessionId: string;
  resolverCommand: string[];
}): AgentHookSettings {
  const sid = encodeURIComponent(args.sessionId);
  const cmd = (relUrl: string, spool: boolean) => resolverCmd(args.resolverCommand, relUrl, spool);
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: cmd(`/v1/agent-hooks/stop?sessionId=${sid}`, true) }] }],
      StopFailure: [{ hooks: [{ type: "command", command: cmd(`/v1/agent-hooks/stop?sessionId=${sid}&failure=1`, true) }] }],
      PreToolUse: [
        { matcher: "AskUserQuestion", hooks: [{ type: "command", command: cmd(`/v1/agent-hooks/elicit?sessionId=${sid}`, false), timeout: 600 }] },
        { matcher: "*", hooks: [{ type: "command", command: cmd(`/v1/agent-hooks/tool-use?sessionId=${sid}`, true), timeout: 5 }] },
      ],
      PermissionRequest: [
        { matcher: "*", hooks: [{ type: "command", command: cmd(`/v1/agent-hooks/permission?sessionId=${sid}`, false), timeout: 1800 }] },
      ],
    },
  };
}

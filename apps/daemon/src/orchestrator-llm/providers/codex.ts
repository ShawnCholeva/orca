import { extractActionBlock } from "../sentinel.js";
import type {
  ShadowCaptureMode,
  ShadowHookConfig,
  ShadowLaunch,
  ShadowProvider,
  ShadowTurnParse,
} from "./types.js";
import type { TmuxRunner } from "../../tmux/runner.js";

const CODEX_MODEL_SWITCH_PROMPT = /approaching rate limits[\s\S]*switch to .*for lower credit usage/i;
const CODEX_USAGE_LIMIT =
  /hit your usage limit|less than \d+% of your 5h limit|purchase more credits|try again at \d{1,2}:\d{2}\s*(?:AM|PM)?/i;
const CODEX_AUTH_LOST =
  /\bnot\s+(?:signed|logged)\s+in\b|\blogin required\b|\bauth(?:entication)?\s+(?:required|expired|failed)\b/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CodexShadowProvider implements ShadowProvider {
  readonly id = "codex" as const;
  readonly displayName = "Codex";
  readonly modelProviderId = "orca/openai";
  readonly supportsPermissionPersistence = false;

  launch(deps: { binOverride?: string }): ShadowLaunch {
    return { bin: deps.binOverride ?? process.env["ORCA_CODEX_BIN"] ?? "codex" };
  }

  hookConfig(args: { goalId: string; port: number; authToken: string }): ShadowHookConfig {
    return {
      files: [
        { relPath: ".codex/config.toml", contents: "[features]\nhooks = true\n" },
        {
          relPath: ".codex/hooks.json",
          contents: JSON.stringify(buildCodexHookSettings(args), null, 2),
        },
      ],
    };
  }

  workerHookConfig(args: { goalId: string; sessionId: string; port: number; authToken: string; configDir: string }) {
    // CODEX_HOME points Codex at this private dir; config.toml + hooks.json live at
    // its root (CODEX_HOME *is* the codex home, so no `.codex/` prefix here).
    return {
      files: [
        { relPath: "config.toml", contents: "[features]\nhooks = true\n" },
        {
          relPath: "hooks.json",
          contents: JSON.stringify(buildCodexWorkerHookSettings(args), null, 2),
        },
      ],
      spawnArgs: [],
      env: { CODEX_HOME: args.configDir },
    };
  }

  permissionRule(_toolName: string, _toolInput: unknown): string | null {
    return null;
  }

  writePermissionRule(_workspacePath: string, _rule: string): void {
    // No native permission-rule writer for this provider yet (future phase).
  }

  captureMode(): ShadowCaptureMode {
    return { kind: "hook" };
  }

  turnParser(): ShadowTurnParse {
    return {
      parseAction: (turnText) => {
        const action = extractActionBlock(turnText);
        if (action !== null) return action;
        return extractCodexPaneAction(turnText);
      },
      detectError: (turnText) => {
        if (CODEX_USAGE_LIMIT.test(turnText)) {
          return new Error("codex usage limit reached; retry when Codex quota resets");
        }
        if (CODEX_AUTH_LOST.test(turnText)) {
          return new Error("codex authentication required; run codex login");
        }
        return null;
      },
    };
  }

  async beforeSubmit(ctx: {
    tmux: TmuxRunner;
    sessionName: string;
    dbg: (msg: string) => void;
  }): Promise<void> {
    const pane = (await ctx.tmux.run(["capture-pane", "-t", ctx.sessionName, "-p"])).stdout;
    if (!CODEX_MODEL_SWITCH_PROMPT.test(pane)) return;
    await ctx.tmux.run(["send-keys", "-t", ctx.sessionName, "2"]);
    await ctx.tmux.run(["send-keys", "-t", ctx.sessionName, "Enter"]);
    ctx.dbg("codex model-switch prompt dismissed (keep current model)");
    await sleep(250);
  }
}

function buildCodexHookSettings(args: { goalId: string; port: number; authToken: string }): unknown {
  const commandFor = (failure: boolean) => [
    "curl",
    "-fsS",
    "-X", "POST",
    "-H", shellArg(`Authorization: Bearer ${args.authToken}`),
    "-H", shellArg("Content-Type: application/json"),
    "--data-binary", "@-",
    shellArg(
      `http://127.0.0.1:${args.port}/v1/shadow-hooks/stop?goalId=${encodeURIComponent(args.goalId)}${failure ? "&failure=1" : ""}`,
    ),
  ].join(" ");
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: commandFor(false) }] }],
      StopFailure: [{ hooks: [{ type: "command", command: commandFor(true) }] }],
    },
  };
}

function buildCodexWorkerHookSettings(args: {
  sessionId: string;
  port: number;
  authToken: string;
}): unknown {
  const sid = encodeURIComponent(args.sessionId);
  const auth = `Authorization: Bearer ${args.authToken}`;
  const stopCommand = (failure: boolean) => [
    "curl",
    "-fsS",
    "-X", "POST",
    "-H", shellArg(auth),
    "-H", shellArg("Content-Type: application/json"),
    "--data-binary", "@-",
    shellArg(`http://127.0.0.1:${args.port}/v1/agent-hooks/stop?sessionId=${sid}${failure ? "&failure=1" : ""}`),
  ].join(" ");

  // Codex omits tool_use_id on PermissionRequest (verified codex-cli 0.136.0). The
  // shared store dedups purely on toolUseId, so an empty id would collide across the
  // concurrent worker sessions. Inject a stable correlation id before forwarding.
  // session_id + turn_id alone is NOT enough: turn_id is turn-scoped, so two distinct
  // permission requests in one turn would synthesize the same id and the store would
  // silently reuse the first request's decision (an "allow" could auto-allow a different
  // tool, breaking safe-by-default). We append a sha1 digest of tool_name + tool_input
  // so distinct tool calls get distinct ids, while a genuine retry of the identical call
  // still dedups (mirroring Claude's per-tool-call tool_use_id). node + crypto are
  // guaranteed in this monorepo; jq is not.
  const relay =
    "const c=[];process.stdin.on('data',d=>c.push(d));" +
    "process.stdin.on('end',()=>{let b={};try{b=JSON.parse(Buffer.concat(c).toString('utf8')||'{}')}catch{};" +
    "const sig=require('crypto').createHash('sha1').update(String(b.tool_name||'')+JSON.stringify(b.tool_input||{})).digest('hex').slice(0,12);" +
    "b.tool_use_id=String(b.session_id||'')+':'+String(b.turn_id||'')+':'+sig;" +
    "process.stdout.write(JSON.stringify(b))});";
  const permCommand = [
    "node", "-e", shellArg(relay),
    "|",
    "curl",
    "-fsS",
    "-X", "POST",
    "-H", shellArg(auth),
    "-H", shellArg("Content-Type: application/json"),
    "--data-binary", "@-",
    shellArg(`http://127.0.0.1:${args.port}/v1/agent-hooks/permission?sessionId=${sid}`),
  ].join(" ");

  return {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: stopCommand(false) }] }],
      StopFailure: [{ hooks: [{ type: "command", command: stopCommand(true) }] }],
      PermissionRequest: [{ hooks: [{ type: "command", command: permCommand }] }],
    },
  };
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function extractCodexPaneAction(output: string): string | null {
  const starts = [...output.matchAll(/(?:^|\n)\s*•\s*\{/g)];
  for (let i = starts.length - 1; i >= 0; i--) {
    const match = starts[i];
    if (match?.index === undefined) continue;
    const braceStart = output.indexOf("{", match.index);
    if (braceStart < 0) continue;
    const raw = output.slice(braceStart);
    const promptIdx = raw.search(/\n\s*›/);
    const nextBulletIdx = raw.slice(1).search(/\n\s*•\s*\{/) + 1;
    const endCandidates = [promptIdx, nextBulletIdx].filter((idx) => idx > 0);
    const candidate = raw
      .slice(0, endCandidates.length > 0 ? Math.min(...endCandidates) : undefined)
      .trim();
    const compact = candidate.replace(/\n\s*/g, " ");
    const end = compact.lastIndexOf("}");
    if (end < 0) continue;
    const json = compact.slice(0, end + 1);
    try {
      JSON.parse(json);
      return json;
    } catch {
      continue;
    }
  }
  return null;
}

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

  captureMode(): ShadowCaptureMode {
    return { kind: "pane-poll", intervalMs: 1000 };
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

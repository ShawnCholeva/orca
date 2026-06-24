import { homedir } from "node:os";
import { join } from "node:path";
import { extractActionBlock } from "../sentinel.js";
import type {
  ProviderTerminalFailure,
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
    // Bypass the interactive hook-trust review for the daemon-authored hooks.json so
    // the Stop hook fires unattended (otherwise turn capture never reaches the daemon).
    // The shadow session can't reliably pane-answer Codex's multi-step trust menu.
    return {
      bin: deps.binOverride ?? process.env["ORCA_CODEX_BIN"] ?? "codex",
      args: ["--dangerously-bypass-hook-trust"],
    };
  }

  hookConfig(args: { goalId: string; resolverCommand: string[] }): ShadowHookConfig {
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

  workerHookConfig(args: { goalId: string; sessionId: string; resolverCommand: string[]; configDir: string; otlpBaseUrl?: string; authToken?: string }) {
    // CODEX_HOME points Codex at this private dir; config.toml + hooks.json live at
    // its root (CODEX_HOME *is* the codex home, so no `.codex/` prefix here).
    const codexHome = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
    // When the daemon threads its loopback OTLP base + token, append the OTEL exporter
    // block so Codex POSTs token-usage logs to the daemon receiver. codex 0.139.0
    // REJECTS the flat `exporter = "otlp-http"` form — the working schema is the
    // struct/table `[otel.exporter."otlp-http"]`. Codex posts to the endpoint VERBATIM
    // (it does NOT append /v1/logs), so give it the full /v1/logs path. Orca's ids are
    // injected via OTEL_RESOURCE_ATTRIBUTES env (Codex honors the standard OTEL SDK env)
    // so the parser can key cost back to the session (verified: Task 3 OTEL spike).
    const otelEnabled = Boolean(args.otlpBaseUrl && args.authToken);
    const configToml = otelEnabled
      ? `[features]\nhooks = true\n\n[otel]\nlog_user_prompt = false\n\n[otel.exporter."otlp-http"]\nendpoint = "${args.otlpBaseUrl}/v1/logs"\nprotocol = "json"\n`
      : "[features]\nhooks = true\n";
    return {
      files: [
        { relPath: "config.toml", contents: configToml },
        {
          relPath: "hooks.json",
          contents: JSON.stringify(buildCodexWorkerHookSettings(args), null, 2),
        },
      ],
      // Redirecting CODEX_HOME also relocates where Codex reads credentials, so copy
      // the user's real auth.json into the private home — otherwise the worker shows
      // Codex's sign-in screen and never becomes idle. (Verified codex-cli 0.136.0.)
      copyFiles: [{ relPath: "auth.json", sourcePath: join(codexHome, "auth.json") }],
      // The worker runs unattended, so bypass the interactive hook-trust review for
      // the daemon-authored hooks.json (the daemon vets its own hook sources). Without
      // this the Stop/PermissionRequest hooks never fire. (Folder trust is auto-answered
      // by the worker startup pane handler.)
      spawnArgs: ["--dangerously-bypass-hook-trust"],
      env: {
        CODEX_HOME: args.configDir,
        ...(otelEnabled
          ? { OTEL_RESOURCE_ATTRIBUTES: `orca.session.id=${args.sessionId},orca.goal.id=${args.goalId}` }
          : {}),
      },
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
      detectError: (turnText): ProviderTerminalFailure | null => {
        if (CODEX_USAGE_LIMIT.test(turnText)) {
          return {
            code: "usage_limit",
            message: "codex usage limit reached; retry when Codex quota resets",
            resetTimeText: null,
            resetAt: null,
            timezone: null,
          };
        }
        if (CODEX_AUTH_LOST.test(turnText)) {
          return {
            code: "authentication_required",
            message: "codex authentication required; run codex login",
            resetTimeText: null,
            resetAt: null,
            timezone: null,
          };
        }
        return null;
      },
      detectTurnStarted: (text) => /esc to interrupt|working/i.test(text),
    };
  }

  async waitForLimitReset(_ctx: {
    tmux: TmuxRunner;
    sessionName: string;
    dbg: (msg: string) => void;
  }): Promise<void> {
    // Codex does not support interactive reset dismissal; no-op.
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

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_/.:=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function resolverCmd(prefix: string[], relUrl: string, spool: boolean): string {
  const parts = [...prefix, "hook", relUrl, ...(spool ? ["--spool"] : [])];
  return parts.map(shellQuote).join(" ");
}

function buildCodexHookSettings(args: { goalId: string; resolverCommand: string[] }): unknown {
  const gid = encodeURIComponent(args.goalId);
  const cmd = (relUrl: string, spool: boolean) => resolverCmd(args.resolverCommand, relUrl, spool);
  return {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: cmd(`/v1/shadow-hooks/stop?goalId=${gid}`, true) }] }],
      StopFailure: [{ hooks: [{ type: "command", command: cmd(`/v1/shadow-hooks/stop?goalId=${gid}&failure=1`, true) }] }],
    },
  };
}

function buildCodexWorkerHookSettings(args: {
  sessionId: string;
  resolverCommand: string[];
}): unknown {
  const sid = encodeURIComponent(args.sessionId);
  const cmd = (relUrl: string, spool: boolean) => resolverCmd(args.resolverCommand, relUrl, spool);

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
  // Permission needs the tool_use_id correlated onto stdin before the resolver, so it goes through a small node relay instead of the plain cmd() helper.
  const permResolverCmd = args.resolverCommand.map(shellQuote).join(" ");
  const permCommand = [
    "node", "-e", shellQuote(relay),
    "|",
    permResolverCmd, "hook",
    shellQuote(`/v1/agent-hooks/permission?sessionId=${sid}`),
  ].join(" ");

  return {
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: cmd(`/v1/agent-hooks/stop?sessionId=${sid}`, true) }] }],
      StopFailure: [{ hooks: [{ type: "command", command: cmd(`/v1/agent-hooks/stop?sessionId=${sid}&failure=1`, true) }] }],
      // timeout mirrors the Claude PermissionRequest hook (1800s): the hook blocks the
      // turn while the daemon awaits the operator's decision, so it must outlast a human.
      PermissionRequest: [{ hooks: [{ type: "command", command: permCommand, timeout: 1800 }] }],
    },
  };
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

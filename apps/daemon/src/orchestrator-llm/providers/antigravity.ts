import { extractActionBlock } from "../sentinel.js";
import type {
  ShadowCaptureMode,
  ShadowHookConfig,
  ShadowLaunch,
  ShadowProvider,
  ShadowTurnParse,
} from "./types.js";

const AUTH_OR_QUOTA =
  /\bnot\s+(?:signed|logged)\s+in\b|\bauth(?:entication)?\s+(?:required|expired|failed)\b|\brate limit\b|\bquota\b|\busage limit\b/i;

export class AntigravityShadowProvider implements ShadowProvider {
  readonly id = "antigravity" as const;
  readonly displayName = "Antigravity";
  readonly modelProviderId = "orca/google";

  launch(deps: { binOverride?: string }): ShadowLaunch {
    return { bin: deps.binOverride ?? process.env["ORCA_ANTIGRAVITY_BIN"] ?? "agy" };
  }

  hookConfig(args: { goalId: string; port: number; authToken: string }): ShadowHookConfig {
    return {
      files: [
        {
          relPath: ".agents/hooks.json",
          contents: JSON.stringify(buildAntigravityHookSettings(), null, 2),
        },
        {
          relPath: ".agents/orca-stop-hook.cjs",
          contents: buildStopHookRelay(args),
        },
      ],
    };
  }

  captureMode(): ShadowCaptureMode {
    return { kind: "hook" };
  }

  turnParser(): ShadowTurnParse {
    return {
      parseAction: (turnText) => extractActionBlock(turnText) ?? extractXmlActionBlock(turnText),
      detectError: (turnText) => {
        if (AUTH_OR_QUOTA.test(turnText)) return new Error("antigravity auth, quota, or usage failure");
        return null;
      },
    };
  }
}

function extractXmlActionBlock(text: string): string | null {
  const matches = [...text.matchAll(/<orca:action>([\s\S]*?)<\/orca:action>/g)];
  const last = matches.at(-1);
  return last?.[1]?.trim() || null;
}

function buildAntigravityHookSettings(): unknown {
  return {
    "orca-shadow-stop": {
      Stop: [
        {
          type: "command",
          command: "node .agents/orca-stop-hook.cjs",
          timeout: 10,
        },
      ],
    },
  };
}

function buildStopHookRelay(args: { goalId: string; port: number; authToken: string }): string {
  const url = `http://127.0.0.1:${args.port}/v1/shadow-hooks/stop?goalId=${encodeURIComponent(args.goalId)}`;
  const token = args.authToken.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
  return `const fs = require("node:fs");

const ORCA_URL = \`${url}\`;
const ORCA_TOKEN = \`${token}\`;

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", async () => {
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};
    const failure = Boolean(input.error) || input.fullyIdle === false || input.terminationReason === "error";
    const text = failure ? String(input.error || input.terminationReason || "antigravity stop failure") : readLatestAssistantText(input.transcriptPath);
    const target = failure ? ORCA_URL + "&failure=1" : ORCA_URL;
    await fetch(target, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + ORCA_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ last_assistant_message: text }),
    });
    process.stdout.write(JSON.stringify({ decision: "allow" }));
  } catch (err) {
    await fetch(ORCA_URL + "&failure=1", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + ORCA_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ last_assistant_message: err instanceof Error ? err.message : String(err) }),
    }).catch(() => undefined);
    process.stdout.write(JSON.stringify({ decision: "allow" }));
  }
});

function readLatestAssistantText(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== "string") return "";
  const rawTranscript = fs.readFileSync(transcriptPath, "utf8");
  const lines = rawTranscript.trim().split(/\\r?\\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      const text = textFromEntry(entry);
      if (text) return text;
    } catch {
      continue;
    }
  }
  return "";
}

function textFromEntry(entry) {
  const candidates = [
    entry?.assistant,
    entry?.message,
    entry?.content,
    entry?.text,
    entry?.modelMessage,
    entry?.model_message,
  ];
  if (entry?.role && !/assistant|model/i.test(String(entry.role))) return "";
  for (const candidate of candidates) {
    const text = normalizeText(candidate);
    if (text) return text;
  }
  return "";
}

function normalizeText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(normalizeText).filter(Boolean).join("\\n");
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return normalizeText(value.content);
    if (typeof value.message === "string") return value.message;
  }
  return "";
}
`;
}

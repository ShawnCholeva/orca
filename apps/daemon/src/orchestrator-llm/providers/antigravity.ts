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

  workerHookConfig(_args: { goalId: string; sessionId: string; port: number; authToken: string; configDir: string }) {
    return { files: [], spawnArgs: [] };
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
  return `const fs = require("node:fs");

const ORCA_URL = ${JSON.stringify(url)};
const ORCA_TOKEN = ${JSON.stringify(args.authToken)};

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
  if (!transcriptPath || typeof transcriptPath !== "string") throw new Error("missing transcriptPath");
  const rawTranscript = fs.readFileSync(transcriptPath, "utf8");
  const lines = rawTranscript.trim().split(/\\r?\\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseTranscriptLine(lines[i], i + 1);
    const text = textFromEntry(entry);
    if (text) return text;
  }
  return "";
}

function parseTranscriptLine(line, lineNumber) {
  try {
    return JSON.parse(line);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error("malformed transcript entry at line " + lineNumber + ": " + message);
  }
}

function textFromEntry(entry) {
  const discriminatorFields = ["role", "type", "kind", "source"];
  let hasDiscriminator = false;
  let hasAssistantDiscriminator = false;
  for (const field of discriminatorFields) {
    if (!Object.prototype.hasOwnProperty.call(entry ?? {}, field)) continue;
    hasDiscriminator = true;
    const discriminator = String(entry[field]).toLowerCase();
    if (/^(user|tool|system|human|function)$/.test(discriminator)) return "";
    if (/^(assistant|model|agent)$/.test(discriminator)) hasAssistantDiscriminator = true;
  }
  if (hasDiscriminator && !hasAssistantDiscriminator) return "";

  const candidates = hasAssistantDiscriminator
    ? [
        entry?.assistant,
        entry?.message,
        entry?.content,
        entry?.text,
        entry?.modelMessage,
        entry?.model_message,
      ]
    : [
        entry?.assistant,
        entry?.modelMessage,
        entry?.model_message,
      ];
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

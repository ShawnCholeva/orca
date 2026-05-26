import {
  WORKFLOW_FAILURE_MAX_MESSAGE_CHARS,
  type AdapterId,
  type ModelProviderId,
  type OrchestrationRequest,
} from "@orca/contracts";

import { sanitizeOutput } from "../../../../readiness/sanitize.js";
import type { ProviderHiddenWorkerDriver } from "./registry.js";

const PROVIDER_ID: ModelProviderId = "orca/anthropic";
const ADAPTER_ID: AdapterId = "claude-code";
const PROPOSAL_START = "<ORCA_PROPOSAL>";
const PROPOSAL_END = "</ORCA_PROPOSAL>";

const READY_PATTERN =
  /\bclaude(?:\s+code)?\s+ready\b|(?:^|\n)\s*(?:claude[>:]|>)\s*$/im;
const AUTH_PATTERN =
  /\bauth(?:entication)?\s+(?:required|failed|expired)\b|\blog(?:\s|-)?in\s+(?:required|needed)\b|\bnot\s+(?:signed|logged)\s+in\b/i;
const RATE_LIMIT_PATTERN =
  /\brate.?limit(?:ed|ing)?\b|\bquota\b|\btoo many requests\b|\binsufficient_quota\b|\b429\b/i;
const PERMISSION_PATTERN =
  /\bpermission\b|\bapproval\b|\ballow\b.+\btool\b|\brequires?\s+approval\b/i;

function sanitizeDebug(output: string, fallback: string): string {
  const summary = sanitizeOutput(output).replace(/\s+/g, " ").trim();
  const bounded = summary.slice(0, WORKFLOW_FAILURE_MAX_MESSAGE_CHARS);
  return bounded.length > 0 ? bounded : fallback;
}

function extractProposalSection(output: string): string | null {
  const start = output.indexOf(PROPOSAL_START);
  if (start < 0) return null;
  const end = output.indexOf(PROPOSAL_END, start + PROPOSAL_START.length);
  if (end < 0) return null;
  return output.slice(start + PROPOSAL_START.length, end).trim();
}

function buildRequestInput(request: OrchestrationRequest): string {
  return [
    "ORCA_WORKER_REQUEST_V1",
    "You are an Orca hidden orchestration worker using Claude Code.",
    "Return exactly one proposal envelope wrapped by <ORCA_PROPOSAL> and </ORCA_PROPOSAL>.",
    `The envelope must have {"orcaProposalVersion":1,"kind":"${request.kind}","payload":{...}}.`,
    "Do not output any additional prose outside the proposal boundary.",
    JSON.stringify(request),
    "",
  ].join("\n");
}

export const claudeHiddenWorkerDriver: ProviderHiddenWorkerDriver = {
  providerId: PROVIDER_ID,
  adapterId: ADAPTER_ID,
  hookConfigScope: "worker",
  buildHookConfigInput(input) {
    return {
      providerId: PROVIDER_ID,
      adapterId: ADAPTER_ID,
      workerId: input.workerId,
      attemptId: input.attemptId,
      configScope: "worker",
    };
  },
  buildRequestInput,
  detectReady(output) {
    return READY_PATTERN.test(output);
  },
  detectAuthLost(output) {
    return AUTH_PATTERN.test(output);
  },
  detectRateLimited(output) {
    return RATE_LIMIT_PATTERN.test(output);
  },
  detectPermissionPrompt(output) {
    return PERMISSION_PATTERN.test(output);
  },
  extractProposalOutput(output) {
    return extractProposalSection(output);
  },
  summarizeDebug(output, fallback = "claude worker output unavailable") {
    return sanitizeDebug(output, fallback);
  },
};

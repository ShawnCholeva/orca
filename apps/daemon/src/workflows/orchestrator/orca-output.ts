import { StepCompletionEnvelope } from "@orca/contracts";
import type { LedgerUpdate } from "@orca/contracts";

const CONVENTION = [
  "",
  "When finished, emit your structured result as a single fenced block:",
  "```orca-output",
  "{ ...JSON matching the requested outputSchema... }",
  "```",
].join("\n");

export function augmentInstructionsWithOutputConvention(instructions: string): string {
  if (instructions.includes("```orca-output")) return instructions;
  return `${instructions}\n${CONVENTION}`;
}

const BLOCK_RE = /```orca-output\s*\n([\s\S]*?)```/g;

export function parseOrcaOutputBlock(text: string): unknown | null {
  BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = BLOCK_RE.exec(text)) !== null) last = match[1] ?? null;
  if (last === null) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

/**
 * Did the agent CLAIM its step is complete? Presence of the fence, not the
 * validity of its JSON — a malformed completion block is still a completion
 * claim, and the judge still reviews it as one.
 *
 * This exists so the live phase label can tell the truth about what the
 * orchestrator is doing. The phase used to be set to "reviewing" (surfaced as
 * "Reviewing the step output…") unconditionally at the top of
 * onAgentResponseDone — but that runs whenever a worker's TURN ends, and a turn
 * can end with a question, an observation, or a request for guidance. The judge's
 * verdict is one of nine actions, several of which produce another question. So
 * the reader was told the step's output was under review, and then handed a
 * question about work that had not been produced.
 */
export function claimsStepComplete(text: string): boolean {
  return /```orca:step-complete\s*\n/.test(text);
}

export function extractOrcaStepCompleteBlock(text: string): unknown | null {
  const re = /```orca:step-complete\s*\n([\s\S]*?)\n```/g;
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[1] ?? null;
  if (last === null) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

/**
 * Interprets a parsed orca:step-complete block as the completion envelope
 * `{ output, ledger_updates }`. Backward-compatible: a block that has no
 * `output` key is treated as a bare legacy business output with no ledger
 * updates. Invalid ledger_updates throw via zod (caller maps to a revise).
 */
export function parseStepCompletionEnvelope(block: unknown): { output: unknown; ledgerUpdates: LedgerUpdate[] } {
  if (block !== null && typeof block === "object" && "output" in (block as Record<string, unknown>)) {
    const parsed = StepCompletionEnvelope.parse(block);
    return { output: parsed.output, ledgerUpdates: parsed.ledger_updates };
  }
  return { output: block, ledgerUpdates: [] };
}

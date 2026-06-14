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

const FENCE_OPEN = "```orca:action";
const FENCE_CLOSE = "```";

/**
 * Returns the inner text of the LAST complete ```orca:action ... ``` block in
 * `text` (assuming properly separated fences, as the orchestrator is instructed
 * to emit exactly one block per turn), or null if no complete block is present
 * yet. Used to detect that the orchestrator shadow session has finished emitting
 * its structured action.
 */
export function extractActionBlock(text: string): string | null {
  let result: string | null = null;
  let searchFrom = 0;
  for (;;) {
    const open = text.indexOf(FENCE_OPEN, searchFrom);
    if (open < 0) break;
    const afterOpen = open + FENCE_OPEN.length;
    const close = text.indexOf(FENCE_CLOSE, afterOpen);
    if (close < 0) break; // open fence without a close yet → incomplete
    result = text.slice(afterOpen, close).trim();
    searchFrom = close + FENCE_CLOSE.length;
  }
  return result;
}

/** Appended to the orchestrator system prompt so output is machine-extractable. */
export const SENTINEL_INSTRUCTION = [
  "Output protocol (MANDATORY):",
  "Emit your single structured action as compact JSON wrapped in a fenced block:",
  "```orca:action",
  '{ ...one OrchestratorAction object... }',
  "```",
  "Emit exactly one such block per turn and nothing after the closing fence.",
].join("\n");

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

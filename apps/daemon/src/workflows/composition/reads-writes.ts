export function resolveReads(reads: Record<string, string>, parentOutputs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [childKey, parentKey] of Object.entries(reads)) out[childKey] = parentOutputs[parentKey];
  return out;
}

export function mapWrites(writes: Record<string, string>, childTerminalOutput: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [parentKey, childKey] of Object.entries(writes)) out[parentKey] = childTerminalOutput[childKey];
  return out;
}

import type { StateDepReadEntry, StateVersionDep } from "@orca/contracts";

export interface ReadSetInput {
  memory: Array<{ id: string; updatedAt: string }>;
  decisions: Array<{ id: string; updatedAt: string }>;
  summaries: Array<{ id: string; created_at: string }>;
  refinement: { goalId: string; refinedAt: string } | null;
  workspace: { id: string; branch: string | null; dirty: boolean | null } | null;
}

export function deriveReadSet(input: ReadSetInput): { read_set: StateDepReadEntry[]; version_deps: StateVersionDep[] } {
  const read_set: StateDepReadEntry[] = [];
  const version_deps: StateVersionDep[] = [];
  for (const m of input.memory) read_set.push({ kind: "memory_item", ref: m.id, version: m.updatedAt });
  for (const d of input.decisions) read_set.push({ kind: "decision", ref: d.id, version: d.updatedAt });
  for (const s of input.summaries) read_set.push({ kind: "task", ref: s.id, version: s.created_at });
  if (input.refinement) read_set.push({ kind: "goal_refinement", ref: input.refinement.goalId, version: input.refinement.refinedAt });
  if (input.workspace) {
    const wv = `${input.workspace.branch ?? ""}:${input.workspace.dirty?.toString() ?? ""}`;
    read_set.push({ kind: "workspace_version", ref: input.workspace.id, version: wv });
    version_deps.push({ ref: input.workspace.id, observed_version: wv });
  }
  return { read_set, version_deps };
}

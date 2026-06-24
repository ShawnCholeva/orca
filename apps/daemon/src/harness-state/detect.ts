import type {
  StateConflict,
  StateDepReadEntry,
  StateDepWriteEntry,
  StateVersionDep,
} from "@orca/contracts";

export interface ConflictJudge {
  judge(c: StateConflict): "real" | "false_positive";
}

/** Default judge: keeps every deterministic candidate. The LLM judge is a future drop-in behind this seam. */
export const noopConflictJudge: ConflictJudge = { judge: () => "real" as const };

export interface DetectStateConflictsInput {
  self: {
    read_set: StateDepReadEntry[];
    write_set: StateDepWriteEntry[];
    version_deps: StateVersionDep[];
  };
  priors: Array<{
    transitionId: string;
    read_set: StateDepReadEntry[];
    write_set: StateDepWriteEntry[];
  }>;
  currentVersions: Map<string, string>;
  judge?: ConflictJudge;
}

// Refs are identified by BOTH kind AND ref: a file `src/x.ts` and a memory_item `src/x.ts` are different refs.
const refKey = (e: { kind: string; ref: string }) => `${e.kind}:${e.ref}`;

export function detectStateConflicts(input: DetectStateConflictsInput): StateConflict[] {
  const judge = input.judge ?? noopConflictJudge;
  const candidates: StateConflict[] = [];

  const selfWriteKeys = new Set(input.self.write_set.map(refKey));
  const selfReadKeys = new Set(input.self.read_set.map(refKey));

  for (const prior of input.priors) {
    // write_write: this step writes a ref a prior also writes.
    const wwRefs = prior.write_set.filter((w) => selfWriteKeys.has(refKey(w))).map((w) => w.ref);
    if (wwRefs.length > 0) {
      candidates.push({ kind: "write_write", with_transition_id: prior.transitionId, refs: wwRefs });
    }
    // read_stale: this step read a ref a prior wrote.
    const rsRefs = prior.write_set.filter((w) => selfReadKeys.has(refKey(w))).map((w) => w.ref);
    if (rsRefs.length > 0) {
      candidates.push({ kind: "read_stale", with_transition_id: prior.transitionId, refs: rsRefs });
    }
  }

  // belief_divergence: an observed version no longer matches the current version of that ref.
  for (const dep of input.self.version_deps) {
    if (input.currentVersions.get(dep.ref) !== dep.observed_version) {
      candidates.push({ kind: "belief_divergence", with_transition_id: null, refs: [dep.ref] });
    }
  }

  return candidates.filter((c) => judge.judge(c) === "real");
}

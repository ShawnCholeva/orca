import type { AdapterSpawnResult } from "./types.js";

// Reserved seam for OS-level containment (namespaces/seccomp/sandbox-exec). A future
// milestone provides a real implementation that restricts the spawn's filesystem/
// network/credentials. Today the only implementation is the identity pass-through;
// the policy layer (risk classification + gate) is the active control. See Task 9/10.
export interface SpawnSandbox {
  wrap(spawn: AdapterSpawnResult): AdapterSpawnResult;
}

export const noopSandbox: SpawnSandbox = {
  wrap: (spawn) => spawn,
};

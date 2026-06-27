import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { listWorkspacesByGoal } from "../workspaces/projection.js";

const GIT_TIMEOUT_MS = 2000;
const GIT_MAX_BUFFER = 1_048_576; // 1 MB

/**
 * Injectable workspace git-version probe (branch + dirty). Mirrors write-set's
 * `GitDiffer` so belief-state detection stays unit-testable without real git.
 */
export type VersionProbe = (cwd: string) => { branch: string | null; dirty: boolean | null };

/**
 * Bounded, fail-safe sync git probe of a workspace's branch + dirty flag. Any
 * error/timeout (git missing, not a repo, detached HEAD) resolves to
 * `{ branch: null, dirty: null }` so belief-state recording never throws. Sync
 * to match the surrounding sync fail-safe record paths (and write-set's sync git
 * diff in the same code path).
 */
export const realVersionProbe: VersionProbe = (cwd) => {
  try {
    // stderr is silenced (stdio[2]="ignore") so a non-repo path doesn't spam logs.
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Detached HEAD reports the literal "HEAD"; treat as unprobeable (mirror inspect.ts).
    if (!branch || branch === "HEAD") return { branch: null, dirty: null };
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { branch, dirty: status.length > 0 };
  } catch {
    return { branch: null, dirty: null };
  }
};

/**
 * The goal's working workspace (first-attached convention, same as the sensor
 * ladder) probed for its live branch/dirty version. `null` when no workspace is
 * attached. The `{ id, branch, dirty }` fields feed `deriveReadSet`'s workspace
 * input; `path` feeds `deriveWriteSet`. (Multi-workspace selection — picking the
 * step's target rather than `[0]` — is FUTURE_WORK 2.3.)
 */
export function probeWorkspaceVersion(
  db: Database.Database,
  goalId: string,
  probe: VersionProbe = realVersionProbe,
): { id: string; path: string; branch: string | null; dirty: boolean | null } | null {
  const ws = listWorkspacesByGoal(db, goalId)[0];
  if (!ws) return null;
  return { id: ws.id, path: ws.path, ...probe(ws.path) };
}

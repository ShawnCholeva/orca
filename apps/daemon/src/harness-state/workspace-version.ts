import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { findWorkspaceById } from "../workspaces/projection.js";

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
 * The workspace a step's session targets — `sessions.workspace_id` is the
 * authoritative per-step workspace (the launcher places the session there).
 * Both belief-state sites key off the SAME step session (launch records it,
 * complete completes it), so they always agree on the workspace — which is what
 * makes the launch-snapshot↔complete-current divergence comparison sound for
 * multi-workspace goals, rather than each re-deriving the goal's first-attached
 * `[0]` independently. `null` when the session or its workspace is absent. The
 * `{ id, branch, dirty }` fields feed `deriveReadSet`; `path` feeds `deriveWriteSet`.
 */
export function probeWorkspaceForSession(
  db: Database.Database,
  sessionId: string,
  probe: VersionProbe = realVersionProbe,
): { id: string; path: string; branch: string | null; dirty: boolean | null } | null {
  const row = db.prepare("SELECT workspace_id FROM sessions WHERE id = ?").get(sessionId) as
    | { workspace_id: string }
    | undefined;
  if (!row) return null;
  const ws = findWorkspaceById(db, row.workspace_id);
  if (!ws) return null;
  return { id: ws.id, path: ws.path, ...probe(ws.path) };
}

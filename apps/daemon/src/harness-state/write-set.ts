import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import type { StateChangeKind, StateDepWriteEntry } from "@orca/contracts";

const GIT_TIMEOUT_MS = 2000;
const GIT_MAX_BUFFER = 1_048_576; // 1 MB

export interface GitDiffEntry {
  status: string;
  path: string;
}

/** Injectable git differ — returns the changed files for `cwd`. */
export type GitDiffer = (cwd: string) => GitDiffEntry[];

/**
 * Parse `git diff --name-status` output. Each line is tab-separated:
 *   M\tpath          (modify/add/delete: status + one path)
 *   R100\told\tnew   (rename/copy: status + source + DESTINATION)
 * The path is the LAST tab segment, so rename/copy lines resolve to the
 * destination rather than a tab-embedded `old\tnew` ref.
 */
export function parseNameStatus(stdout: string): GitDiffEntry[] {
  const entries: GitDiffEntry[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const status = parts[0];
    const path = parts[parts.length - 1].trim();
    if (path) entries.push({ status, path });
  }
  return entries;
}

/**
 * Bounded `git diff --name-status` over `cwd`. Fail-safe: any error or timeout
 * (git unavailable, not a repo, buffer overflow) resolves to `[]` so a missing
 * git binary never throws.
 */
const realGitDiffer: GitDiffer = (cwd) => {
  try {
    return parseNameStatus(
      execFileSync("git", ["diff", "--name-status"], {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    );
  } catch {
    return [];
  }
};

function toChangeKind(status: string): StateChangeKind {
  switch (status[0]) {
    case "A":
      return "created";
    case "D":
      return "deleted";
    default:
      // M, and rename/copy (R/C) status codes fall back to modified.
      return "modified";
  }
}

export interface WriteSetInput {
  workspacePath: string;
  sessionId: string;
}

/**
 * Derive the step's write_set: changed files from a bounded git diff over
 * `workspacePath`, plus the memory/decision rows the step's session created.
 */
export function deriveWriteSet(
  db: Database.Database,
  { workspacePath, sessionId }: WriteSetInput,
  differ: GitDiffer = realGitDiffer,
): StateDepWriteEntry[] {
  const writeSet: StateDepWriteEntry[] = [];

  // Fail-safe: a failing/throwing differ omits file entries (git unavailable
  // must not break the step); the created-rows query below still runs.
  let diffEntries: GitDiffEntry[] = [];
  try {
    diffEntries = differ(workspacePath);
  } catch {
    diffEntries = [];
  }
  for (const { status, path } of diffEntries) {
    writeSet.push({ kind: "file", ref: path, change_kind: toChangeKind(status) });
  }

  const memoryRows = db
    .prepare(`SELECT id FROM goal_memory_items WHERE source_session_id = ?`)
    .all(sessionId) as Array<{ id: string }>;
  for (const { id } of memoryRows) {
    writeSet.push({ kind: "memory_item", ref: id, change_kind: "created" });
  }

  const decisionRows = db
    .prepare(`SELECT id FROM goal_decisions WHERE source_session_id = ?`)
    .all(sessionId) as Array<{ id: string }>;
  for (const { id } of decisionRows) {
    writeSet.push({ kind: "decision", ref: id, change_kind: "created" });
  }

  return writeSet;
}

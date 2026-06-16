import { readFileSync } from "node:fs";
import type { ActivityDiff, ActivityDiffLine } from "@orca/contracts";

const MAX_HUNK_LINES = 200;
const CONTEXT_LINES = 2;

type Reader = (filePath: string) => string;

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function buildEditHunk(
  filePath: string,
  oldStr: string,
  newStr: string,
  read: Reader,
): ActivityDiff {
  const removed = splitLines(oldStr);
  const added = splitLines(newStr);
  let oldStart: number | null = null;
  let newStart: number | null = null;
  let before: ActivityDiffLine[] = [];
  let after: ActivityDiffLine[] = [];

  try {
    const file = read(filePath);
    const first = file.indexOf(newStr);
    const unique = first >= 0 && newStr.length > 0 && file.indexOf(newStr, first + 1) === -1;
    if (unique) {
      newStart = file.slice(0, first).split("\n").length; // 1-based
      oldStart = newStart;
      const fileLines = file.split("\n");
      const startIdx = newStart - 1;
      before = fileLines
        .slice(Math.max(0, startIdx - CONTEXT_LINES), startIdx)
        .map((text) => ({ kind: "context" as const, text }));
      const endIdx = startIdx + added.length;
      after = fileLines
        .slice(endIdx, endIdx + CONTEXT_LINES)
        .map((text) => ({ kind: "context" as const, text }));
    }
  } catch {
    // leave line numbers null, no context
  }

  // Stat counts are true totals; the rendered body is capped with a visible marker so truncation is never silent.
  const allLines: ActivityDiffLine[] = [
    ...before,
    ...removed.map((text): ActivityDiffLine => ({ kind: "remove", text })),
    ...added.map((text): ActivityDiffLine => ({ kind: "add", text })),
    ...after,
  ];
  const lines: ActivityDiffLine[] =
    allLines.length > MAX_HUNK_LINES
      ? [
          ...allLines.slice(0, MAX_HUNK_LINES - 1),
          { kind: "context", text: `… ${allLines.length - (MAX_HUNK_LINES - 1)} more changed line(s) hidden` },
        ]
      : allLines;

  return {
    filePath: basename(filePath),
    additions: added.length,
    deletions: removed.length,
    hunks: [{ oldStart, newStart, lines }],
  };
}

/** Reconstruct a unified diff for an edit tool from its hook payload. Returns
 *  null for non-edit tools or when no file path is present. Never throws. */
export function reconstructEditDiff(
  toolName: string,
  toolInput: unknown,
  read: Reader = (p) => readFileSync(p, "utf8"),
): ActivityDiff | null {
  try {
    const input = (toolInput ?? {}) as Record<string, unknown>;
    const filePath = typeof input.file_path === "string" ? input.file_path : null;
    if (!filePath) return null;

    if (toolName === "Write") {
      const content = typeof input.content === "string" ? input.content : "";
      const added = splitLines(content);
      // Stat counts are true totals; the rendered body is capped with a visible marker so truncation is never silent.
      const allWriteLines: ActivityDiffLine[] = added.map((text) => ({ kind: "add", text }));
      const lines: ActivityDiffLine[] =
        allWriteLines.length > MAX_HUNK_LINES
          ? [
              ...allWriteLines.slice(0, MAX_HUNK_LINES - 1),
              { kind: "context", text: `… ${allWriteLines.length - (MAX_HUNK_LINES - 1)} more changed line(s) hidden` },
            ]
          : allWriteLines;
      return {
        filePath: basename(filePath),
        additions: added.length,
        deletions: 0,
        hunks: [{ oldStart: 1, newStart: 1, lines }],
      };
    }

    if (toolName === "Edit") {
      const oldStr = typeof input.old_string === "string" ? input.old_string : "";
      const newStr = typeof input.new_string === "string" ? input.new_string : "";
      return buildEditHunk(filePath, oldStr, newStr, read);
    }

    if (toolName === "MultiEdit") {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      const hunks = [];
      let additions = 0;
      let deletions = 0;
      for (const raw of edits) {
        const e = (raw ?? {}) as Record<string, unknown>;
        const oldStr = typeof e.old_string === "string" ? e.old_string : "";
        const newStr = typeof e.new_string === "string" ? e.new_string : "";
        const d = buildEditHunk(filePath, oldStr, newStr, read);
        hunks.push(...d.hunks);
        additions += d.additions;
        deletions += d.deletions;
      }
      if (hunks.length === 0) return null;
      return { filePath: basename(filePath), additions, deletions, hunks: hunks.slice(0, 20) };
    }

    return null;
  } catch {
    return null;
  }
}

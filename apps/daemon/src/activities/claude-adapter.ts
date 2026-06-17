import type { ActivityWorkCategory } from "@orca/contracts";

const TEST_RUNNERS = /^(vitest|jest|pytest|mocha|ava|rspec|phpunit)$/;

function commandTokens(command: string): string[] {
  // Strip leading env-var assignments (FOO=bar) and reduce each token to its
  // basename so "node_modules/.bin/vitest" reads as "vitest".
  const raw = command.trim().split(/\s+/);
  let i = 0;
  while (i < raw.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[i] ?? "")) i += 1;
  return raw.slice(i).map((t) => t.replace(/.*[\\/]/, "").toLowerCase());
}

/** True only when the command actually invokes a test runner — not when "test"
 *  merely appears as an argument (e.g. `grep -v "\.test\."`). */
export function isTestCommand(command: string): boolean {
  const tokens = commandTokens(command);
  if (tokens.some((t) => TEST_RUNNERS.test(t))) return true;
  const first = tokens[0] ?? "";
  if (/^(pnpm|npm|yarn|npx|bun)$/.test(first) && /(^|\s)(run\s+)?test(\s|$)/.test(command)) {
    return true;
  }
  if (/^(go|cargo|make)$/.test(first) && /(^|\s)test(\s|$)/.test(command)) return true;
  return false;
}

const BASH_LOW_SIGNAL = new Set([
  "grep", "rg", "ag", "find", "ls", "wc",
  "echo", "pwd", "which", "stat", "file", "tree", "sort", "uniq",
]);
const GIT_READ_ONLY = new Set([
  "status", "diff", "log", "show", "ls-files", "grep", "branch", "rev-parse",
]);

// Shell commands that read a file's contents — the human reads these like a
// Read tool call ("Read App.tsx"), not "Ran sed …".
const READ_COMMANDS = new Set(["sed", "cat", "head", "tail"]);

/** When a Bash command just reads a file (sed -n 'Np' / cat / head / tail of a
 *  single file, no pipe), returns that file's basename; otherwise null. An
 *  in-place sed edit (-i) is not a read. */
export function bashReadFile(command: string): string | null {
  if (command.includes("|")) return null;
  const raw = command.trim().split(/\s+/);
  let i = 0;
  while (i < raw.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[i] ?? "")) i += 1;
  const cmd = (raw[i] ?? "").replace(/.*[\\/]/, "").toLowerCase();
  if (!READ_COMMANDS.has(cmd)) return null;
  if (cmd === "sed" && raw.some((t) => t === "-i" || t.startsWith("-i."))) return null;
  const last = (raw[raw.length - 1] ?? "").replace(/^['"]|['"]$/g, "");
  if (last === "" || last.startsWith("-")) return null;
  // A bare sed script like '1030,1050p' is not a file.
  if (cmd === "sed" && /^[0-9,$]*[a-z]$/i.test(last)) return null;
  return basename(last);
}

/** Low-signal look-around the activity checklist should not persist as a step:
 *  searches (Grep/Glob) and read-only inspection shell commands. Substantive
 *  work (reads, edits, test/build/run commands, git mutations) returns false. */
export function isLowSignalTool(toolName: string, toolInput: unknown): boolean {
  if (toolName === "Grep" || toolName === "Glob") return true;
  if (toolName !== "Bash") return false;
  const command = (toolInput as { command?: unknown } | null)?.command;
  if (typeof command !== "string") return false;
  // A pipeline filtered through a search is look-around (e.g. `cat x | grep y`).
  if (/\|\s*(grep|rg|ag)\b/.test(command)) return true;
  const tokens = commandTokens(command);
  const first = tokens[0] ?? "";
  if (BASH_LOW_SIGNAL.has(first)) return true;
  if (first === "git" && GIT_READ_ONLY.has(tokens[1] ?? "")) return true;
  return false;
}

export function categorizeClaudeTool(
  toolName: string,
  toolInput: unknown
): ActivityWorkCategory {
  switch (toolName) {
    case "Read":
      return "reading";
    case "Grep":
    case "Glob":
      return "searching";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "editing";
    case "Bash": {
      const command = (toolInput as { command?: unknown } | null)?.command;
      return typeof command === "string" && isTestCommand(command)
        ? "testing"
        : "running";
    }
    default:
      return "other";
  }
}

export function narrateCategory(category: ActivityWorkCategory): string {
  switch (category) {
    case "reading":
      return "Reading through the codebase...";
    case "searching":
      return "Searching the codebase...";
    case "editing":
      return "Making changes...";
    case "running":
      return "Running a command...";
    case "testing":
      return "Running the test suite...";
    case "other":
      return "Working on the step...";
  }
}

function basename(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf("\\"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

function truncate(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Human one-liner for a tool call, derived from its input. Falls back to the
 *  generic category narration for unknown tools or malformed input. */
export function narrateToolDetail(toolName: string, toolInput: unknown): string {
  try {
    const input = (toolInput ?? {}) as Record<string, unknown>;
    const file = typeof input.file_path === "string" ? basename(input.file_path) : null;
    switch (toolName) {
      case "Read":
        return file ? `Read ${file}` : narrateCategory("reading");
      case "Edit":
      case "Write":
      case "MultiEdit":
      case "NotebookEdit":
        return file ? `Edited ${file}` : narrateCategory("editing");
      case "Grep":
      case "Glob": {
        const pattern = typeof input.pattern === "string" ? input.pattern
          : typeof input.glob === "string" ? input.glob : null;
        return pattern ? `Searched "${truncate(pattern, 60)}"` : narrateCategory("searching");
      }
      case "Bash": {
        const cmd = typeof input.command === "string" ? input.command : null;
        if (!cmd) return narrateCategory("running");
        const readFile = bashReadFile(cmd);
        if (readFile) return `Read ${readFile}`;
        return isTestCommand(cmd) ? `Ran tests: ${truncate(cmd)}` : `Ran ${truncate(cmd)}`;
      }
      default:
        return narrateCategory(categorizeClaudeTool(toolName, toolInput));
    }
  } catch {
    return narrateCategory("other");
  }
}

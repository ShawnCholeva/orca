import type { ActivityWorkCategory } from "@orca/contracts";

const TEST_COMMAND = /\b(test|vitest|jest|pytest)\b/i;

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
      return typeof command === "string" && TEST_COMMAND.test(command)
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

const TEST_CMD = /\b(test|vitest|jest|pytest)\b/i;

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
        return TEST_CMD.test(cmd) ? `Ran tests: ${truncate(cmd)}` : `Ran ${truncate(cmd)}`;
      }
      default:
        return narrateCategory(categorizeClaudeTool(toolName, toolInput));
    }
  } catch {
    return narrateCategory("other");
  }
}

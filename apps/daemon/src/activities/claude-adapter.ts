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

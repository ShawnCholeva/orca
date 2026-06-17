import { describe, expect, it } from "vitest";
import {
  categorizeClaudeTool,
  isLowSignalTool,
  narrateCategory,
  narrateToolDetail,
} from "./claude-adapter";

describe("Claude signal adapter", () => {
  it("maps tool names to work categories", () => {
    expect(categorizeClaudeTool("Read", {})).toBe("reading");
    expect(categorizeClaudeTool("Grep", {})).toBe("searching");
    expect(categorizeClaudeTool("Glob", {})).toBe("searching");
    expect(categorizeClaudeTool("Edit", {})).toBe("editing");
    expect(categorizeClaudeTool("Write", {})).toBe("editing");
    expect(categorizeClaudeTool("Bash", { command: "ls" })).toBe("running");
    expect(categorizeClaudeTool("Bash", { command: "pnpm test" })).toBe("testing");
    expect(categorizeClaudeTool("Bash", { command: "vitest run" })).toBe("testing");
    expect(categorizeClaudeTool("SomethingElse", {})).toBe("other");
  });

  it("treats a non-string Bash command as running", () => {
    expect(categorizeClaudeTool("Bash", { command: Symbol("test") })).toBe("running");
  });

  it("produces calm, human-readable narration per category", () => {
    expect(narrateCategory("reading")).toMatch(/codebase/i);
    expect(narrateCategory("testing")).toMatch(/test/i);
    expect(narrateCategory("other")).toMatch(/working/i);
  });
});

describe("narrateToolDetail", () => {
  it("names the file read", () => {
    expect(narrateToolDetail("Read", { file_path: "/repo/billing/verifier.ts" }))
      .toBe("Read verifier.ts");
  });
  it("names the file edited", () => {
    expect(narrateToolDetail("Edit", { file_path: "/repo/store.ts" }))
      .toBe("Edited store.ts");
    expect(narrateToolDetail("Write", { file_path: "/repo/new.ts" }))
      .toBe("Edited new.ts");
  });
  it("shows the search pattern", () => {
    expect(narrateToolDetail("Grep", { pattern: "retryCharge(" }))
      .toBe('Searched "retryCharge("');
  });
  it("shows the command, marking tests", () => {
    expect(narrateToolDetail("Bash", { command: "pnpm test billing" }))
      .toBe("Ran tests: pnpm test billing");
    expect(narrateToolDetail("Bash", { command: "ls -la" }))
      .toBe("Ran ls -la");
  });
  it("falls back to category narration on unknown/garbage input", () => {
    expect(narrateToolDetail("WebFetch", null))
      .toBe("Working on the step...");
  });
});

describe("test-command classification (no substring false positives)", () => {
  it("classifies real test runs as testing", () => {
    expect(categorizeClaudeTool("Bash", { command: "pnpm test billing" })).toBe("testing");
    expect(
      categorizeClaudeTool("Bash", {
        command: "pnpm --filter @orca/daemon exec vitest run src/x.test.ts",
      }),
    ).toBe("testing");
    expect(categorizeClaudeTool("Bash", { command: "npx jest" })).toBe("testing");
    expect(categorizeClaudeTool("Bash", { command: "go test ./..." })).toBe("testing");
  });
  it("does NOT treat greps that merely mention 'test' as test runs", () => {
    const grep = { command: 'grep -rn "listGoals" | grep -v "\\.test\\."' };
    expect(categorizeClaudeTool("Bash", grep)).toBe("running");
    expect(narrateToolDetail("Bash", grep)).toMatch(/^Ran /);
    expect(narrateToolDetail("Bash", grep)).not.toMatch(/^Ran tests:/);
  });
});

describe("isLowSignalTool curation", () => {
  it("drops searches and read-only inspection commands", () => {
    expect(isLowSignalTool("Grep", { pattern: "x" })).toBe(true);
    expect(isLowSignalTool("Glob", { pattern: "*.ts" })).toBe(true);
    expect(isLowSignalTool("Bash", { command: "grep -rn foo src" })).toBe(true);
    expect(isLowSignalTool("Bash", { command: "wc -l file" })).toBe(true);
    expect(isLowSignalTool("Bash", { command: "git ls-files | grep goal" })).toBe(true);
    expect(isLowSignalTool("Bash", { command: "git status" })).toBe(true);
  });
  it("keeps substantive work", () => {
    expect(isLowSignalTool("Read", { file_path: "/a.ts" })).toBe(false);
    expect(isLowSignalTool("Edit", { file_path: "/a.ts" })).toBe(false);
    expect(isLowSignalTool("Bash", { command: "pnpm test" })).toBe(false);
    expect(isLowSignalTool("Bash", { command: "git commit -m x" })).toBe(false);
  });
});

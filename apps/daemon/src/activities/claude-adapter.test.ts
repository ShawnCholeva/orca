import { describe, expect, it } from "vitest";
import { categorizeClaudeTool, narrateCategory, narrateToolDetail } from "./claude-adapter";

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

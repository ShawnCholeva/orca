import { describe, expect, it } from "vitest";
import {
  categorizeClaudeTool,
  isLowSignalTool,
  narrateCategory,
  narratePendingToolDetail,
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

describe("narratePendingToolDetail (present tense — describes a not-yet-run action)", () => {
  it("describes a pending edit in present tense, not 'Edited'", () => {
    expect(narratePendingToolDetail("Edit", { file_path: "/repo/store.ts" })).toBe("Edit store.ts");
    expect(narratePendingToolDetail("Write", { file_path: "/repo/new.ts" })).toBe("Edit new.ts");
  });
  it("describes a pending read in present tense", () => {
    expect(narratePendingToolDetail("Read", { file_path: "/repo/x.ts" })).toBe("Read x.ts");
  });
  it("describes a pending search in present tense, not 'Searched'", () => {
    expect(narratePendingToolDetail("Grep", { pattern: "retryCharge(" })).toBe('Search "retryCharge("');
  });
  it("describes a pending bash command WITHOUT echoing it (the command is shown separately)", () => {
    expect(narratePendingToolDetail("Bash", { command: "rm -rf build && echo done" })).toBe("Run a shell command");
    expect(narratePendingToolDetail("Bash", { command: "pnpm test billing" })).toBe("Run tests");
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

describe("read narration disambiguates by line range", () => {
  it("appends the Read tool's offset/limit as a line range", () => {
    expect(narrateToolDetail("Read", { file_path: "/r/x.ts", offset: 200, limit: 61 }))
      .toBe("Read x.ts (lines 200–260)");
    expect(narrateToolDetail("Read", { file_path: "/r/x.ts", offset: 200 }))
      .toBe("Read x.ts (from line 200)");
    expect(narrateToolDetail("Read", { file_path: "/r/x.ts", limit: 20 }))
      .toBe("Read x.ts (first 20 lines)");
  });
  it("leaves a whole-file Read (no offset/limit) unchanged", () => {
    expect(narrateToolDetail("Read", { file_path: "/r/x.ts" })).toBe("Read x.ts");
  });
  it("ignores non-numeric offset/limit", () => {
    expect(narrateToolDetail("Read", { file_path: "/r/x.ts", offset: "nope", limit: null }))
      .toBe("Read x.ts");
  });
  it("extracts the range from sed/head/tail read commands", () => {
    expect(narrateToolDetail("Bash", { command: "sed -n '1030,1050p' apps/desktop/src/App.tsx" }))
      .toBe("Read App.tsx (lines 1030–1050)");
    expect(narrateToolDetail("Bash", { command: "sed -n '50p' src/x.ts" }))
      .toBe("Read x.ts (line 50)");
    expect(narrateToolDetail("Bash", { command: "sed -n '1030,$p' src/x.ts" }))
      .toBe("Read x.ts (from line 1030)");
    expect(narrateToolDetail("Bash", { command: "head -n 20 src/x.ts" }))
      .toBe("Read x.ts (first 20 lines)");
    expect(narrateToolDetail("Bash", { command: "tail -n 20 server.log" }))
      .toBe("Read server.log (last 20 lines)");
  });
  it("adds no range for a whole-file cat or a following tail", () => {
    expect(narrateToolDetail("Bash", { command: "cat apps/foo.ts" })).toBe("Read foo.ts");
    expect(narrateToolDetail("Bash", { command: "tail -f server.log" })).toBe("Read server.log");
  });
});

describe("file-reading shell commands render as Read", () => {
  it("treats sed/cat/head/tail of a file as a read", () => {
    expect(narrateToolDetail("Bash", { command: "cat apps/foo.ts" })).toBe("Read foo.ts");
    expect(narrateToolDetail("Bash", { command: "tail -f server.log" })).toBe("Read server.log");
  });
  it("keeps file reads in the checklist (not low-signal)", () => {
    expect(isLowSignalTool("Bash", { command: "sed -n '1,5p' a.ts" })).toBe(false);
    expect(isLowSignalTool("Bash", { command: "cat a.ts" })).toBe(false);
  });
  it("drops search pipelines and treats sed -i as a run, not a read", () => {
    expect(isLowSignalTool("Bash", { command: "cat a.ts | grep foo" })).toBe(true);
    expect(narrateToolDetail("Bash", { command: "sed -i 's/a/b/' a.ts" })).toMatch(/^Ran /);
    expect(narrateToolDetail("Bash", { command: "sed -i 's/a/b/' a.ts" })).not.toMatch(/^Read /);
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

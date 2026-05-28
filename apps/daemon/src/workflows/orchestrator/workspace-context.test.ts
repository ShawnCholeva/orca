import { describe, expect, it } from "vitest";
import { assembleWorkspaceContext } from "./workspace-context.js";

describe("assembleWorkspaceContext", () => {
  it("returns workspaces + memory-derived summaries", () => {
    const ctx = assembleWorkspaceContext({
      workspaces: [{ id: "ws1", name: "monorepo", root: "/r" }],
      summaries: [{ workspaceId: "ws1", summary: "TS monorepo with pnpm" }],
      snippets: [],
      payloadBudget: 4096,
    });
    expect(ctx.workspaces[0].name).toBe("monorepo");
    expect(ctx.summaries[0].summary).toMatch(/monorepo/);
  });

  it("truncates summaries to the payload budget", () => {
    const huge = "x".repeat(8192);
    const ctx = assembleWorkspaceContext({
      workspaces: [{ id: "ws1", name: "n", root: "/r" }],
      summaries: [{ workspaceId: "ws1", summary: huge }],
      snippets: [{ path: "src/a.ts", excerpt: huge }],
      payloadBudget: 1024,
    });
    const size = Buffer.byteLength(JSON.stringify(ctx), "utf8");
    expect(size).toBeLessThanOrEqual(1024);
  });
});

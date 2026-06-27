import { describe, expect, it } from "vitest";
import { deriveReadSet } from "./read-set.js";

describe("deriveReadSet", () => {
  it("maps memory/decision/summary/refinement/workspace inputs to read_set + version_deps", () => {
    const r = deriveReadSet({
      memory: [{ id: "m1", updatedAt: "2026-06-24T00:00:00.000Z" }],
      decisions: [{ id: "d1", updatedAt: "2026-06-24T00:01:00.000Z" }],
      summaries: [{ id: "s1", created_at: "2026-06-24T00:02:00.000Z" }],
      refinement: { goalId: "g", refinedAt: "2026-06-24T00:03:00.000Z" },
      workspace: { id: "ws1", branch: "main", dirty: false },
    });
    expect(r.read_set).toContainEqual({ kind: "memory_item", ref: "m1", version: "2026-06-24T00:00:00.000Z" });
    expect(r.read_set).toContainEqual({ kind: "decision", ref: "d1", version: "2026-06-24T00:01:00.000Z" });
    expect(r.read_set).toContainEqual({ kind: "workspace_version", ref: "ws1", version: "main:false" });
    expect(r.version_deps).toContainEqual({ ref: "ws1", observed_version: "main:false" });
  });
  it("records the refinement under its own kind, not the decision namespace", () => {
    const r = deriveReadSet({
      memory: [],
      decisions: [],
      summaries: [],
      refinement: { goalId: "g", refinedAt: "2026-06-24T00:03:00.000Z" },
      workspace: null,
    });
    expect(r.read_set).toContainEqual({ kind: "goal_refinement", ref: "g", version: "2026-06-24T00:03:00.000Z" });
    expect(r.read_set.some((e) => e.kind === "decision")).toBe(false);
  });
  it("handles empty inputs", () => {
    const r = deriveReadSet({ memory: [], decisions: [], summaries: [], refinement: null, workspace: null });
    expect(r.read_set).toEqual([]);
    expect(r.version_deps).toEqual([]);
  });
});

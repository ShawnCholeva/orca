import { describe, expect, it } from "vitest";
import { WorkflowTemplate } from "./index.js";

const BASE_TEMPLATE = {
  id: "custom/test-template",
  name: "Test Template",
  description: "A test template",
  version: 1,
  isBuiltIn: false,
  isLocked: false,
  steps: [
    {
      id: "step-1",
      ordinal: 0,
      name: "Step 1",
      instructions: "Do the work.",
      outputSchema: [{ key: "summary", type: "string", required: true }],
      agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
    },
  ],
  guardrails: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scope: "global",
  scopeName: "",
  graph: null,
};

describe("WorkflowTemplate contract", () => {
  it("throws when category is missing", () => {
    expect(() => WorkflowTemplate.parse(BASE_TEMPLATE)).toThrow();
  });

  it("round-trips with a valid category", () => {
    const result = WorkflowTemplate.parse({ ...BASE_TEMPLATE, category: "Product" });
    expect(result.category).toBe("Product");
  });

  it("rejects an empty category string", () => {
    expect(() => WorkflowTemplate.parse({ ...BASE_TEMPLATE, category: "" })).toThrow();
  });

  it("rejects a category string longer than 64 chars", () => {
    expect(() =>
      WorkflowTemplate.parse({ ...BASE_TEMPLATE, category: "x".repeat(65) })
    ).toThrow();
  });
});

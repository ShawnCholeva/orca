import { describe, expect, it } from "vitest";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { serializeOutputSchema } from "./output-schema-text";

describe("serializeOutputSchema", () => {
  it("renders bare string fields without a type", () => {
    const schema: WorkflowStepOutputSchema = [
      { key: "goal", type: "string", required: true },
      { key: "audience", type: "string", required: true },
    ];
    expect(serializeOutputSchema(schema)).toBe("goal,\naudience");
  });

  it("renders optional marker, primitives and typed arrays", () => {
    const schema: WorkflowStepOutputSchema = [
      { key: "confidence", type: "number", required: true },
      { key: "reviewed", type: "boolean", required: false },
      { key: "tags", type: "array", itemType: "string", required: true },
      { key: "ids", type: "array", required: false },
    ];
    expect(serializeOutputSchema(schema)).toBe(
      "confidence: number,\nreviewed?: boolean,\ntags: string[],\nids?[]",
    );
  });

  it("renders nested object and array-of-object with indentation", () => {
    const schema: WorkflowStepOutputSchema = [
      {
        key: "test_results",
        type: "object",
        required: true,
        fields: [
          { key: "ran", type: "boolean", required: true },
          { key: "skipped", type: "string", required: false },
        ],
      },
      {
        key: "tasks",
        type: "array",
        itemType: "object",
        required: true,
        fields: [{ key: "title", type: "string", required: true }],
      },
    ];
    expect(serializeOutputSchema(schema)).toBe(
      "test_results {\n  ran: boolean,\n  skipped?\n},\ntasks[] {\n  title\n}",
    );
  });

  it("appends a description on leaf fields", () => {
    const schema: WorkflowStepOutputSchema = [
      { key: "goal", type: "string", required: true, description: "primary objective" },
    ];
    expect(serializeOutputSchema(schema)).toBe("goal  # primary objective");
  });
});

import { describe, expect, it } from "vitest";
import type { WorkflowStepOutputSchema } from "@orca/contracts";
import { parseOutputSchemaText, serializeOutputSchema } from "./output-schema-text";

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

describe("parseOutputSchemaText", () => {
  it("parses bare names as required strings", () => {
    const r = parseOutputSchemaText("goal, audience");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schema).toEqual([
        { key: "goal", type: "string", required: true },
        { key: "audience", type: "string", required: true },
      ]);
    }
  });

  it("parses optional markers, primitives, typed and bare arrays", () => {
    const r = parseOutputSchemaText("confidence: number\nreviewed?: boolean\ntags: string[]\nids?[]");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schema).toEqual([
        { key: "confidence", type: "number", required: true },
        { key: "reviewed", type: "boolean", required: false },
        { key: "tags", type: "array", itemType: "string", required: true },
        { key: "ids", type: "array", required: false },
      ]);
    }
  });

  it("parses nested object (with and without colon) and array-of-object", () => {
    const r = parseOutputSchemaText("test_results: { ran: boolean, skipped? }\ntasks[] { title }");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schema).toEqual([
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
      ]);
    }
  });

  it("parses a leaf description", () => {
    const r = parseOutputSchemaText("goal  # primary objective");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schema[0]).toEqual({
        key: "goal",
        type: "string",
        required: true,
        description: "primary objective",
      });
    }
  });

  it("rejects empty input", () => {
    const r = parseOutputSchemaText("   ");
    expect(r.ok).toBe(false);
  });

  it("rejects duplicate keys at the same level", () => {
    const r = parseOutputSchemaText("goal, goal");
    expect(r).toEqual({ ok: false, error: "Duplicate key 'goal'" });
  });

  it("rejects unknown type tokens", () => {
    const r = parseOutputSchemaText("count: integer");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("integer");
  });

  it("rejects unbalanced braces", () => {
    const r = parseOutputSchemaText("a { b");
    expect(r.ok).toBe(false);
  });
});

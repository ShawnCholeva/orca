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

  it("renders string literal unions", () => {
    const schema: WorkflowStepOutputSchema = [
      { key: "confidence", type: "string", required: true, enum: ["low", "medium", "high"] },
    ];
    expect(serializeOutputSchema(schema)).toBe('confidence: "low" | "medium" | "high"');
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

  it("parses string literal unions", () => {
    const r = parseOutputSchemaText('confidence: "low" | "medium" | "high"');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schema).toEqual([
        {
          key: "confidence",
          type: "string",
          required: true,
          enum: ["low", "medium", "high"],
        },
      ]);
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

// Fixtures mirror apps/daemon/src/workflows/templates/seed-engineering.ts output schemas.
const BUILTIN_SCHEMAS: WorkflowStepOutputSchema[] = [
  [
    { key: "problem", type: "string", required: true },
    { key: "success_outcome", type: "string", required: true },
    { key: "constraints", type: "array", itemType: "string", required: true },
    { key: "relevant_workspaces", type: "array", itemType: "string", required: false },
    { key: "open_questions", type: "array", itemType: "string", required: false },
  ],
  [
    { key: "summary", type: "string", required: true },
    { key: "changed_files", type: "array", itemType: "string", required: true },
    {
      key: "validation",
      type: "object",
      required: true,
      fields: [
        { key: "ran", type: "boolean", required: true },
        { key: "passed", type: "boolean", required: true },
        { key: "skipped", type: "string", required: false },
      ],
    },
    { key: "blocked", type: "boolean", required: true },
    { key: "blocked_reason", type: "string", required: false },
  ],
  [
    { key: "summary", type: "string", required: true },
    {
      key: "tasks",
      type: "array",
      itemType: "object",
      required: true,
      fields: [
        { key: "title", type: "string", required: true },
        { key: "acceptance", type: "string", required: true },
      ],
    },
  ],
];

describe("round-trip", () => {
  it("serialize → parse returns the original schema for every built-in", () => {
    for (const schema of BUILTIN_SCHEMAS) {
      const text = serializeOutputSchema(schema);
      const parsed = parseOutputSchemaText(text);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.schema).toEqual(schema);
    }
  });

  it("preserves descriptions on object and array-of-object fields", () => {
    const schema = [
      {
        key: "meta",
        type: "object" as const,
        required: true,
        description: "the metadata block",
        fields: [{ key: "id", type: "string" as const, required: true }],
      },
      {
        key: "items",
        type: "array" as const,
        itemType: "object" as const,
        required: true,
        description: "list of results",
        fields: [{ key: "name", type: "string" as const, required: true }],
      },
    ];
    const text = serializeOutputSchema(schema as any);
    const parsed = parseOutputSchemaText(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.schema.find((f) => f.key === "meta")?.description).toBe("the metadata block");
      expect(parsed.schema.find((f) => f.key === "items")?.description).toBe("list of results");
    }
  });
});

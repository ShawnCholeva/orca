import { describe, expect, it } from "vitest";
import { WorkflowStepOutputSchema, validateStepOutput } from "./output-schema.js";

const schema = WorkflowStepOutputSchema.parse([
  { key: "problem", type: "string", required: true },
  { key: "constraints", type: "array", itemType: "string", required: true },
  { key: "open_questions", type: "array", itemType: "string", required: false },
]);

describe("validateStepOutput", () => {
  it("accepts a conforming object", () => {
    const r = validateStepOutput(schema, { problem: "x", constraints: ["a", "b"] });
    expect(r.ok).toBe(true);
  });
  it("rejects a missing required key", () => {
    const r = validateStepOutput(schema, { problem: "x" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors[0]).toMatch(/constraints/);
  });
  it("rejects wrong primitive type", () => {
    const r = validateStepOutput(schema, { problem: 5, constraints: [] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.join()).toMatch(/problem/);
  });
  it("rejects string values outside the allowed literals", () => {
    const literalSchema = WorkflowStepOutputSchema.parse([
      { key: "confidence", type: "string", required: true, enum: ["low", "medium", "high"] },
    ]);
    expect(validateStepOutput(literalSchema, { confidence: "medium" }).ok).toBe(true);
    const r = validateStepOutput(literalSchema, { confidence: "unknown" });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.join()).toMatch(/confidence/);
  });
  it("rejects wrong array item type", () => {
    const r = validateStepOutput(schema, { problem: "x", constraints: [1, 2] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.join()).toMatch(/constraints\[0\]/);
  });
  it("validates one level of nested object fields", () => {
    const nested = WorkflowStepOutputSchema.parse([
      { key: "owner", type: "object", required: true, fields: [
        { key: "name", type: "string", required: true },
      ] },
    ]);
    expect(validateStepOutput(nested, { owner: { name: "a" } }).ok).toBe(true);
    expect(validateStepOutput(nested, { owner: {} }).ok).toBe(false);
  });

  it("rejects a null output", () => {
    const r = validateStepOutput(schema, null);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.join()).toMatch(/expected object/);
  });

  it("does not validate beyond nesting depth 2 (third level opaque)", () => {
    const deep = WorkflowStepOutputSchema.parse([
      { key: "owner", type: "object", required: true, fields: [
        { key: "profile", type: "object", required: true, fields: [
          { key: "name", type: "string", required: true },
        ] },
      ] },
    ]);
    // profile.name is wrong type, but it sits at the 3rd level → not checked
    const r = validateStepOutput(deep, { owner: { profile: { name: 123 } } });
    expect(r.ok).toBe(true);
  });

  it("accepts an empty required array and rejects mixed item types", () => {
    expect(validateStepOutput(schema, { problem: "x", constraints: [] }).ok).toBe(true);
    const r = validateStepOutput(schema, { problem: "x", constraints: ["a", 1] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.join()).toMatch(/constraints\[1\]/);
  });
});

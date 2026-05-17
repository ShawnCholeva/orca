import { describe, it, expect } from "vitest";
import { quickGoalSkill } from "./quick-goal.js";
import { ValidationError } from "../goals.js";

const ctx = { now: () => new Date().toISOString() };

describe("quickGoalSkill", () => {
  it("returns trimmed title and description on happy path", () => {
    const result = quickGoalSkill.invoke(
      { title: "  My Goal  ", description: "  Some desc  " },
      ctx
    );
    expect(result).toEqual({ title: "My Goal", description: "Some desc" });
  });

  it("defaults missing description to empty string", () => {
    const result = quickGoalSkill.invoke({ title: "A goal" }, ctx);
    expect(result).toEqual({ title: "A goal", description: "" });
  });

  it("rejects empty title after trim", () => {
    expect(() =>
      quickGoalSkill.invoke({ title: "   " }, ctx)
    ).toThrow(ValidationError);
  });

  it("rejects title longer than 200 chars after trim", () => {
    expect(() =>
      quickGoalSkill.invoke({ title: "a".repeat(201) }, ctx)
    ).toThrow(ValidationError);
  });

  it("rejects description longer than 4000 chars after trim", () => {
    expect(() =>
      quickGoalSkill.invoke({ title: "Valid", description: "x".repeat(4001) }, ctx)
    ).toThrow(ValidationError);
  });

  it("thrown error is instance of ValidationError", () => {
    let err: unknown;
    try {
      quickGoalSkill.invoke({ title: "" }, ctx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
  });

  it("rejects non-string title (wrong type)", () => {
    expect(() =>
      quickGoalSkill.invoke({ title: 42 } as unknown as { title: string }, ctx)
    ).toThrow(ValidationError);
  });

  it("rejects non-object input", () => {
    expect(() =>
      quickGoalSkill.invoke("not an object" as unknown as { title: string }, ctx)
    ).toThrow(ValidationError);
  });

  it("has no side effects — no DB or bus access", () => {
    // Calling invoke should not throw due to missing DB/bus — it is pure computation.
    const result = quickGoalSkill.invoke({ title: "No side effects" }, ctx);
    expect(result.title).toBe("No side effects");
  });

  it("accepts exactly 200-char title", () => {
    const title = "a".repeat(200);
    const result = quickGoalSkill.invoke({ title }, ctx);
    expect(result.title).toBe(title);
  });

  it("accepts exactly 4000-char description", () => {
    const description = "x".repeat(4000);
    const result = quickGoalSkill.invoke({ title: "Valid", description }, ctx);
    expect(result.description).toBe(description);
  });
});

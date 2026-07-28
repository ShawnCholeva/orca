import { describe, it, expect } from "vitest";
import { goalSuccessCriteria } from "./db-rows.js";

describe("goalSuccessCriteria", () => {
  it("parses a JSON array", () => {
    expect(goalSuccessCriteria({ success_criteria: '["a","b"]' })).toEqual(["a", "b"]);
  });
  it("returns [] for null / invalid", () => {
    expect(goalSuccessCriteria({ success_criteria: null })).toEqual([]);
    expect(goalSuccessCriteria({ success_criteria: "not json" })).toEqual([]);
  });
});

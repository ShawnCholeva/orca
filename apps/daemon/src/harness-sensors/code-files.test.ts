import { describe, expect, it } from "vitest";
import { isCodeFile } from "./code-files.js";

describe("isCodeFile", () => {
  it("classifies by extension, case-insensitive", () => {
    expect(isCodeFile("src/calc.ts")).toBe(true);
    expect(isCodeFile("src/App.TSX")).toBe(true);
    expect(isCodeFile("README.md")).toBe(false);
    expect(isCodeFile("docs/plan")).toBe(false);
  });
});

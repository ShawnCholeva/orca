import { describe, expect, it } from "vitest";
import { noopSandbox } from "./sandbox.js";

describe("noopSandbox", () => {
  it("returns the spawn unchanged (identity pass-through)", () => {
    const spawn = { command: "claude", args: [], env: { PATH: "/usr/bin" }, cwd: "/tmp/r" };
    expect(noopSandbox.wrap(spawn)).toBe(spawn);
  });
});

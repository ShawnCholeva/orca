import { describe, expect, it } from "vitest";
import { installUrlFor, signInCommandFor } from "./repair-links.js";

describe("repair-links", () => {
  it("returns an https install URL for each known adapter", () => {
    for (const id of ["claude-code", "codex"] as const) {
      const url = installUrlFor(id);
      expect(url).toMatch(/^https:\/\//);
    }
  });

  it("returns the sign-in command for each known adapter", () => {
    expect(signInCommandFor("claude-code")).toBe("claude auth login");
    expect(signInCommandFor("codex")).toBe("codex login");
  });

  it("returns null for unknown ids (caller decides fallback)", () => {
    expect(installUrlFor("nope" as never)).toBeNull();
    expect(signInCommandFor("nope" as never)).toBeNull();
  });
});

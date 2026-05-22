import { describe, expect, it } from "vitest";
import { parseVersion } from "./version.js";

describe("parseVersion", () => {
  it("captures basic semver after product name", () => {
    expect(parseVersion("claude 1.2.3", "claude")).toBe("1.2.3");
    expect(parseVersion("codex 0.9.0\n", "codex")).toBe("0.9.0");
  });

  it("ignores unrelated digits earlier in stdout", () => {
    expect(parseVersion("Node v20.11.0\ngemini 1.2.3", "gemini")).toBe("1.2.3");
  });

  it("preserves CalVer", () => {
    expect(parseVersion("claude 2025.01.15", "claude")).toBe("2025.01.15");
  });

  it("preserves pre-release/build suffixes", () => {
    expect(parseVersion("opencode 0.4.1-beta.1", "opencode")).toBe("0.4.1-beta.1");
    expect(parseVersion("codex 1.0.0+sha.abc", "codex")).toBe("1.0.0+sha.abc");
  });

  it("falls back to last version-shaped token when product name absent", () => {
    expect(parseVersion("version: 3.4.5", "missing")).toBe("3.4.5");
  });

  it("returns undefined when no version present", () => {
    expect(parseVersion("hello world", "claude")).toBeUndefined();
    expect(parseVersion("", "codex")).toBeUndefined();
  });
});

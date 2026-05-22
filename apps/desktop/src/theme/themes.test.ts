import { describe, it, expect, beforeEach } from "vitest";
import {
  applyTheme,
  getTheme,
  listThemes,
  registerTheme,
  DEFAULT_THEME_ID,
  type ThemeDefinition,
} from "./themes";

describe("theme registry", () => {
  it("exposes the built-in operational themes", () => {
    expect(getTheme(DEFAULT_THEME_ID)).toBeDefined();
    expect(getTheme("operational-light")).toBeDefined();
  });

  it("listThemes returns all registered themes", () => {
    const ids = listThemes().map((t) => t.id);
    expect(ids).toContain("operational-dark");
    expect(ids).toContain("operational-light");
  });

  it("registerTheme adds a new theme that getTheme can retrieve", () => {
    const custom: ThemeDefinition = {
      id: "test-custom",
      label: "Test Custom",
      mode: "dark",
      tokens: { "--bg": "#123456", "--text": "#fff", "--accent": "#abcdef" },
    };
    registerTheme(custom);
    expect(getTheme("test-custom")).toEqual(custom);
  });
});

describe("applyTheme", () => {
  let target: HTMLElement;

  beforeEach(() => {
    target = document.createElement("div");
  });

  it("writes every token onto the target's inline style and sets data attrs", () => {
    const theme: ThemeDefinition = {
      id: "demo",
      label: "Demo",
      mode: "dark",
      tokens: { "--bg": "#000", "--accent": "#f0f" },
    };
    applyTheme(theme, target);
    expect(target.style.getPropertyValue("--bg")).toBe("#000");
    expect(target.style.getPropertyValue("--accent")).toBe("#f0f");
    expect(target.dataset.theme).toBe("demo");
    expect(target.dataset.themeMode).toBe("dark");
  });
});

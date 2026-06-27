import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentProvider } from "./registry.js";

const claude = resolveAgentProvider("claude-code");

describe("permissionRule (claude)", () => {
  it("Bash → program prefix from the first token", () => {
    expect(claude.permissionRule("Bash", { command: "rm -rf build" })).toBe("Bash(rm:*)");
    expect(claude.permissionRule("Bash", { command: "  npm   test " })).toBe("Bash(npm:*)");
  });
  it("Bash with empty command → null", () => {
    expect(claude.permissionRule("Bash", { command: "   " })).toBeNull();
    expect(claude.permissionRule("Bash", {})).toBeNull();
  });
  it("Read/Edit/Write → exact file path", () => {
    expect(claude.permissionRule("Read", { file_path: "/p/a.ts" })).toBe("Read(/p/a.ts)");
    expect(claude.permissionRule("Edit", { file_path: "/p/b.ts" })).toBe("Edit(/p/b.ts)");
    expect(claude.permissionRule("Write", { file_path: "/p/c.ts" })).toBe("Write(/p/c.ts)");
  });
  it("NotebookEdit → notebook_path", () => {
    expect(claude.permissionRule("NotebookEdit", { notebook_path: "/p/n.ipynb" })).toBe("NotebookEdit(/p/n.ipynb)");
  });
  it("WebFetch → domain from url; unparseable → null", () => {
    expect(claude.permissionRule("WebFetch", { url: "https://api.github.com/x" })).toBe("WebFetch(domain:api.github.com)");
    expect(claude.permissionRule("WebFetch", { url: "not a url" })).toBeNull();
  });
  it("unknown tool / missing path → null", () => {
    expect(claude.permissionRule("Glob", { pattern: "**" })).toBeNull();
    expect(claude.permissionRule("Read", {})).toBeNull();
  });
  it("codex and antigravity return null (no writer yet)", () => {
    for (const id of ["codex", "antigravity"] as const) {
      expect(resolveAgentProvider(id).permissionRule("Bash", { command: "ls" })).toBeNull();
    }
  });
});

describe("writePermissionRule (claude)", () => {
  let ws: string;
  afterEach(() => { if (ws) rmSync(ws, { recursive: true, force: true }); });

  it("creates .claude/settings.local.json and adds the rule", () => {
    ws = mkdtempSync(join(tmpdir(), "orca-ws-"));
    claude.writePermissionRule(ws, "Bash(rm:*)");
    const file = join(ws, ".claude", "settings.local.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).permissions.allow).toContain("Bash(rm:*)");
  });

  it("merges into existing allow, dedupes, and preserves other keys", () => {
    ws = mkdtempSync(join(tmpdir(), "orca-ws-"));
    mkdirSync(join(ws, ".claude"), { recursive: true });
    const file = join(ws, ".claude", "settings.local.json");
    writeFileSync(file, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, model: "x" }), "utf8");
    claude.writePermissionRule(ws, "Bash(rm:*)");
    claude.writePermissionRule(ws, "Bash(rm:*)"); // dedupe
    const json = JSON.parse(readFileSync(file, "utf8"));
    expect(json.permissions.allow).toEqual(["Bash(ls:*)", "Bash(rm:*)"]);
    expect(json.model).toBe("x");
  });

  it("skips the write (never clobbers) when the file is malformed JSON", () => {
    ws = mkdtempSync(join(tmpdir(), "orca-ws-"));
    mkdirSync(join(ws, ".claude"), { recursive: true });
    const file = join(ws, ".claude", "settings.local.json");
    writeFileSync(file, "{ not json", "utf8");
    claude.writePermissionRule(ws, "Bash(rm:*)");
    expect(readFileSync(file, "utf8")).toBe("{ not json"); // untouched
  });

  it("leaves a non-object (array/primitive) settings file untouched", () => {
    ws = mkdtempSync(join(tmpdir(), "orca-ws-"));
    mkdirSync(join(ws, ".claude"), { recursive: true });
    const file = join(ws, ".claude", "settings.local.json");
    writeFileSync(file, "[]", "utf8");
    claude.writePermissionRule(ws, "Bash(rm:*)");
    expect(readFileSync(file, "utf8")).toBe("[]"); // untouched, rule not written
  });
});

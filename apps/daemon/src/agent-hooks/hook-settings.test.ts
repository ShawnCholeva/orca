import { describe, it, expect } from "vitest";
import { buildAgentHookSettings } from "./hook-settings.js";

describe("buildAgentHookSettings", () => {
  const settings = buildAgentHookSettings({
    sessionId: "s1",
    resolverCommand: ["/abs/orca-daemon"],
  });

  it("emits command hooks (no http url, no token)", () => {
    const json = JSON.stringify(settings);
    expect(json).not.toContain("http://");
    expect(json).not.toContain("Bearer");
    expect(settings.hooks.Stop[0].hooks[0].type).toBe("command");
  });

  it("stop hook targets the agent-hooks stop relUrl and is spoolable", () => {
    const cmd = settings.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain("hook");
    expect(cmd).toContain("/v1/agent-hooks/stop?sessionId=s1");
    expect(cmd).toContain("--spool");
  });

  it("permission hook is NOT spoolable", () => {
    const cmd = settings.hooks.PermissionRequest![0].hooks[0].command;
    expect(cmd).toContain("/v1/agent-hooks/permission?sessionId=s1");
    expect(cmd).not.toContain("--spool");
  });

  it("gates bash and edit tools with a blocking PreToolUse hook", () => {
    // PermissionRequest alone cannot enforce a read-only step: it never fires for
    // calls a workspace allow-rule already approved. PreToolUse fires for every one.
    const entry = settings.hooks.PreToolUse!.find((h) => h.matcher.includes("Write"))!;
    expect(entry.matcher).toBe("Bash|Edit|Write|MultiEdit|NotebookEdit");
    expect(entry.hooks[0].command).toContain("/v1/agent-hooks/tool-gate?sessionId=s1");
    expect(entry.hooks[0].command).not.toContain("--spool"); // must block to deny
  });

  it("shell-quotes resolver args with spaces", () => {
    const s = buildAgentHookSettings({ sessionId: "s1", resolverCommand: ["/abs path/orca-daemon"] });
    expect(s.hooks.Stop[0].hooks[0].command).toContain("'/abs path/orca-daemon'");
  });
});

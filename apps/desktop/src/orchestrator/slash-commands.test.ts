import { describe, expect, it } from "vitest";
import { matchSlashCommands, parseSlashCommand, SLASH_COMMANDS } from "./slash-commands";

describe("parseSlashCommand", () => {
  it("parses a bare command", () => {
    expect(parseSlashCommand("/stuck")).toEqual({ command: "stuck", args: "" });
  });
  it("parses a command with a reason", () => {
    expect(parseSlashCommand("/stuck going in circles")).toEqual({
      command: "stuck", args: "going in circles",
    });
  });
  it("returns null for ordinary messages", () => {
    expect(parseSlashCommand("what is the status?")).toBeNull();
    expect(parseSlashCommand("use the /v1 endpoint")).toBeNull();
  });
  it("returns null for an unknown command so it is sent as a normal message", () => {
    expect(parseSlashCommand("/nope")).toBeNull();
  });
  it("ignores leading whitespace", () => {
    expect(parseSlashCommand("  /stuck ")).toEqual({ command: "stuck", args: "" });
  });
});

describe("matchSlashCommands", () => {
  it("offers every command for a bare slash", () => {
    expect(matchSlashCommands("/")).toEqual(SLASH_COMMANDS);
  });
  it("filters by prefix", () => {
    expect(matchSlashCommands("/st").map((c) => c.name)).toEqual(["stuck"]);
    expect(matchSlashCommands("/zz")).toEqual([]);
  });
  it("offers nothing once the command has arguments", () => {
    expect(matchSlashCommands("/stuck going in circles")).toEqual([]);
  });
  it("offers nothing for ordinary text", () => {
    expect(matchSlashCommands("hello")).toEqual([]);
  });
});

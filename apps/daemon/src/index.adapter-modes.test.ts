import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "./migrations.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { ShellManualAdapter } from "./adapters/shell-manual.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import { CodexAdapter } from "./adapters/codex.js";
import { GeminiAdapter } from "./adapters/gemini.js";
import {
  seedAdapterExecutionModes,
  getAdapterExecutionModeConfig,
} from "./adapters/execution-modes.js";
import type { ExecutionMode } from "@orca/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIG_DIR = path.resolve(__dirname, "../migrations");

describe("daemon boot wiring: seed adapter execution modes from registered adapters", () => {
  it("seeds a config row per registered adapter using each adapter's supportedExecutionModes", () => {
    const db = new Database(":memory:");
    runMigrations(db, MIG_DIR);

    const registry = new AdapterRegistry();
    registry.register(new ShellManualAdapter());
    registry.register(new ClaudeCodeAdapter());
    registry.register(new OpenCodeAdapter());
    registry.register(new CodexAdapter());
    registry.register(new GeminiAdapter());

    const supportedByAdapter: Record<string, ExecutionMode[]> = {};
    for (const adapter of registry.listAgentAdapters()) {
      supportedByAdapter[adapter.id] = adapter.supportedExecutionModes;
    }

    seedAdapterExecutionModes(db, () => "2026-05-28T00:00:00.000Z", supportedByAdapter);

    for (const id of ["claude-code", "codex", "opencode", "gemini-cli", "shell-manual"]) {
      const cfg = getAdapterExecutionModeConfig(db, id);
      expect(cfg, `config for ${id}`).not.toBeNull();
    }

    const cc = getAdapterExecutionModeConfig(db, "claude-code");
    expect(cc!.enabledExecutionModes.find((e) => e.preferred)?.mode).toBe("shadow_session");
  });
});

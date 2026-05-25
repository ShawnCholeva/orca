import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../../config.js";
import { closeDatabase, openDatabase } from "../../../db.js";
import { defaultMigrationsDir, runMigrations } from "../../../migrations.js";
import {
  generateWorkerHookConfig,
  recordWorkerHookTrace,
  resolveWorkerHookCapabilities,
  toContractWorkerHookCapabilities,
  type WorkerHookCapability,
} from "./hooks.js";

const NOW = "2026-01-01T00:00:00.000Z";
const tempDirs: string[] = [];

function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    getAuthToken: () => "test-token",
  };
}

function setupDb(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-worker-hooks-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  return db;
}

function seedWorkflowGraph(db: Database.Database): void {
  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at) VALUES ('goal-1', 'Goal', '', 'active', 1, ?, ?, NULL)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', '', 1, 1, 1, '[]', '[]', ?, ?)"
  ).run(NOW, NOW);
  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', 'goal-1', 'orca/engineering', 1, 'active', NULL, NULL, ?, NULL)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint) VALUES ('step-1', 'goal-1', 'run-1', 'execution', 1, 1, 'active', '[]', '[]', NULL, ?, NULL, 'fp-step-1')"
  ).run(NOW);
  db.prepare(
    "INSERT INTO orchestration_workers (id, provider_id, model, adapter_id, state, created_at) VALUES ('worker-1', 'orca/openai', 'gpt-5', 'codex', 'ready', ?)"
  ).run(NOW);
  db.prepare(
    "INSERT INTO orchestration_transport_attempts (id, goal_id, workflow_run_id, step_run_id, decision_id, provider_id, model, transport, worker_id, status, failure_reason, failure_message, raw_text_length, latency_ms, input_fingerprint, created_at, finished_at) VALUES ('attempt-1', 'goal-1', 'run-1', 'step-1', NULL, 'orca/openai', 'gpt-5', 'hidden_interactive', 'worker-1', 'running', NULL, NULL, NULL, NULL, 'fp-attempt-1', ?, NULL)"
  ).run(NOW);
}

function byEvent(
  capabilities: WorkerHookCapability[],
  eventName: string
): WorkerHookCapability {
  const capability = capabilities.find((entry) => entry.eventName === eventName);
  expect(capability).toBeDefined();
  return capability!;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("hidden-worker hook capabilities", () => {
  it("detects provider capability maps without granting hook authority", () => {
    const claude = resolveWorkerHookCapabilities({
      providerId: "orca/anthropic",
      adapterId: "claude-code",
    });
    expect(claude.canGenerateWorkerConfig).toBe(true);
    expect(byEvent(claude.capabilities, "SessionStart").status).toBe("supported");
    expect(byEvent(claude.capabilities, "UserPromptSubmit").status).toBe("supported");
    expect(byEvent(claude.capabilities, "PreToolUse").status).toBe("supported");
    expect(byEvent(claude.capabilities, "PermissionRequest").status).toBe("supported");
    expect(byEvent(claude.capabilities, "StopFailure").status).toBe("supported");

    const codex = resolveWorkerHookCapabilities({
      providerId: "orca/openai",
      adapterId: "codex",
    });
    expect(byEvent(codex.capabilities, "SessionStart").status).toBe("supported");
    expect(byEvent(codex.capabilities, "StopFailure").status).toBe("verify");
    expect(byEvent(codex.capabilities, "SessionEnd").status).toBe("verify");

    const gemini = resolveWorkerHookCapabilities({
      providerId: "orca/google-gemini",
      adapterId: "gemini-cli",
    });
    expect(byEvent(gemini.capabilities, "BeforeAgent").status).toBe("verify");
    expect(byEvent(gemini.capabilities, "BeforeModel").status).toBe("supported");
    expect(byEvent(gemini.capabilities, "AfterModel").status).toBe("supported");
    expect(byEvent(gemini.capabilities, "BeforeToolSelection").status).toBe(
      "supported"
    );
    expect(byEvent(gemini.capabilities, "BeforeTool").status).toBe("supported");
    expect(byEvent(gemini.capabilities, "AfterTool").status).toBe("supported");
    expect(byEvent(gemini.capabilities, "AfterAgent").status).toBe("supported");
    expect(byEvent(gemini.capabilities, "SessionEnd").status).toBe("supported");

    expect(toContractWorkerHookCapabilities(gemini, NOW)).toEqual({
      providerId: "orca/google-gemini",
      supportsPromptHooks: true,
      supportsStopHooks: true,
      supportsStateHooks: true,
      detectedAt: NOW,
    });
  });

  it("skips capabilities when the adapter does not confirm provider hook support", () => {
    const resolved = resolveWorkerHookCapabilities({
      providerId: "orca/anthropic",
      adapterId: "codex",
    });

    expect(resolved.canGenerateWorkerConfig).toBe(false);
    expect(resolved.configScope).toBe("unsupported");
    expect(resolved.capabilities.every((entry) => entry.status === "skipped")).toBe(
      true
    );
    expect(resolved.skippedReason).toContain("does not confirm");
  });
});

describe("hidden-worker hook config generation", () => {
  it("writes scoped config under the Orca runtime directory only", () => {
    const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "orca-runtime-hooks-"));
    tempDirs.push(runtimeDir);

    const result = generateWorkerHookConfig({
      runtimeDir,
      providerId: "orca/openai",
      adapterId: "codex",
      workerId: "../../worker:1",
      attemptId: "attempt-1",
      now: () => NOW,
    });

    expect(result.configPath).not.toBeNull();
    const configPath = result.configPath!;
    const relative = path.relative(path.resolve(runtimeDir), configPath);
    expect(relative.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);
    expect(configPath).toContain(path.join("orchestration-workers", "codex"));
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      scope: string;
      authority: string;
      workflowMutationAllowed: boolean;
      mutationCredentialsAllowed: boolean;
      hooks: Array<{
        eventName: string;
        status: string;
        enabled: boolean;
        traceOnly: boolean;
      }>;
    };

    expect(config.scope).toBe("worker");
    expect(config.authority).toBe("trace_only");
    expect(config.workflowMutationAllowed).toBe(false);
    expect(config.mutationCredentialsAllowed).toBe(false);
    expect(config.hooks.every((hook) => hook.traceOnly)).toBe(true);
    expect(config.hooks.find((hook) => hook.eventName === "StopFailure")).toMatchObject({
      status: "verify",
      enabled: false,
    });
    expect(JSON.stringify(config)).not.toContain("Bearer");
    expect(JSON.stringify(config)).not.toContain("api_key=");
  });

  it("does not write config when only global hook installation is available", () => {
    const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "orca-runtime-hooks-"));
    tempDirs.push(runtimeDir);

    const result = generateWorkerHookConfig({
      runtimeDir,
      providerId: "orca/anthropic",
      adapterId: "claude-code",
      workerId: "worker-1",
      attemptId: "attempt-1",
      configScope: "global",
      now: () => NOW,
    });

    expect(result.configPath).toBeNull();
    expect(result.capabilities.every((entry) => entry.status === "skipped")).toBe(
      true
    );
    expect(existsSync(path.join(runtimeDir, "orchestration-workers"))).toBe(false);
    expect(result.skippedReason).toContain("explicit user opt-in");
  });
});

describe("hidden-worker hook traces", () => {
  it("persists only capped and redacted hook summaries", () => {
    const db = setupDb();
    seedWorkflowGraph(db);

    const row = recordWorkerHookTrace(
      {
        db,
        now: () => NOW,
        idFactory: () => "trace-1",
      },
      {
        attemptId: "attempt-1",
        workerId: "worker-1",
        providerId: "orca/openai",
        hookEventName: "AfterTool",
        hookStatus: "failed",
        summary: `Authorization: Bearer abc.def.ghi ${"x".repeat(500)}`,
        failureReason: "interactive_output_invalid",
      }
    );

    expect(row.id).toBe("trace-1");
    expect(row.hook_event_name).toBe("AfterTool");
    expect(row.hook_status).toBe("failed");
    expect(row.failure_reason).toBe("interactive_output_invalid");
    expect(row.summary).toContain("<redacted>");
    expect(row.summary).not.toContain("abc.def.ghi");
    expect(row.summary.length).toBeLessThanOrEqual(256);

    const persisted = db
      .prepare("SELECT summary FROM orchestration_worker_hook_traces WHERE id = ?")
      .get("trace-1") as { summary: string };
    expect(persisted.summary).toBe(row.summary);
  });
});

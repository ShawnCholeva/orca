import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import type {
  OperatorDescriptor,
  StepSkillProposal,
} from "@orca/contracts";

import type { Config } from "../../config.js";
import { openDatabase } from "../../db.js";
import { EventBus } from "../../events.js";
import { defaultMigrationsDir, runMigrations } from "../../migrations.js";
import type { OperatorRegistry } from "../operators/registry.js";
import type {
  BrokerCompatibilityOptions,
  BrokerResult,
  OrchestrationTransportBroker,
} from "../orchestration-transport/broker.js";
import type { StepDispatchCapabilities } from "./service.js";

export const NOW = "2026-01-01T00:00:00.000Z";
export const MODEL_OPERATOR_ID = "orca/anthropic:claude-sonnet-4-6";
export const AGENT_OPERATOR_ID = "agent:claude-code";

const tempDirs: string[] = [];

export function createConfig(dataDir: string): Config {
  return {
    dataDir,
    port: 8787,
    logLevel: "silent",
    sessionOutputTailBytes: 1024 * 1024,
    sessionStopGraceMs: 5000,
    sessionWsBufferLimitBytes: 1024 * 1024,
    memoryExtractionMaxInputBytes: 131072,
    memoryExtractionTimeoutMs: 15000,
    hookResolverCommand: ["node", "test-daemon.js"],
    getAuthToken: () => "test-token",
  };
}

export interface SkillStepHarness {
  db: Database.Database;
  bus: EventBus;
  idFactory: () => string;
}

export function setupHarness(): SkillStepHarness {
  const dir = mkdtempSync(path.join(os.tmpdir(), "orca-wf-skill-step-"));
  tempDirs.push(dir);
  const db = openDatabase(createConfig(dir));
  runMigrations(db, defaultMigrationsDir());
  const bus = new EventBus();
  let nextId = 0;
  return {
    db,
    bus,
    idFactory: () => `fixed-id-${++nextId}`,
  };
}

export function cleanupHarness(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface SkillStep {
  id: string;
  ordinal: number;
  name: string;
  instructions: string;
  outputSchema: Array<{ key: string; type: string; required: boolean }>;
  agentPreference: Array<{ adapterId: string; modelId: string }>;
}

export function makeStep(patch: Partial<SkillStep> = {}): SkillStep {
  return {
    id: "plan",
    ordinal: 0,
    name: "Plan",
    instructions: "Plan the work and produce a problem statement.",
    outputSchema: [{ key: "problem", type: "string", required: true }],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
    ...patch,
  };
}

export interface SeedWorkflowArgs {
  steps?: SkillStep[];
  goalId?: string;
  stepStatus?: string;
  selectedOperatorId?: string;
  selectedProviderId?: string;
  selectedModelId?: string;
  operatorSelectedAt?: string;
}

export function seedSkillWorkflow(db: Database.Database, args: SeedWorkflowArgs = {}): void {
  const goalId = args.goalId ?? "goal-1";
  const steps =
    args.steps ?? [
      makeStep(),
      makeStep({
        id: "build",
        ordinal: 1,
        name: "Build",
        instructions: "Implement the plan.",
        outputSchema: [{ key: "result", type: "string", required: true }],
        agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
      }),
    ];
  const current = steps[0]!;

  db.prepare(
    "INSERT INTO goals (id, title, description, status, autonomy_level, created_at, updated_at, archived_at, orchestrator_provider, orchestrator_model) VALUES (?, 'Goal', 'Goal desc', 'active', 1, ?, ?, NULL, NULL, NULL)"
  ).run(goalId, NOW, NOW);

  db.prepare(
    "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES ('orca/engineering', 'Engineering', 'desc', 1, 1, 1, ?, '[]', ?, ?)"
  ).run(JSON.stringify(steps), NOW, NOW);

  db.prepare(
    "INSERT INTO workflow_runs (id, goal_id, template_id, template_version, status, current_step_run_id, blocked_reason, started_at, finished_at) VALUES ('run-1', ?, 'orca/engineering', 1, 'active', 'step-1', NULL, ?, NULL)"
  ).run(goalId, NOW);

  db.prepare(
    "INSERT INTO workflow_step_runs (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status, satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason, started_at, finished_at, fingerprint, selected_operator_id, selected_provider_id, selected_model_id, operator_selected_at) VALUES ('step-1', ?, 'run-1', ?, ?, 1, ?, '[]', '[]', NULL, ?, NULL, 'fp-1', ?, ?, ?, ?)"
  ).run(
    goalId,
    current.id,
    current.ordinal,
    args.stepStatus ?? "active",
    NOW,
    args.selectedOperatorId ?? null,
    args.selectedProviderId ?? null,
    args.selectedModelId ?? null,
    args.operatorSelectedAt ?? null
  );
}

export function modelOperatorDescriptor(): OperatorDescriptor {
  return {
    id: MODEL_OPERATOR_ID,
    kind: "model",
    displayName: "Claude",
    capabilities: [],
    ready: true,
    supportsRepoEditing: false,
    supportsTerminal: false,
    providerId: "orca/anthropic",
    modelId: "claude-sonnet-4-6",
  };
}

export function agentOperatorDescriptor(): OperatorDescriptor {
  return {
    id: AGENT_OPERATOR_ID,
    kind: "agent",
    displayName: "Claude Code",
    capabilities: [],
    ready: true,
    supportsRepoEditing: true,
    supportsTerminal: true,
  };
}

export function fakeRegistry(): Pick<OperatorRegistry, "list"> {
  return {
    async list() {
      return [agentOperatorDescriptor(), modelOperatorDescriptor()];
    },
  };
}

export function fakeStepDispatch(): StepDispatchCapabilities {
  return {
    async isAdapterReady(adapterId) {
      return adapterId === "claude-code";
    },
    supportsModel(adapterId, modelId) {
      return adapterId === "claude-code" && modelId === "claude-haiku-4-5";
    },
    resolveMode(adapterId) {
      return { adapterId, mode: "one_shot", fallbacks: ["shadow_session"] };
    },
  };
}

// Broker that runs the supplied validateProposal against a fixed raw proposal.
export function fakeBroker(raw: StepSkillProposal): Pick<OrchestrationTransportBroker, "propose"> {
  return {
    async propose(_req, opts?: BrokerCompatibilityOptions): Promise<BrokerResult> {
      const v = opts?.validateProposal
        ? await opts.validateProposal(raw)
        : { accepted: true as const };
      if (!v.accepted) {
        return { status: "needs_human_review", attemptId: "attempt-1", reviewPayloadId: "review-1" };
      }
      return {
        status: "proposed",
        attemptId: "attempt-1",
        transport: "one_shot",
        parsed: Object.prototype.hasOwnProperty.call(v, "parsed") ? v.parsed : raw,
        rawTextLength: null,
        latencyMs: 1,
      };
    },
  };
}

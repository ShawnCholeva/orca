import type Database from "better-sqlite3";
import {
  ProviderRecoveryCheckpoint,
  type WorkflowRun as WorkflowRunT,
  type WorkflowStepTemplate,
  type WorkflowTemplate as WorkflowTemplateT,
} from "@orca/contracts";
import type { OperatorRegistry } from "../operators/registry.js";
import { loadRunTemplate } from "../runs/run-template.js";
import { getWorkflowRunById } from "../runs/projection.js";
import { listAgents } from "../../agents.js";
import { buildProviderRecoveryChoices, composeProviderSwitchPrompt } from "./provider-recovery.js";
import { decodeSessionTail } from "./session-tail.js";
import { collectPriorStepArtifacts, latestRejectingGate } from "./repair-context.js";
import type { RunnerPort } from "./runner-port.js";
import type {
  StepDispatchCapabilities,
  RequestNextDecisionOptions,
} from "./dispatch-types.js";
import {
  OrchestratorProviderRecoveryNotFoundError,
  OrchestratorProviderRecoveryInvalidTransitionError,
} from "./service.js";
import {
  type GoalRow,
  type StepRunRow,
  readGoal,
  preferencesForGoal,
} from "./db-rows.js";
import { EventBus } from "../../events.js";
import { listGoalDocumentsByGoal } from "../../goal-documents/projection.js";
import { refreshGoalDocuments } from "../../goal-documents/usecases.js";

export class ProviderRecoveryController {
  constructor(
    private readonly deps: {
      runner: RunnerPort;
      operators: Pick<OperatorRegistry, "list">;
      stepDispatch: StepDispatchCapabilities | undefined;
    }
  ) {}

  /**
   * Validates that a recovery action targets a live, matching checkpoint:
   * run/step active, current step matches the checkpoint step, checkpoint
   * parses, the requested id matches, and the current session still belongs to
   * the step. Throws NotFound for missing/mismatched targets and the
   * invalid-transition error type elsewhere.
   */
  private loadProviderRecoveryContext(
    db: Database.Database,
    runId: string,
    checkpointId: string
  ): {
    run: WorkflowRunT;
    stepRun: StepRunRow;
    stepTpl: WorkflowStepTemplate;
    template: WorkflowTemplateT;
    goal: GoalRow;
    checkpoint: ProviderRecoveryCheckpoint;
  } {
    const run = getWorkflowRunById(db, runId);
    if (!run) throw new OrchestratorProviderRecoveryNotFoundError(`workflow run not found: ${runId}`);
    if (run.status !== "active" || !run.currentStepRunId) {
      throw new OrchestratorProviderRecoveryNotFoundError(`workflow run not active: ${runId}`);
    }
    const stepRun = db
      .prepare("SELECT * FROM workflow_step_runs WHERE id = ?")
      .get(run.currentStepRunId) as StepRunRow | undefined;
    if (!stepRun || stepRun.status !== "active") {
      throw new OrchestratorProviderRecoveryNotFoundError(`active step run not found for run: ${runId}`);
    }
    if (!stepRun.pending_provider_recovery_json) {
      throw new OrchestratorProviderRecoveryNotFoundError(`no pending provider recovery for run: ${runId}`);
    }
    let checkpoint: ProviderRecoveryCheckpoint;
    try {
      checkpoint = ProviderRecoveryCheckpoint.parse(
        JSON.parse(stepRun.pending_provider_recovery_json)
      );
    } catch {
      throw new OrchestratorProviderRecoveryNotFoundError(
        `malformed provider recovery checkpoint for run: ${runId}`
      );
    }
    if (checkpoint.id !== checkpointId) {
      throw new OrchestratorProviderRecoveryNotFoundError(
        `provider recovery checkpoint mismatch: ${checkpointId}`
      );
    }
    const template = loadRunTemplate(db, run);
    if (!template) throw new OrchestratorProviderRecoveryNotFoundError(`template not found: ${run.templateId}`);
    const stepTpl = template.steps.find((s) => s.id === stepRun.step_template_id);
    if (!stepTpl) throw new OrchestratorProviderRecoveryNotFoundError(`step template not found: ${stepRun.step_template_id}`);
    const goal = readGoal(db, run.goalId);

    const sessRow = db
      .prepare("SELECT workflow_step_run_id FROM sessions WHERE id = ?")
      .get(checkpoint.currentSessionId) as { workflow_step_run_id: string | null } | undefined;
    if (!sessRow || sessRow.workflow_step_run_id !== stepRun.id) {
      throw new OrchestratorProviderRecoveryNotFoundError(
        `recovery session no longer belongs to the step: ${checkpoint.currentSessionId}`
      );
    }

    return { run, stepRun, stepTpl, template, goal, checkpoint };
  }

  private persistCheckpoint(
    db: Database.Database,
    stepRunId: string,
    next: ProviderRecoveryCheckpoint
  ): void {
    db.prepare(
      "UPDATE workflow_step_runs SET pending_provider_recovery_json = ? WHERE id = ?"
    ).run(JSON.stringify(ProviderRecoveryCheckpoint.parse(next)), stepRunId);
  }

  /** choose → waiting; preserves the session and drives the provider wait interaction. */
  async waitForProvider(
    db: Database.Database,
    now: () => string,
    runId: string,
    checkpointId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    void options;
    const { stepRun, checkpoint } = this.loadProviderRecoveryContext(db, runId, checkpointId);
    if (checkpoint.mode !== "choose") {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `Wait is only allowed while choosing (mode: ${checkpoint.mode}).`
      );
    }
    this.persistCheckpoint(db, stepRun.id, { ...checkpoint, mode: "waiting", lastError: null });
    try {
      await this.deps.runner.workerWait(checkpoint.currentSessionId, checkpoint.currentAdapterId);
    } catch (err) {
      this.persistCheckpoint(db, stepRun.id, {
        ...checkpoint,
        mode: "choose",
        lastError: (err instanceof Error ? err.message : "wait failed").slice(0, 512),
      });
      throw err;
    }
  }

  /**
   * waiting → retrying. Preserved-session: stores the current output_seq and
   * delivers a continue prompt to the same worker. Fresh-session: launches a
   * replacement of the same adapter with bounded handoff context.
   */
  async retryProvider(
    db: Database.Database,
    now: () => string,
    runId: string,
    checkpointId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const ctx = this.loadProviderRecoveryContext(db, runId, checkpointId);
    const { stepRun, checkpoint } = ctx;
    if (checkpoint.mode !== "waiting") {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `Retry is only allowed while waiting (mode: ${checkpoint.mode}).`
      );
    }
    if (
      checkpoint.retryKind === "preserved_session" &&
      checkpoint.resetAt !== null &&
      Date.parse(checkpoint.resetAt) > Date.parse(now())
    ) {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `Retry is not yet available; the provider resets at ${checkpoint.resetTimeText ?? checkpoint.resetAt}.`
      );
    }

    if (checkpoint.retryKind === "fresh_session") {
      await this.startRecoveryReplacementSession(
        db,
        now,
        ctx,
        checkpoint.currentAdapterId,
        "retrying",
        options
      );
      return;
    }

    const outputSeq = this.deps.runner.readTail(checkpoint.currentSessionId).nextSeq;
    this.persistCheckpoint(db, stepRun.id, {
      ...checkpoint,
      mode: "retrying",
      retryOutputSeq: outputSeq,
      lastError: null,
    });
    try {
      await this.deps.runner.workerDeliver(checkpoint.currentSessionId, "Continue the previous step request.");
    } catch (err) {
      this.persistCheckpoint(db, stepRun.id, {
        ...checkpoint,
        mode: "waiting",
        retryOutputSeq: null,
        lastError: (err instanceof Error ? err.message : "retry failed").slice(0, 512),
      });
      throw err;
    }
  }

  /** Rebuilds the switch choices from current readiness, preserving id + mode. */
  async refreshProviderRecovery(
    db: Database.Database,
    now: () => string,
    runId: string,
    checkpointId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    void options;
    void now;
    const { run, stepRun, stepTpl, goal, checkpoint } = this.loadProviderRecoveryContext(
      db,
      runId,
      checkpointId
    );
    if (checkpoint.mode !== "choose" && checkpoint.mode !== "waiting") {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `Refresh is only allowed while choosing or waiting (mode: ${checkpoint.mode}).`
      );
    }
    const connectedAdapterIds = listAgents(db)
      .filter((agent) => agent.connected)
      .map((agent) => agent.id);
    const operatorDescriptors = await this.deps.operators.list(run.goalId, {
      agentIds: connectedAdapterIds,
      includeNonAgents: false,
    });
    const choices = buildProviderRecoveryChoices({
      currentAdapterId: checkpoint.currentAdapterId,
      connectedAdapterIds,
      stepPreferences: preferencesForGoal(stepTpl.agentPreference, goal.orchestrator_provider),
      operators: operatorDescriptors,
      supportsModel: (id, mid) => this.deps.stepDispatch?.supportsModel(id, mid) ?? false,
    });
    this.persistCheckpoint(db, stepRun.id, { ...checkpoint, choices });
  }

  /**
   * choose|waiting → switching. Validates the target against the live choice
   * set, then launches a replacement session for that adapter. The committed
   * switching output branch commits selection + retires the old session once the
   * replacement produces started output.
   */
  async switchProvider(
    db: Database.Database,
    now: () => string,
    runId: string,
    checkpointId: string,
    adapterId: string,
    options: RequestNextDecisionOptions = {}
  ): Promise<void> {
    const ctx = this.loadProviderRecoveryContext(db, runId, checkpointId);
    const { checkpoint } = ctx;
    if (checkpoint.mode !== "choose" && checkpoint.mode !== "waiting") {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `Switch is only allowed while choosing or waiting (mode: ${checkpoint.mode}).`
      );
    }
    if (adapterId === checkpoint.currentAdapterId) {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `Cannot switch to the limited provider (${adapterId}).`
      );
    }
    const choice = checkpoint.choices.find((c) => c.adapterId === adapterId);
    if (!choice) {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `${adapterId} is not an available recovery choice.`
      );
    }
    if (!choice.enabled || !choice.modelId) {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `${choice.displayName} is not available: ${choice.reason ?? "provider unavailable"}.`
      );
    }
    const ready = await (this.deps.stepDispatch?.isAdapterReady(adapterId) ?? Promise.resolve(false));
    if (!ready) {
      throw new OrchestratorProviderRecoveryInvalidTransitionError(
        `${choice.displayName} became unavailable.`
      );
    }
    await this.startRecoveryReplacementSession(db, now, ctx, adapterId, "switching", options);
  }

  /**
   * Launches a replacement worker for the given adapter using a bounded
   * interrupted-session handoff (with any pending guidance), records the
   * replacement session id + its pre-delivery output_seq, and moves the
   * checkpoint to the supplied terminal-progress mode (retrying for a fresh
   * retry, switching for a provider switch). The old session is retained; it is
   * retired only by the committed output branch once the replacement starts.
   * On launch failure the old session is preserved and the checkpoint is
   * restored to choose with a bounded lastError.
   */
  private async startRecoveryReplacementSession(
    db: Database.Database,
    now: () => string,
    ctx: {
      run: WorkflowRunT;
      stepRun: StepRunRow;
      stepTpl: WorkflowStepTemplate;
      template: WorkflowTemplateT;
      goal: GoalRow;
      checkpoint: ProviderRecoveryCheckpoint;
    },
    adapterId: string,
    mode: "retrying" | "switching",
    options: RequestNextDecisionOptions
  ): Promise<void> {
    void now;
    const { run, stepRun, stepTpl, goal, checkpoint } = ctx;
    const interruptedTail = decodeSessionTail(
      this.deps.runner.readTail(checkpoint.currentSessionId)
    );
    const guidanceBlock =
      checkpoint.pendingGuidance.length > 0
        ? `\n\n# Operator guidance\n${checkpoint.pendingGuidance.join("\n\n")}`
        : "";
    // Refresh-on-use: the handoff prompt re-injects reference documents, so
    // bring their snapshots up to date first (stale fallback on failure).
    await refreshGoalDocuments(db, options.bus ?? new EventBus(), goal.id);
    const documentRows = listGoalDocumentsByGoal(db, goal.id);
    const handoffPrompt =
      composeProviderSwitchPrompt({
        agentPromptInput: {
          goalTitle: goal.title,
          goalIntent: goal.intent,
          stepInstructions: stepTpl.instructions,
          outputSchema: stepTpl.outputSchema,
          priorStepArtifacts: collectPriorStepArtifacts(db, run.id, stepRun.id),
          repairContext: latestRejectingGate(db, run.id),
          documents: documentRows.map((d) => ({ name: d.name, ref: d.ref, content: d.content, truncated: d.truncated === 1 })),
        },
        interruptedTail,
      }) + guidanceBlock;

    let sessionId: string;
    try {
      const launched = await this.deps.runner.launch({
        goalId: goal.id,
        workflowRunId: run.id,
        workflowStepRunId: stepRun.id,
        operatorId: "agent:" + adapterId,
        operatorKind: "agent",
        objective: handoffPrompt,
      });
      sessionId = launched.sessionId;
      await this.deps.runner.workerSpawn({ sessionId, goalId: goal.id, adapterId });
    } catch (err) {
      this.persistCheckpoint(db, stepRun.id, {
        ...checkpoint,
        mode: "choose",
        replacementSessionId: null,
        replacementOutputSeq: null,
        lastError: (err instanceof Error ? err.message : "replacement launch failed").slice(0, 512),
      });
      throw err;
    }

    // Pre-delivery output sequence: started-output detection compares against this.
    const replacementOutputSeq = this.deps.runner.readTail(sessionId).nextSeq;
    this.persistCheckpoint(db, stepRun.id, {
      ...checkpoint,
      mode,
      replacementSessionId: sessionId,
      replacementOutputSeq,
      lastError: null,
    });
    await this.deps.runner.workerDeliver(sessionId, handoffPrompt);
  }
}

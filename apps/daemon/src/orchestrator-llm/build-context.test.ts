import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { buildContextFromDb } from "./build-context.js";

function seed(db: Database.Database) {
  db.exec(`
    CREATE TABLE goals (id TEXT, title TEXT, description TEXT);
    CREATE TABLE orchestrator_messages (id TEXT, goal_id TEXT, role TEXT, kind TEXT, body TEXT, created_at TEXT);
    CREATE TABLE workspaces (id TEXT, path TEXT, name TEXT, description TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE goal_workspaces (goal_id TEXT, workspace_id TEXT, attached_at TEXT);
    CREATE TABLE goal_documents (id TEXT, goal_id TEXT, kind TEXT, ref TEXT, name TEXT, content TEXT, content_hash TEXT, content_bytes INTEGER, truncated INTEGER, fetched_at TEXT, created_at TEXT);
    CREATE TABLE workflow_templates (id TEXT PRIMARY KEY, name TEXT, description TEXT, version INTEGER, steps_json TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, goal_id TEXT, template_id TEXT, template_version INTEGER, status TEXT, current_step_run_id TEXT, started_at TEXT);
    CREATE TABLE workflow_step_runs (id TEXT PRIMARY KEY, goal_id TEXT, workflow_run_id TEXT, step_template_id TEXT, ordinal INTEGER, attempt INTEGER, status TEXT, started_at TEXT, fingerprint TEXT, selected_operator_id TEXT);
    CREATE TABLE workflow_artifacts (id TEXT PRIMARY KEY, goal_id TEXT, workflow_run_id TEXT, step_run_id TEXT, type TEXT, title TEXT, body TEXT, source TEXT, linked_session_id TEXT, linked_task_id TEXT, linked_context_package_id TEXT, created_at TEXT);
    INSERT INTO goals VALUES ('G1','T','D');
    INSERT INTO orchestrator_messages VALUES ('m1','G1','user','message','hello','2026-05-29T00:00:00Z');
  `);
}

function seedActiveRun(db: Database.Database) {
  const stepsJson = JSON.stringify([
    {
      id: "frame",
      ordinal: 0,
      name: "Frame",
      instructions: "interview the user",
      outputSchema: [{ key: "problem", type: "string", required: true }],
      agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
      completionPolicy: "interview",
    },
  ]);
  db.exec(`
    INSERT INTO workspaces (id, path, name, description, created_at, updated_at) VALUES ('ws1','/tmp/ws','My Workspace','','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
    INSERT INTO goal_workspaces (goal_id, workspace_id, attached_at) VALUES ('G1','ws1','2026-01-01T00:00:00Z');
    INSERT INTO workflow_templates VALUES ('tpl','Test Template','',1,'${stepsJson.replace(/'/g, "''")}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
    INSERT INTO workflow_runs VALUES ('r1','G1','tpl',1,'active','sr1','2026-01-01T00:00:00Z');
    INSERT INTO workflow_step_runs VALUES ('sr1','G1','r1','frame',0,1,'active','2026-01-01T00:00:00Z','fp1','agent:codex');
  `);
}

describe("buildContextFromDb", () => {
  it("includes goal metadata and recent chat messages", () => {
    const db = new Database(":memory:");
    seed(db);
    const ctx = buildContextFromDb(db, {
      goalId: "G1",
      runId: null,
      stepRunId: null,
      payloadBudgetBytes: 64 * 1024,
    });
    expect(ctx.goal.title).toBe("T");
    expect(ctx.conversation.chatMessages.some((m) => m.body === "hello")).toBe(true);
  });

  it("enriches currentStep with the real step + completionPolicy for an active run", () => {
    const db = new Database(":memory:");
    seed(db);
    seedActiveRun(db);
    const ctx = buildContextFromDb(db, {
      goalId: "G1",
      runId: "r1",
      stepRunId: "sr1",
      payloadBudgetBytes: 64 * 1024,
    });
    expect(ctx.currentStep.id).toBe("frame");
    expect(ctx.currentStep.instructions).toBe("interview the user");
    expect(ctx.currentStep.completionPolicy).toBe("interview");
    expect(ctx.currentStep.agentAdapterId).toBe("codex");
    expect(ctx.goal.attachedWorkspaces.length).toBeGreaterThan(0);
    expect(ctx.workflowRun.templateId).toBe("tpl");
    expect(ctx.workflowRun.status).toBe("active");
  });

  it("keeps the freeform placeholder when no run is active", () => {
    const db = new Database(":memory:");
    seed(db);
    const ctx = buildContextFromDb(db, {
      goalId: "G1",
      runId: null,
      stepRunId: null,
      payloadBudgetBytes: 64 * 1024,
    });
    expect(ctx.currentStep.id).toBe("");
  });

  it("reconstructs currentStepAgentTurns from interview_turn artifacts for the active step run", () => {
    const db = new Database(":memory:");
    seed(db);
    seedActiveRun(db);

    const turn0 = JSON.stringify({
      turnIndex: 0,
      questionDecisionId: "qd-0",
      question: "What is the problem?",
      answer: "The server is down.",
      answeredAt: "2026-06-01T10:00:00.000Z",
    });
    const turn1 = JSON.stringify({
      turnIndex: 1,
      questionDecisionId: "qd-1",
      question: "What have you tried?",
      answer: "Restarting did not help.",
      answeredAt: "2026-06-01T10:05:00.000Z",
    });

    db.exec(`
      INSERT INTO workflow_artifacts VALUES ('a1','G1','r1','sr1','interview_turn','Turn 0','${turn0.replace(/'/g, "''")}','agent',NULL,NULL,NULL,'2026-06-01T10:00:00Z');
      INSERT INTO workflow_artifacts VALUES ('a2','G1','r1','sr1','interview_turn','Turn 1','${turn1.replace(/'/g, "''")}','agent',NULL,NULL,NULL,'2026-06-01T10:05:00Z');
    `);

    const ctx = buildContextFromDb(db, {
      goalId: "G1",
      runId: "r1",
      stepRunId: "sr1",
      payloadBudgetBytes: 64 * 1024,
    });

    // Each InterviewTurn expands into two entries: agent question + user answer.
    expect(ctx.conversation.currentStepAgentTurns.length).toBe(4);
    expect(ctx.conversation.currentStepAgentTurns[0].role).toBe("agent");
    expect(ctx.conversation.currentStepAgentTurns[0].body).toBe("What is the problem?");
    expect(ctx.conversation.currentStepAgentTurns[1].role).toBe("user_via_orchestrator");
    expect(ctx.conversation.currentStepAgentTurns[1].body).toBe("The server is down.");
    expect(ctx.conversation.currentStepAgentTurns[2].role).toBe("agent");
    expect(ctx.conversation.currentStepAgentTurns[2].body).toBe("What have you tried?");
    expect(ctx.conversation.currentStepAgentTurns[3].role).toBe("user_via_orchestrator");
    expect(ctx.conversation.currentStepAgentTurns[3].body).toBe("Restarting did not help.");
  });
});

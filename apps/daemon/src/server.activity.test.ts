import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ListActivitiesResponse, ListOrchestratorMessagesResponse, type PendingQuestionItem } from "@orca/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { seedAgents } from "./agents.js";
import type { Config } from "./config.js";
import { createDaemonContext } from "./daemon-context.js";
import { closeDatabase, openDatabase } from "./db.js";
import { eventBus } from "./events.js";
import { defaultMigrationsDir, runMigrations } from "./migrations.js";
import { bootstrapRegistries } from "./registry/bootstrap.js";
import { createServer } from "./server.js";
// Local fixture: minimal engineering template row for workflow_runs FK constraint.
function seedEngineeringTemplate(db: ReturnType<typeof openDatabase>, now: () => string): void {
  const id = "orca/engineering";
  const existing = db.prepare("SELECT id FROM workflow_templates WHERE id = ?").get(id);
  if (existing) return;
  const ts = now();
  const agentPref = [{ adapterId: "claude-code", modelId: "claude-sonnet-4-6" }];
  const stepOut = [{ key: "summary", type: "string", required: true }];
  const steps = [
    { id: "intake", ordinal: 0, name: "Intake", instructions: "intake", outputSchema: stepOut, agentPreference: agentPref },
    { id: "research", ordinal: 1, name: "Research", instructions: "research", outputSchema: stepOut, agentPreference: agentPref },
    { id: "prd", ordinal: 2, name: "PRD", instructions: "prd", outputSchema: stepOut, agentPreference: agentPref },
    { id: "issue_breakdown", ordinal: 3, name: "Issue Breakdown", instructions: "breakdown", outputSchema: stepOut, agentPreference: agentPref },
    { id: "execution", ordinal: 4, name: "Execution", instructions: "execute", outputSchema: stepOut, agentPreference: agentPref },
    { id: "qa", ordinal: 5, name: "QA", instructions: "qa", outputSchema: stepOut, agentPreference: agentPref },
    { id: "review", ordinal: 6, name: "Review", instructions: "review", outputSchema: stepOut, agentPreference: agentPref },
    { id: "done", ordinal: 7, name: "Done", instructions: "done", outputSchema: stepOut, agentPreference: agentPref },
  ];
  db.prepare("INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, 5, 1, 1, ?, ?, ?, ?)")
    .run(id, "Engineering", "Engineering template fixture", JSON.stringify(steps), "[]", ts, ts);
}

const AUTH_HEADERS = { authorization: "Bearer test-token" } as const;
const NOW = "2026-06-06T12:00:00.000Z";

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

function seedLiveWorkflowSession(
  db: ReturnType<typeof openDatabase>,
  ids: { goalId: string; runId: string; stepRunId: string; sessionId: string }
): void {
  db.prepare(
    `INSERT INTO goals
       (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
     VALUES (?, 'Activity goal', '', 'active', 1, ?, ?, NULL)`
  ).run(ids.goalId, NOW, NOW);
  seedEngineeringTemplate(db, () => NOW);
  db.prepare(
    `INSERT INTO workflow_runs
       (id, goal_id, template_id, template_version, status, current_step_run_id,
        blocked_reason, started_at, finished_at)
     VALUES (?, ?, 'orca/engineering', 5, 'active', ?, NULL, ?, NULL)`
  ).run(ids.runId, ids.goalId, ids.stepRunId, NOW);
  db.prepare(
    `INSERT INTO workflow_step_runs
       (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status,
        satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason,
        started_at, finished_at, fingerprint)
     VALUES (?, ?, ?, 'execution', 4, 1, 'active', '[]', '[]', NULL, ?, NULL, 'activity-step-fp')`
  ).run(ids.stepRunId, ids.goalId, ids.runId, NOW);
  db.prepare("UPDATE goals SET active_workflow_run_id = ? WHERE id = ?").run(
    ids.runId,
    ids.goalId
  );

  const workspaceId = `workspace-${ids.sessionId}`;
  db.prepare(
    `INSERT INTO workspaces
       (id, goal_id, path, name, workspace_type, git_probe, attached_at)
     VALUES (?, ?, ?, 'Activity workspace', 'folder', 'not_a_repo', ?)`
  ).run(workspaceId, ids.goalId, `/tmp/${workspaceId}`, NOW);
  db.prepare(
    `INSERT INTO sessions
       (id, goal_id, workspace_id, adapter_id, title, status, created_at,
        workflow_step_run_id)
     VALUES (?, ?, ?, 'claude-code', 'Activity session', 'running', ?, ?)`
  ).run(ids.sessionId, ids.goalId, workspaceId, NOW, ids.stepRunId);
}

async function postToolUse(
  server: FastifyInstance,
  sessionId: string,
  toolUseId: string,
  toolName = "Read",
  toolInput: unknown = { file_path: "/tmp/project/src/server.ts" }
) {
  return server.inject({
    method: "POST",
    url: `/v1/agent-hooks/tool-use?sessionId=${sessionId}`,
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    payload: {
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: toolUseId,
    },
  });
}

function postElicit(
  server: FastifyInstance,
  sessionId: string,
  toolUseId: string,
  questions: PendingQuestionItem[]
) {
  return server.inject({
    method: "POST",
    url: `/v1/agent-hooks/elicit?sessionId=${sessionId}`,
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    payload: {
      tool_input: { questions },
      tool_use_id: toolUseId,
    },
  });
}

function waitForRecordedQuestion(
  db: ReturnType<typeof openDatabase>,
  ids: { goalId: string; stepRunId: string }
) {
  return vi.waitFor(
    () => {
      const activity = db
        .prepare(
          "SELECT status, current_text, pending_question FROM activities WHERE step_run_id = ?"
        )
        .get(ids.stepRunId) as
        | {
            status: string;
            current_text: string;
            pending_question: string | null;
          }
        | undefined;
      const chat = db
        .prepare(
          "SELECT pending_question FROM orchestrator_messages WHERE goal_id = ? AND pending_question IS NOT NULL ORDER BY rowid DESC LIMIT 1"
        )
        .get(ids.goalId) as { pending_question: string } | undefined;
      const rawPendingQuestion =
        activity?.pending_question ?? chat?.pending_question;
      if (!rawPendingQuestion) throw new Error("worker question not recorded");
      return {
        activity,
        pendingQuestion: JSON.parse(rawPendingQuestion) as {
          questionId: string;
          toolUseId: string;
          questions: PendingQuestionItem[];
        },
      };
    },
    { timeout: 2000, interval: 50 }
  );
}

beforeAll(() => {
  bootstrapRegistries();
});

describe("daemon activity integration", () => {
  let server: FastifyInstance;
  let db: ReturnType<typeof openDatabase>;
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "orca-server-activity-"));
    const config = createConfig(dataDir);
    db = openDatabase(config);
    runMigrations(db, defaultMigrationsDir());
    seedAgents(db);
    const daemonContext = createDaemonContext(db, eventBus);
    server = createServer(config, { daemonContext });
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("projects Claude tool use for a live workflow session into the goal activity feed", async () => {
    const ids = {
      goalId: "goal-activity",
      runId: "run-activity",
      stepRunId: "step-activity",
      sessionId: "session-activity",
    };
    seedLiveWorkflowSession(db, ids);

    const hookResponse = await server.inject({
      method: "POST",
      url: `/v1/agent-hooks/tool-use?sessionId=${ids.sessionId}`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/tmp/project/src/server.ts" },
        tool_use_id: "tool-use-1",
      },
    });

    expect(hookResponse.statusCode).toBe(200);
    expect(hookResponse.json()).toEqual({ continue: true });

    const activitiesResponse = await server.inject({
      method: "GET",
      url: `/v1/goals/${ids.goalId}/activities`,
      headers: AUTH_HEADERS,
    });
    expect(activitiesResponse.statusCode).toBe(200);
    const activities = ListActivitiesResponse.parse(activitiesResponse.json());
    expect(activities.items).toHaveLength(1);
    expect(activities.items[0]).toMatchObject({
      goalId: ids.goalId,
      workflowRunId: ids.runId,
      stepRunId: ids.stepRunId,
      agentSessionId: ids.sessionId,
      status: "active",
      sourceKind: "tool_use",
      workCategory: "reading",
      currentText: "Read server.ts",
    });
    // tool_use now appends a persisted step instead of overwriting the live bubble
    expect(activities.items[0].steps).toHaveLength(1);
    expect(activities.items[0].steps[0]).toMatchObject({
      text: "Read server.ts",
      category: "reading",
      status: "active",
    });
  });

  it("backfills a missing step_result activity when the server starts", async () => {
    const ids = {
      goalId: "goal-result-reconcile",
      runId: "run-result-reconcile",
      stepRunId: "step-result-reconcile",
      sessionId: "session-result-reconcile",
    };
    seedLiveWorkflowSession(db, ids);
    db.prepare(
      `UPDATE workflow_step_runs
       SET status = 'passed', finished_at = ?, step_result_json = ?
       WHERE id = ?`
    ).run(
      NOW,
      JSON.stringify({
        stepId: ids.stepRunId,
        stepStatus: "completed",
        evaluationStatus: "failed",
        successScore: 0,
        quality: {
          outputCompleteness: 0,
          outputCorrectness: 0,
          instructionAdherence: 0,
          downstreamReadiness: 0,
          riskLevel: 1,
        },
        performance: { durationSeconds: 0, retries: 0 },
        outcome: {
          reason: "step result evaluation failed: recovered on startup",
          producedArtifactsCount: 0,
          blockingIssuesCount: 0,
          warningsCount: 0,
          handoffReady: false,
        },
      }),
      ids.stepRunId
    );

    await server.close();
    const config = createConfig(dataDir);
    server = createServer(config, {
      daemonContext: createDaemonContext(db, eventBus),
    });

    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM activities WHERE step_run_id = ? AND source_kind = 'step_result'"
        )
        .get(ids.stepRunId)
    ).toEqual({ count: 1 });
  });

  it("ignores a hook from a workflow step that is no longer current", async () => {
    const ids = {
      goalId: "goal-stale-step",
      runId: "run-stale-step",
      stepRunId: "step-stale-step",
      sessionId: "session-stale-step",
    };
    seedLiveWorkflowSession(db, ids);
    db.prepare(
      `INSERT INTO workflow_step_runs
         (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status,
          satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason,
          started_at, finished_at, fingerprint)
       VALUES ('step-current', ?, ?, 'execution', 4, 2, 'active', '[]', '[]',
               NULL, ?, NULL, 'activity-current-fp')`
    ).run(ids.goalId, ids.runId, NOW);
    db.prepare("UPDATE workflow_runs SET current_step_run_id = 'step-current' WHERE id = ?").run(
      ids.runId
    );

    const response = await postToolUse(server, ids.sessionId, "tool-use-stale-step");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ continue: true });
    const count = db.prepare("SELECT COUNT(*) AS count FROM activities").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  it("ignores a hook from an older active session superseded for the same step", async () => {
    const ids = {
      goalId: "goal-stale-session",
      runId: "run-stale-session",
      stepRunId: "step-stale-session",
      sessionId: "session-stale-session",
    };
    seedLiveWorkflowSession(db, ids);
    const workspace = db
      .prepare("SELECT workspace_id FROM sessions WHERE id = ?")
      .get(ids.sessionId) as { workspace_id: string };
    db.prepare(
      `INSERT INTO sessions
         (id, goal_id, workspace_id, adapter_id, title, status, created_at,
          workflow_step_run_id)
       VALUES ('session-newer', ?, ?, 'claude-code', 'Newer session', 'running',
               '2026-06-06T12:01:00.000Z', ?)`
    ).run(ids.goalId, workspace.workspace_id, ids.stepRunId);

    const response = await postToolUse(server, ids.sessionId, "tool-use-stale-session");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ continue: true });
    const count = db.prepare("SELECT COUNT(*) AS count FROM activities").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  it("keeps tool use non-blocking when activity narration fails", async () => {
    const ids = {
      goalId: "goal-tool-failure",
      runId: "run-tool-failure",
      stepRunId: "step-tool-failure",
      sessionId: "session-tool-failure",
    };
    seedLiveWorkflowSession(db, ids);
    expect(
      (await postToolUse(server, ids.sessionId, "tool-use-create")).statusCode
    ).toBe(200);
    db.prepare(
      "UPDATE activities SET pending_question = '{' WHERE step_run_id = ?"
    ).run(ids.stepRunId);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await postToolUse(
        server,
        ids.sessionId,
        "tool-use-corrupt",
        "Edit",
        { file_path: "/tmp/project/src/server.ts", old_string: "a", new_string: "b" }
      );

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ continue: true });
      expect(response.body).not.toContain("permissionDecision");
      expect(response.body).not.toContain("decision");
      expect(response.body).not.toContain("behavior");
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("preserves a manual permission decision when activity narration fails", async () => {
    const ids = {
      goalId: "goal-permission-failure",
      runId: "run-permission-failure",
      stepRunId: "step-permission-failure",
      sessionId: "session-permission-failure",
    };
    seedLiveWorkflowSession(db, ids);
    expect(
      (await postToolUse(server, ids.sessionId, "tool-use-permission-create"))
        .statusCode
    ).toBe(200);
    db.prepare(
      "UPDATE activities SET pending_question = '{' WHERE step_run_id = ?"
    ).run(ids.stepRunId);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const permissionPromise = server.inject({
        method: "POST",
        url: `/v1/agent-hooks/permission?sessionId=${ids.sessionId}`,
        headers: { "content-type": "application/json", ...AUTH_HEADERS },
        payload: {
          tool_name: "Bash",
          tool_input: { command: "ls" },
          tool_use_id: "permission-corrupt",
        },
      });
      const approvalId = await vi.waitFor(
        () => {
          const row = db
            .prepare(
              "SELECT pending_approval FROM orchestrator_messages WHERE goal_id = ? AND pending_approval IS NOT NULL"
            )
            .get(ids.goalId) as { pending_approval: string } | undefined;
          if (!row) throw new Error("pending approval not posted");
          return (JSON.parse(row.pending_approval) as { approvalId: string })
            .approvalId;
        },
        { timeout: 2000, interval: 50 }
      );
      const answer = await server.inject({
        method: "POST",
        url: `/v1/goals/${ids.goalId}/permission-approvals/${approvalId}`,
        headers: { "content-type": "application/json", ...AUTH_HEADERS },
        payload: { decision: "allow" },
      });
      const permission = await permissionPromise;

      expect(answer.statusCode).toBe(200);
      expect(permission.statusCode).toBe(200);
      expect(permission.json()).toMatchObject({
        hookSpecificOutput: { decision: { behavior: "allow" } },
      });
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("inserts a worker-question chat message and settles the activity thread at ask time (legacy pending test)", async () => {
    const ids = {
      goalId: "goal-question-pending",
      runId: "run-question-pending",
      stepRunId: "step-question-pending",
      sessionId: "session-question-pending",
    };
    const questions: PendingQuestionItem[] = [
      {
        header: "Release Plan",
        question: "When should this ship?",
        multiSelect: false,
        options: [
          { label: "Ship now", description: "Release immediately." },
          { label: "Wait", description: "Hold for another review." },
        ],
      },
    ];
    seedLiveWorkflowSession(db, ids);
    expect(
      (await postToolUse(server, ids.sessionId, "tool-use-question-pending"))
        .statusCode
    ).toBe(200);

    const elicitPromise = postElicit(
      server,
      ids.sessionId,
      "question-tool-pending",
      questions
    );
    const recorded = await waitForRecordedQuestion(db, ids);
    const answer = await server.inject({
      method: "POST",
      url: `/v1/goals/${ids.goalId}/worker-questions/${recorded.pendingQuestion.questionId}/answer`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        answers: [{ questionIndex: 0, selectedLabels: ["Wait"] }],
      },
    });
    const elicit = await elicitPromise;

    // The question is now a chat message, not an activity pause.
    expect(recorded.pendingQuestion).toEqual({
      questionId: expect.any(String),
      toolUseId: "question-tool-pending",
      source: "worker",
      questions,
    });
    const chatRows = db
      .prepare(
        "SELECT body FROM orchestrator_messages WHERE goal_id = ? ORDER BY rowid"
      )
      .all(ids.goalId) as Array<{ body: string }>;
    expect(chatRows).toContainEqual({
      body: "I need your call on release plan.",
    });
    expect(answer.statusCode).toBe(200);
    expect(elicit.statusCode).toBe(200);
  });

  it("completes the paused activity while preserving the exact assembled answer reason", async () => {
    const ids = {
      goalId: "goal-question-answered",
      runId: "run-question-answered",
      stepRunId: "step-question-answered",
      sessionId: "session-question-answered",
    };
    const questions: PendingQuestionItem[] = [
      {
        header: "Release Plan",
        question: "When should this ship?",
        multiSelect: false,
        options: [
          { label: "Ship now", description: "Release immediately." },
          { label: "Wait", description: "Hold for another review." },
        ],
      },
    ];
    seedLiveWorkflowSession(db, ids);
    expect(
      (await postToolUse(server, ids.sessionId, "tool-use-question-answered"))
        .statusCode
    ).toBe(200);

    const elicitPromise = postElicit(
      server,
      ids.sessionId,
      "question-tool-answered",
      questions
    );
    const recorded = await waitForRecordedQuestion(db, ids);

    const answer = await server.inject({
      method: "POST",
      url: `/v1/goals/${ids.goalId}/worker-questions/${recorded.pendingQuestion.questionId}/answer`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        answers: [{ questionIndex: 0, selectedLabels: ["Ship now"] }],
      },
    });
    const elicit = await elicitPromise;

    expect(answer.statusCode).toBe(200);
    expect(elicit.statusCode).toBe(200);
    expect(elicit.json()).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "User answered via Orca chat. Q1 'Release Plan': Ship now. These are the user's final answers — treat the AskUserQuestion as fully answered with exactly these selections and continue. Do not call AskUserQuestion again.",
      },
    });
    // The answer is recorded on the question message; no "Forwarding" activity.
    const messages = ListOrchestratorMessagesResponse.parse(
      (await server.inject({ method: "GET", url: `/v1/goals/${ids.goalId}/orchestrator-messages`, headers: AUTH_HEADERS })).json(),
    );
    const answered = messages.messages.find((m) => m.pendingQuestion?.source === "worker");
    expect(answered?.pendingQuestion?.answer?.answers?.[0]?.selectedLabels).toEqual(["Ship now"]);

    const activitiesResponse = await server.inject({
      method: "GET", url: `/v1/goals/${ids.goalId}/activities`, headers: AUTH_HEADERS,
    });
    const activities = ListActivitiesResponse.parse(activitiesResponse.json());
    expect(activities.items.some((a) => a.finalSummary === "Forwarding your response to the agent.")).toBe(false);
  });

  it("records inline free-text from the card without inserting a user message", async () => {
    const ids = {
      goalId: "goal-question-card-freetext",
      runId: "run-question-card-freetext",
      stepRunId: "step-question-card-freetext",
      sessionId: "session-question-card-freetext",
    };
    const questions: PendingQuestionItem[] = [
      {
        header: "Release Plan",
        question: "When should this ship?",
        multiSelect: false,
        options: [
          { label: "Ship now", description: "Release immediately." },
          { label: "Wait", description: "Hold for another review." },
        ],
      },
    ];
    seedLiveWorkflowSession(db, ids);
    expect(
      (await postToolUse(server, ids.sessionId, "tool-use-question-card-freetext")).statusCode,
    ).toBe(200);

    const elicitPromise = postElicit(server, ids.sessionId, "question-tool-card-freetext", questions);
    const recorded = await waitForRecordedQuestion(db, ids);

    const before = ListOrchestratorMessagesResponse.parse(
      (await server.inject({ method: "GET", url: `/v1/goals/${ids.goalId}/orchestrator-messages`, headers: AUTH_HEADERS })).json(),
    ).messages.length;

    await server.inject({
      method: "POST",
      url: `/v1/goals/${ids.goalId}/worker-questions/${recorded.pendingQuestion.questionId}/answer`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: { freeText: "do it my way" }, // no fromChat -> card path
    });
    await elicitPromise;

    const after = ListOrchestratorMessagesResponse.parse(
      (await server.inject({ method: "GET", url: `/v1/goals/${ids.goalId}/orchestrator-messages`, headers: AUTH_HEADERS })).json(),
    ).messages;
    expect(after.length).toBe(before); // no extra user message
    expect(after.find((m) => m.pendingQuestion?.source === "worker")?.pendingQuestion?.answer?.freeText).toBe("do it my way");
  });

  it("does not duplicate activity or chat side effects for a repeated question toolUseId", async () => {
    const ids = {
      goalId: "goal-question-duplicate",
      runId: "run-question-duplicate",
      stepRunId: "step-question-duplicate",
      sessionId: "session-question-duplicate",
    };
    const questions: PendingQuestionItem[] = [
      {
        header: "Approach",
        question: "Which approach?",
        multiSelect: false,
        options: [{ label: "A", description: "Use approach A." }],
      },
    ];
    seedLiveWorkflowSession(db, ids);
    expect(
      (await postToolUse(server, ids.sessionId, "tool-use-question-duplicate"))
        .statusCode
    ).toBe(200);

    const firstElicit = postElicit(
      server,
      ids.sessionId,
      "question-tool-duplicate",
      questions
    );
    const recorded = await waitForRecordedQuestion(db, ids);
    const activityEventsBeforeDuplicate = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM events WHERE goal_id = ? AND type = 'activity.changed'"
        )
        .get(ids.goalId) as { count: number }
    ).count;

    const duplicateElicit = postElicit(
      server,
      ids.sessionId,
      "question-tool-duplicate",
      questions
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const activityEventsAfterDuplicate = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM events WHERE goal_id = ? AND type = 'activity.changed'"
        )
        .get(ids.goalId) as { count: number }
    ).count;
    const chatCount = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM orchestrator_messages WHERE goal_id = ?"
        )
        .get(ids.goalId) as { count: number }
    ).count;
    expect(activityEventsAfterDuplicate).toBe(
      activityEventsBeforeDuplicate
    );
    // One message inserted by the first elicit; the duplicate elicit must not insert a second.
    expect(chatCount).toBe(1);

    const answer = await server.inject({
      method: "POST",
      url: `/v1/goals/${ids.goalId}/worker-questions/${recorded.pendingQuestion.questionId}/answer`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        answers: [{ questionIndex: 0, selectedLabels: ["A"] }],
      },
    });
    const [firstResponse, duplicateResponse] = await Promise.all([
      firstElicit,
      duplicateElicit,
    ]);
    expect(answer.statusCode).toBe(200);
    expect(firstResponse.statusCode).toBe(200);
    expect(duplicateResponse.statusCode).toBe(200);
  });

  it("resolves a worker question from a free-text answer and records it in chat", async () => {
    const ids = {
      goalId: "goal-question-freetext",
      runId: "run-question-freetext",
      stepRunId: "step-question-freetext",
      sessionId: "session-question-freetext",
    };
    const questions: PendingQuestionItem[] = [
      {
        header: "Release Plan",
        question: "When should this ship?",
        multiSelect: false,
        options: [
          { label: "Ship now", description: "Release immediately." },
          { label: "Wait", description: "Hold for another review." },
        ],
      },
    ];
    seedLiveWorkflowSession(db, ids);
    expect(
      (await postToolUse(server, ids.sessionId, "tool-use-question-freetext")).statusCode,
    ).toBe(200);

    const elicitPromise = postElicit(server, ids.sessionId, "question-tool-freetext", questions);
    const recorded = await waitForRecordedQuestion(db, ids);

    const answer = await server.inject({
      method: "POST",
      url: `/v1/goals/${ids.goalId}/worker-questions/${recorded.pendingQuestion.questionId}/answer`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: { freeText: "a dedicated workspaces tab" },
    });
    const elicit = await elicitPromise;

    expect(answer.statusCode).toBe(200);
    expect(elicit.json()).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          'User answered via Orca chat with a custom response: "a dedicated workspaces tab". ' +
          "Treat the AskUserQuestion as fully answered with this response and continue. " +
          "Do not call AskUserQuestion again.",
      },
    });

    // Card free-text: answer is stored on the question message; no separate user message.
    const afterMessages = ListOrchestratorMessagesResponse.parse(
      (await server.inject({ method: "GET", url: `/v1/goals/${ids.goalId}/orchestrator-messages`, headers: AUTH_HEADERS })).json(),
    ).messages;
    expect(afterMessages.find((m) => m.pendingQuestion?.source === "worker")?.pendingQuestion?.answer?.freeText).toBe("a dedicated workspaces tab");
    expect(afterMessages.some((m) => m.role === "user")).toBe(false);
  });

  it("opens one live activity when a workflow step starts", async () => {
    const ids = {
      goalId: "goal-step-start",
      runId: "run-step-start",
      stepRunId: "step-step-start",
      sessionId: "session-step-start",
    };
    seedLiveWorkflowSession(db, ids);

    eventBus.publish({
      seq: 1,
      id: "event-step-start",
      type: "workflow.step.started",
      goalId: ids.goalId,
      payload: {
        goalId: ids.goalId,
        workflowRunId: ids.runId,
        stepRunId: ids.stepRunId,
        stepTemplateId: "execution",
        ordinal: 4,
      },
      createdAt: NOW,
    });

    const activitiesResponse = await server.inject({
      method: "GET",
      url: `/v1/goals/${ids.goalId}/activities`,
      headers: AUTH_HEADERS,
    });
    const activities = ListActivitiesResponse.parse(activitiesResponse.json());
    expect(activities.items).toHaveLength(1);
    expect(activities.items[0]).toMatchObject({
      stepRunId: ids.stepRunId,
      agentSessionId: ids.sessionId,
      status: "active",
      sourceKind: "step_started",
      currentText: "Watching the step agent start Execution…",
    });
  });

  it("uses the lexicographically greater session id when active sessions share created_at", async () => {
    const ids = {
      goalId: "goal-step-session-tie",
      runId: "run-step-session-tie",
      stepRunId: "step-step-session-tie",
      sessionId: "session-a",
    };
    seedLiveWorkflowSession(db, ids);
    const workspace = db
      .prepare("SELECT workspace_id FROM sessions WHERE id = ?")
      .get(ids.sessionId) as { workspace_id: string };
    db.prepare(
      `INSERT INTO sessions
         (id, goal_id, workspace_id, adapter_id, title, status, created_at,
          workflow_step_run_id)
       VALUES ('session-z', ?, ?, 'claude-code', 'Tied session', 'running', ?, ?)`
    ).run(ids.goalId, workspace.workspace_id, NOW, ids.stepRunId);

    eventBus.publish({
      seq: 1,
      id: "event-step-session-tie",
      type: "workflow.step.started",
      goalId: ids.goalId,
      payload: {
        goalId: ids.goalId,
        workflowRunId: ids.runId,
        stepRunId: ids.stepRunId,
        stepTemplateId: "execution",
        ordinal: 4,
      },
      createdAt: NOW,
    });

    const activitiesResponse = await server.inject({
      method: "GET",
      url: `/v1/goals/${ids.goalId}/activities`,
      headers: AUTH_HEADERS,
    });
    const activities = ListActivitiesResponse.parse(activitiesResponse.json());
    expect(activities.items).toHaveLength(1);
    expect(activities.items[0]?.agentSessionId).toBe("session-z");
  });

  it("ignores a step-start event for an active step that is no longer current", () => {
    const ids = {
      goalId: "goal-step-not-current",
      runId: "run-step-not-current",
      stepRunId: "step-step-not-current",
      sessionId: "session-step-not-current",
    };
    seedLiveWorkflowSession(db, ids);
    db.prepare(
      `INSERT INTO workflow_step_runs
         (id, goal_id, workflow_run_id, step_template_id, ordinal, attempt, status,
          satisfied_exit_criteria_json, outstanding_exit_criteria_json, blocked_reason,
          started_at, finished_at, fingerprint)
       VALUES ('step-current-start', ?, ?, 'execution', 4, 2, 'active', '[]', '[]',
               NULL, ?, NULL, 'activity-current-start-fp')`
    ).run(ids.goalId, ids.runId, NOW);
    db.prepare(
      "UPDATE workflow_runs SET current_step_run_id = 'step-current-start' WHERE id = ?"
    ).run(ids.runId);

    eventBus.publish({
      seq: 1,
      id: "event-step-not-current",
      type: "workflow.step.started",
      goalId: ids.goalId,
      payload: {
        goalId: ids.goalId,
        workflowRunId: ids.runId,
        stepRunId: ids.stepRunId,
        stepTemplateId: "execution",
        ordinal: 4,
      },
      createdAt: NOW,
    });

    const count = db.prepare("SELECT COUNT(*) AS count FROM activities").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  it("does not attribute a cross-goal session to a step-start activity", async () => {
    const ids = {
      goalId: "goal-step-cross",
      runId: "run-step-cross",
      stepRunId: "step-step-cross",
      sessionId: "session-step-cross",
    };
    seedLiveWorkflowSession(db, ids);
    db.prepare(
      `INSERT INTO goals
         (id, title, description, status, autonomy_level, created_at, updated_at, archived_at)
       VALUES ('goal-other', 'Other goal', '', 'active', 1, ?, ?, NULL)`
    ).run(NOW, NOW);
    db.prepare("UPDATE sessions SET goal_id = 'goal-other' WHERE id = ?").run(
      ids.sessionId
    );

    eventBus.publish({
      seq: 1,
      id: "event-step-cross",
      type: "workflow.step.started",
      goalId: ids.goalId,
      payload: {
        goalId: ids.goalId,
        workflowRunId: ids.runId,
        stepRunId: ids.stepRunId,
        stepTemplateId: "execution",
        ordinal: 4,
      },
      createdAt: NOW,
    });

    const activitiesResponse = await server.inject({
      method: "GET",
      url: `/v1/goals/${ids.goalId}/activities`,
      headers: AUTH_HEADERS,
    });
    const activities = ListActivitiesResponse.parse(activitiesResponse.json());
    expect(activities.items).toHaveLength(1);
    expect(activities.items[0]?.agentSessionId).toBeNull();
  });

  it("ignores a step-start event whose envelope goal differs from the payload goal", () => {
    const ids = {
      goalId: "goal-step-envelope",
      runId: "run-step-envelope",
      stepRunId: "step-step-envelope",
      sessionId: "session-step-envelope",
    };
    seedLiveWorkflowSession(db, ids);

    eventBus.publish({
      seq: 1,
      id: "event-step-envelope",
      type: "workflow.step.started",
      goalId: "goal-envelope-other",
      payload: {
        goalId: ids.goalId,
        workflowRunId: ids.runId,
        stepRunId: ids.stepRunId,
        stepTemplateId: "execution",
        ordinal: 4,
      },
      createdAt: NOW,
    });

    const count = db.prepare("SELECT COUNT(*) AS count FROM activities").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  it.each([
    {
      mismatch: "step template",
      stepTemplateId: "research",
      ordinal: 4,
    },
    {
      mismatch: "ordinal",
      stepTemplateId: "execution",
      ordinal: 3,
    },
  ])("ignores a step-start event with mismatched $mismatch", async ({ stepTemplateId, ordinal }) => {
    const ids = {
      goalId: `goal-step-${ordinal}-${stepTemplateId}`,
      runId: `run-step-${ordinal}-${stepTemplateId}`,
      stepRunId: `step-step-${ordinal}-${stepTemplateId}`,
      sessionId: `session-step-${ordinal}-${stepTemplateId}`,
    };
    seedLiveWorkflowSession(db, ids);

    eventBus.publish({
      seq: 1,
      id: `event-step-${ordinal}-${stepTemplateId}`,
      type: "workflow.step.started",
      goalId: ids.goalId,
      payload: {
        goalId: ids.goalId,
        workflowRunId: ids.runId,
        stepRunId: ids.stepRunId,
        stepTemplateId,
        ordinal,
        attempt: 1,
      },
      createdAt: NOW,
    });

    const count = db.prepare("SELECT COUNT(*) AS count FROM activities").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  it("opens a step-start activity with a null session when no session exists yet", async () => {
    const ids = {
      goalId: "goal-step-no-session",
      runId: "run-step-no-session",
      stepRunId: "step-step-no-session",
      sessionId: "session-step-no-session",
    };
    seedLiveWorkflowSession(db, ids);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(ids.sessionId);

    eventBus.publish({
      seq: 1,
      id: "event-step-no-session",
      type: "workflow.step.started",
      goalId: ids.goalId,
      payload: {
        goalId: ids.goalId,
        workflowRunId: ids.runId,
        stepRunId: ids.stepRunId,
        stepTemplateId: "execution",
        ordinal: 4,
        attempt: 1,
      },
      createdAt: NOW,
    });

    const activitiesResponse = await server.inject({
      method: "GET",
      url: `/v1/goals/${ids.goalId}/activities`,
      headers: AUTH_HEADERS,
    });
    const activities = ListActivitiesResponse.parse(activitiesResponse.json());
    expect(activities.items).toHaveLength(1);
    expect(activities.items[0]?.agentSessionId).toBeNull();
  });

  it("completes the live activity with the first meaningful response line capped at 280 characters", async () => {
    const ids = {
      goalId: "goal-response-done",
      runId: "run-response-done",
      stepRunId: "step-response-done",
      sessionId: "session-response-done",
    };
    seedLiveWorkflowSession(db, ids);
    await server.inject({
      method: "POST",
      url: `/v1/agent-hooks/tool-use?sessionId=${ids.sessionId}`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: {},
        tool_use_id: "tool-use-response",
      },
    });

    const longLine = "x".repeat(300);
    const responseDone = await server.inject({
      method: "POST",
      url: "/v1/agent-hooks/response-done",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        sessionId: ids.sessionId,
        adapterId: "claude-code",
        responseText: `\n  ${longLine}  \nignored second line`,
      },
    });

    expect(responseDone.statusCode).toBe(200);
    const activitiesResponse = await server.inject({
      method: "GET",
      url: `/v1/goals/${ids.goalId}/activities`,
      headers: AUTH_HEADERS,
    });
    const activities = ListActivitiesResponse.parse(activitiesResponse.json());
    expect(activities.items).toHaveLength(1);
    expect(activities.items[0]).toMatchObject({
      status: "completed",
      sourceKind: "turn_completed",
      finalSummary: longLine.slice(0, 280),
      confidence: null,
    });
  });

  it("continues an unknown-session tool hook without creating activity", async () => {
    const hookResponse = await server.inject({
      method: "POST",
      url: "/v1/agent-hooks/tool-use?sessionId=missing-session",
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/tmp/project/src/server.ts" },
        tool_use_id: "tool-use-missing",
      },
    });

    expect(hookResponse.statusCode).toBe(200);
    expect(hookResponse.json()).toEqual({ continue: true });
    const count = db.prepare("SELECT COUNT(*) AS count FROM activities").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  it("inserts a worker-question chat message and settles the activity thread on ask", async () => {
    const ids = {
      goalId: "goal-question-msg",
      runId: "run-question-msg",
      stepRunId: "step-question-msg",
      sessionId: "session-question-msg",
    };
    const questions: PendingQuestionItem[] = [
      {
        header: "Release Plan",
        question: "Ship?",
        multiSelect: false,
        options: [{ label: "Ship now", description: "go" }],
      },
    ];
    seedLiveWorkflowSession(db, ids);
    expect(
      (await postToolUse(server, ids.sessionId, "tool-use-question-msg")).statusCode,
    ).toBe(200);

    const elicitPromise = postElicit(server, ids.sessionId, "question-tool-msg", questions);
    await waitForRecordedQuestion(db, ids);

    const messagesResponse = await server.inject({
      method: "GET",
      url: `/v1/goals/${ids.goalId}/orchestrator-messages`,
      headers: AUTH_HEADERS,
    });
    const messages = ListOrchestratorMessagesResponse.parse(messagesResponse.json());
    const q = messages.messages.find((m) => m.pendingQuestion?.source === "worker");
    expect(q?.pendingQuestion?.questions).toHaveLength(1);

    const activitiesResponse = await server.inject({
      method: "GET",
      url: `/v1/goals/${ids.goalId}/activities`,
      headers: AUTH_HEADERS,
    });
    const activities = ListActivitiesResponse.parse(activitiesResponse.json());
    // The pre-question activity is settled, not paused, and carries no pending question.
    expect(activities.items[0]?.status).not.toBe("paused_for_input");
    expect(activities.items[0]?.pendingQuestion).toBeUndefined();

    // Clean up — let the elicit resolve so the test doesn't hang.
    await server.inject({
      method: "POST",
      url: `/v1/goals/${ids.goalId}/worker-questions/${(messages.messages.find((m) => m.pendingQuestion?.source === "worker")!.pendingQuestion!.questionId)}/answer`,
      headers: { "content-type": "application/json", ...AUTH_HEADERS },
      payload: { answers: [{ questionIndex: 0, selectedLabels: ["Ship now"] }] },
    });
    await elicitPromise;
  });
});

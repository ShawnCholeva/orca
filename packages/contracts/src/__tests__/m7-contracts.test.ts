import { describe, expect, it } from "vitest";

import {
  AcceptRecommendationResponse,
  AssociateTaskSessionRequest,
  AssociateTaskSessionResponse,
  Conflict,
  ConflictDismissedPayload,
  ConflictDetectedPayload,
  ConflictResolvedPayload,
  ConflictSeverity,
  ConflictSourceRef,
  ConflictSourceRefType,
  ConflictStatus,
  ConflictType,
  ContextPackage,
  ContextPackageCreatedEventPayload,
  CreateContextPackageRequest,
  CreateTaskRequest,
  CreateTaskResponse,
  CreateSessionRequest,
  DismissRecommendationResponse,
  GenerationLifecycleStatus,
  GetRecommendationResponse,
  ListConflictsQuery,
  ListConflictsResponse,
  ListRecommendationsQuery,
  ListRecommendationsResponse,
  ListTasksQuery,
  ListTasksResponse,
  M7Event,
  M7EventType,
  M7FailureCode,
  M7_FEEDBACK_MAX_NOTE_CHARS,
  M7_RECOMMENDATION_MAX_PROPOSED_ACTION_BYTES,
  M7_RECOMMENDATION_MAX_RATIONALE_CHARS,
  M7_RECOMMENDATION_MAX_TITLE_CHARS,
  M7_TASK_MAX_DESCRIPTION_CHARS,
  M7_TASK_MAX_TITLE_CHARS,
  M7_TASK_MAX_VALIDATION_STEPS,
  ModifyRecommendationRequest,
  ProposedAction,
  Recommendation,
  RecommendationAcceptedPayload,
  RecommendationDismissedPayload,
  RecommendationFeedback,
  RecommendationFeedbackRequest,
  RecommendationFeedbackAction,
  RecommendationGeneration,
  RecommendationGeneratedPayload,
  RecommendationGenerationResponse,
  RecommendationGenerationFailedPayload,
  RecommendationGenerationRequest,
  RecommendationGenerationRequestedPayload,
  RejectRecommendationResponse,
  RecommendationModifiedPayload,
  RecommendationRejectedPayload,
  RecommendationSourceRef,
  RecommendationSourceRefType,
  RecommendationStatus,
  RecommendationSupersededPayload,
  RecommendationType,
  ResolveConflictRequest,
  ResolveConflictResponse,
  SessionCreatedEventPayload,
  SplitTaskRequest,
  SplitTaskResponse,
  Task,
  TaskGeneration,
  TaskGenerationResponse,
  TaskCreatedPayload,
  TaskGeneratedPayload,
  TaskAssociatedWithContextPackagePayload,
  TaskAssociatedWithSessionPayload,
  TaskGenerationFailedPayload,
  TaskGenerationRequest,
  TaskGenerationRequestedPayload,
  TaskRole,
  TaskSourceRef,
  TaskSourceRefType,
  TaskSplitPayload,
  TaskStatus,
  TaskStatusChangedPayload,
  UpdateTaskRequest,
  UpdateTaskResponse,
  TaskUpdatedPayload,
  TriggerKind,
  UserFeedbackRecordedPayload
} from "../index.js";

const now = "2026-01-01T00:00:00.000Z";

function repeat(char: string, count: number): string {
  return char.repeat(count);
}

describe("M7 contracts", () => {
  it("accepts manual trigger only for task/recommendation generation requests", () => {
    expect(TaskGenerationRequest.parse({ trigger: "manual" })).toEqual({
      trigger: "manual"
    });
    expect(RecommendationGenerationRequest.parse({ trigger: "manual" })).toEqual({
      trigger: "manual"
    });

    expect(() => TaskGenerationRequest.parse({ trigger: "session_completed" })).toThrow();
    expect(() =>
      RecommendationGenerationRequest.parse({ trigger: "refinement_applied" })
    ).toThrow();
  });

  it("keeps M6 session/context create request shapes compatible and accepts M7 extensions", () => {
    const m6SessionRequest = {
      workspaceId: "ws-1",
      adapterId: "shell-manual"
    };
    expect(CreateSessionRequest.parse(m6SessionRequest)).toEqual(m6SessionRequest);

    const m7SessionRequest = {
      ...m6SessionRequest,
      taskId: "task-foreign-goal",
      fromRecommendationId: "rec-foreign-goal"
    };
    expect(CreateSessionRequest.parse(m7SessionRequest)).toEqual(m7SessionRequest);

    const m6ContextRequest = {
      adapterId: "shell-manual",
      role: "engineer",
      objective: "Summarize context"
    };
    expect(CreateContextPackageRequest.parse(m6ContextRequest)).toEqual(m6ContextRequest);

    const m7ContextRequest = {
      ...m6ContextRequest,
      taskId: "task-foreign-goal",
      fromRecommendationId: "rec-foreign-goal"
    };
    expect(CreateContextPackageRequest.parse(m7ContextRequest)).toEqual(m7ContextRequest);
  });

  it("extends session/context read/event payloads with optional task/recommendation associations", () => {
    const sessionCreatedPayload = {
      sessionId: "sess-1",
      goalId: "goal-1",
      workspaceId: "ws-1",
      adapterId: "shell-manual" as const,
      contextPackageId: "pkg-1",
      taskId: "task-1",
      fromRecommendationId: "rec-1"
    };
    expect(SessionCreatedEventPayload.parse(sessionCreatedPayload)).toEqual(
      sessionCreatedPayload
    );

    const contextCreatedPayload = {
      packageId: "pkg-1",
      goalId: "goal-1",
      adapterId: "shell-manual" as const,
      role: "engineer" as const,
      taskId: "task-1",
      fromRecommendationId: "rec-1",
      sourceCount: 3,
      renderedBytes: 200
    };
    expect(ContextPackageCreatedEventPayload.parse(contextCreatedPayload)).toEqual(
      contextCreatedPayload
    );

    const contextPackage = {
      id: "pkg-1",
      goalId: "goal-1",
      supersedesPackageId: null,
      adapterId: "shell-manual" as const,
      workspaceId: "ws-1",
      taskId: "task-1",
      fromRecommendationId: "rec-1",
      role: "engineer" as const,
      objective: "Summarize context",
      status: "ready" as const,
      renderedContext: "context",
      renderedBytes: 7,
      estimatedTokens: 42,
      truncated: false,
      sparse: false,
      sourceCount: 1,
      sources: [
        {
          type: "goal" as const,
          id: "goal-1",
          sourceSessionId: null,
          label: "Goal",
          reason: "required" as const,
          marker: "g1"
        }
      ],
      warnings: [],
      sourceFingerprint: "fp-1",
      assemblerVersion: "m6",
      createdAt: now
    };
    expect(ContextPackage.parse(contextPackage)).toEqual(contextPackage);
  });

  it("validates all ProposedAction kinds with parse-pass and reject cases", () => {
    const validCases: unknown[] = [
      {
        kind: "create_session",
        adapterId: "shell-manual",
        workspaceId: "ws-1",
        role: "engineer",
        objective: "Implement task",
        contextRequest: {
          adapterId: "shell-manual",
          role: "engineer",
          objective: "Build context",
          workspaceId: "ws-1"
        }
      },
      { kind: "continue_session", sessionId: "sess-1" },
      { kind: "review_output", sessionId: "sess-1", reviewerRole: "reviewer" },
      { kind: "refine_goal", missingFields: ["objective"] },
      {
        kind: "split_task",
        taskId: "task-1",
        suggestedChildren: [{ title: "Child 1", role: "engineer" }]
      },
      {
        kind: "run_validation",
        taskId: "task-1",
        suggestedRole: "qa",
        objective: "Run pnpm -r test"
      },
      {
        kind: "resolve_conflict",
        conflictId: "conflict-1",
        suggestedResolutionNote: "same author, intentional overlap"
      },
      {
        kind: "update_plan",
        taskId: "task-1",
        suggestedStatus: "blocked",
        addAcceptanceCriteria: ["Add rollback plan"]
      },
      { kind: "ask_user", question: "Should we prioritize bugfixes?" },
      { kind: "mark_complete", taskId: "task-1" },
      { kind: "pause_work", reason: "waiting on reviewer", relatedTaskIds: ["task-1"] }
    ];

    for (const input of validCases) {
      expect(ProposedAction.parse(input)).toEqual(input);
    }

    expect(() => ProposedAction.parse({ kind: "unknown_action" })).toThrow();
    expect(() => ProposedAction.parse({ kind: "continue_session" })).toThrow();
    expect(() =>
      ProposedAction.parse({
        kind: "review_output",
        sessionId: "sess-1",
        reviewerRole: "reviewer",
        extra: true
      })
    ).toThrow();
    expect(() =>
      ProposedAction.parse({
        kind: "run_validation",
        suggestedRole: "qa",
        objective: "Validate"
      })
    ).toThrow();
  });

  it("parses and strictly validates all M7 event payload literals", () => {
    const payloadByType: Record<(typeof M7EventType.options)[number], unknown> = {
      "task.generation.requested": {
        generationId: "tg-1",
        goalId: "goal-1",
        trigger: "manual",
        triggerSourceId: null
      },
      "task.generated": {
        generationId: "tg-1",
        goalId: "goal-1",
        taskIds: ["task-1"],
        count: 1,
        sparse: false
      },
      "task.generation.failed": {
        generationId: "tg-1",
        goalId: "goal-1",
        failureCode: "provider_error"
      },
      "task.created": {
        taskId: "task-1",
        goalId: "goal-1",
        status: "open",
        role: "engineer",
        workspaceId: "ws-1",
        origin: "generator",
        generationId: "tg-1"
      },
      "task.updated": {
        taskId: "task-1",
        goalId: "goal-1",
        changedFields: ["title"]
      },
      "task.split": {
        parentTaskId: "task-1",
        childTaskIds: ["task-2"],
        goalId: "goal-1"
      },
      "task.status_changed": {
        taskId: "task-1",
        goalId: "goal-1",
        fromStatus: "open",
        toStatus: "in_progress",
        reason: "user"
      },
      "task.associated_with_session": {
        taskId: "task-1",
        goalId: "goal-1",
        sessionId: "sess-1"
      },
      "task.associated_with_context_package": {
        taskId: "task-1",
        goalId: "goal-1",
        contextPackageId: "pkg-1"
      },
      "recommendation.generation.requested": {
        generationId: "rg-1",
        goalId: "goal-1",
        trigger: "manual",
        triggerSourceId: null
      },
      "recommendation.generated": {
        generationId: "rg-1",
        goalId: "goal-1",
        recommendationIds: ["rec-1"],
        supersededIds: [],
        count: 1,
        sparse: false
      },
      "recommendation.generation.failed": {
        generationId: "rg-1",
        goalId: "goal-1",
        failureCode: "invalid_output"
      },
      "recommendation.accepted": {
        recommendationId: "rec-1",
        goalId: "goal-1",
        type: "create_session"
      },
      "recommendation.rejected": {
        recommendationId: "rec-1",
        goalId: "goal-1",
        type: "create_session"
      },
      "recommendation.dismissed": {
        recommendationId: "rec-1",
        goalId: "goal-1",
        type: "create_session"
      },
      "recommendation.modified": {
        recommendationId: "rec-1",
        goalId: "goal-1",
        changedFields: ["title"]
      },
      "recommendation.superseded": {
        recommendationId: "rec-1",
        goalId: "goal-1",
        bySupersedingId: "rec-2",
        reason: "duplicate"
      },
      "conflict.detected": {
        conflictId: "conf-1",
        goalId: "goal-1",
        conflictType: "workspace_overlap",
        severity: "warning"
      },
      "conflict.resolved": {
        conflictId: "conf-1",
        goalId: "goal-1",
        resolution: "resolved"
      },
      "conflict.dismissed": {
        conflictId: "conf-1",
        goalId: "goal-1",
        resolution: "dismissed"
      },
      "user.feedback.recorded": {
        feedbackId: "fb-1",
        goalId: "goal-1",
        recommendationId: "rec-1",
        action: "accept"
      }
    };

    const parserByType = {
      "task.generation.requested": TaskGenerationRequestedPayload,
      "task.generated": TaskGeneratedPayload,
      "task.generation.failed": TaskGenerationFailedPayload,
      "task.created": TaskCreatedPayload,
      "task.updated": TaskUpdatedPayload,
      "task.split": TaskSplitPayload,
      "task.status_changed": TaskStatusChangedPayload,
      "task.associated_with_session": TaskAssociatedWithSessionPayload,
      "task.associated_with_context_package": TaskAssociatedWithContextPackagePayload,
      "recommendation.generation.requested": RecommendationGenerationRequestedPayload,
      "recommendation.generated": RecommendationGeneratedPayload,
      "recommendation.generation.failed": RecommendationGenerationFailedPayload,
      "recommendation.accepted": RecommendationAcceptedPayload,
      "recommendation.rejected": RecommendationRejectedPayload,
      "recommendation.dismissed": RecommendationDismissedPayload,
      "recommendation.modified": RecommendationModifiedPayload,
      "recommendation.superseded": RecommendationSupersededPayload,
      "conflict.detected": ConflictDetectedPayload,
      "conflict.resolved": ConflictResolvedPayload,
      "conflict.dismissed": ConflictDismissedPayload,
      "user.feedback.recorded": UserFeedbackRecordedPayload
    } as const;

    for (const type of M7EventType.options) {
      const payload = payloadByType[type];
      const parsedEvent = M7Event.parse({ type, payload });
      expect(parsedEvent).toEqual({ type, payload });
      parserByType[type as keyof typeof parserByType].parse(payload);

      expect(() =>
        M7Event.parse({
          type,
          payload: {
            ...(payload as Record<string, unknown>),
            body: "disallowed"
          }
        })
      ).toThrow();
    }
  });

  it("rejects unknown enum values for statuses and failure codes", () => {
    expect(() => TaskStatus.parse("paused")).toThrow();
    expect(() => RecommendationStatus.parse("completed")).toThrow();
    expect(() => ConflictStatus.parse("archived")).toThrow();
    expect(() => GenerationLifecycleStatus.parse("done")).toThrow();
    expect(() => M7FailureCode.parse("timeout")).toThrow();
  });

  it("parses M7 domain rows and endpoint payload wrappers", () => {
    const taskGeneration: TaskGeneration = {
      id: "tg-1",
      goalId: "goal-1",
      trigger: "manual",
      triggerSourceId: null,
      generatorId: "orca/task-generator",
      generatorVersion: "0.1.0",
      inputFingerprint: "ifp-1",
      requestFingerprint: "rfp-1",
      status: "succeeded",
      failureCode: null,
      failureMessage: null,
      sparse: false,
      requestedAt: now,
      startedAt: now,
      finishedAt: now
    };

    const task: Task = {
      id: "task-1",
      goalId: "goal-1",
      parentTaskId: null,
      workspaceId: null,
      role: "engineer",
      status: "open",
      origin: "user",
      title: "Implement endpoint",
      description: "Add route and tests",
      acceptanceCriteria: [{ id: "ac-1", text: "Route returns 200" }],
      validationSteps: [{ id: "vs-1", text: "Run tests", kind: "test" }],
      dependencies: [],
      sources: [{ type: "refinement", id: "ref-1" }],
      generationId: null,
      fingerprint: "fp-task-1",
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };

    const recommendation: Recommendation = {
      id: "rec-1",
      goalId: "goal-1",
      type: "create_session",
      status: "proposed",
      source: "deterministic_provider",
      title: "Start implementation session",
      rationale: "Task is ready",
      proposedAction: {
        kind: "create_session",
        adapterId: "shell-manual",
        role: "engineer",
        objective: "Implement endpoint"
      },
      confidence: 0.7,
      sources: [{ type: "task", id: "task-1", reason: "subject" }],
      relatedTaskId: "task-1",
      relatedSessionId: null,
      relatedContextPackageId: null,
      relatedConflictId: null,
      generationId: "rg-1",
      fingerprint: "fp-rec-1",
      supersededById: null,
      createdAt: now,
      updatedAt: now
    };

    const recommendationGeneration: RecommendationGeneration = {
      id: "rg-1",
      goalId: "goal-1",
      trigger: "manual",
      triggerSourceId: null,
      providerId: "orca/recommendation-provider",
      providerVersion: "0.1.0",
      inputFingerprint: "ifp-r-1",
      requestFingerprint: "rfp-r-1",
      status: "succeeded",
      failureCode: null,
      failureMessage: null,
      sparse: false,
      requestedAt: now,
      startedAt: now,
      finishedAt: now
    };

    const feedback: RecommendationFeedback = {
      id: "fb-1",
      goalId: "goal-1",
      recommendationId: "rec-1",
      action: "accept",
      note: null,
      modifiedPayloadJson: null,
      createdAt: now
    };

    const conflict: Conflict = {
      id: "conf-1",
      goalId: "goal-1",
      conflictType: "workspace_overlap",
      severity: "warning",
      status: "open",
      title: "Workspace overlap",
      description: "Two active sessions share one workspace",
      sources: [{ type: "workspace", id: "ws-1" }],
      fingerprint: "fp-conf-1",
      resolutionNote: null,
      detectedAt: now,
      resolvedAt: null
    };

    expect(TaskGenerationResponse.parse({ generation: taskGeneration })).toEqual({
      generation: taskGeneration
    });
    expect(ListTasksQuery.parse({})).toEqual({
      includeArchived: false,
      limit: 50
    });
    expect(ListTasksResponse.parse({ tasks: [task], generations: [taskGeneration] })).toEqual({
      tasks: [task],
      generations: [taskGeneration]
    });
    expect(
      CreateTaskRequest.parse({
        title: "Manual task",
        role: "engineer"
      })
    ).toEqual({
      title: "Manual task",
      description: "",
      role: "engineer",
      workspaceId: null,
      parentTaskId: null,
      acceptanceCriteria: [],
      validationSteps: [],
      dependencies: [],
      sources: []
    });
    expect(CreateTaskResponse.parse({ task })).toEqual({ task });
    expect(() => UpdateTaskRequest.parse({})).toThrow();
    expect(UpdateTaskResponse.parse({ task })).toEqual({ task });
    expect(SplitTaskRequest.parse({ children: [{ title: "Child" }] })).toEqual({
      children: [
        {
          title: "Child",
          description: "",
          role: "engineer",
          acceptanceCriteria: [],
          validationSteps: [],
          dependencies: [],
          sources: []
        }
      ]
    });
    expect(SplitTaskResponse.parse({ parentTask: task, childTasks: [task] })).toEqual({
      parentTask: task,
      childTasks: [task]
    });
    expect(AssociateTaskSessionRequest.parse({ sessionId: "sess-1" })).toEqual({
      sessionId: "sess-1"
    });
    expect(AssociateTaskSessionResponse.parse({ task })).toEqual({ task });
    expect(RecommendationGenerationResponse.parse({ generation: recommendationGeneration })).toEqual({
      generation: recommendationGeneration
    });
    expect(ListRecommendationsQuery.parse({})).toEqual({
      includeGenerations: true,
      limit: 50
    });
    expect(
      ListRecommendationsResponse.parse({
        recommendations: [recommendation],
        generations: [recommendationGeneration]
      })
    ).toEqual({
      recommendations: [recommendation],
      generations: [recommendationGeneration]
    });
    expect(GetRecommendationResponse.parse({ recommendation, feedback: [feedback] })).toEqual({
      recommendation,
      feedback: [feedback]
    });
    expect(RecommendationFeedbackRequest.parse({})).toEqual({});
    expect(AcceptRecommendationResponse.parse({ recommendation, proposedAction: recommendation.proposedAction, feedback })).toEqual({
      recommendation,
      proposedAction: recommendation.proposedAction,
      feedback
    });
    expect(RejectRecommendationResponse.parse({ recommendation, feedback })).toEqual({
      recommendation,
      feedback
    });
    expect(DismissRecommendationResponse.parse({ recommendation, feedback })).toEqual({
      recommendation,
      feedback
    });
    expect(ListConflictsResponse.parse({ conflicts: [conflict] })).toEqual({
      conflicts: [conflict]
    });
    expect(ResolveConflictResponse.parse({ conflict })).toEqual({ conflict });
  });

  it("rejects oversized capped fields", () => {
    const task: Task = {
      id: "task-1",
      goalId: "goal-1",
      parentTaskId: null,
      workspaceId: null,
      role: "engineer",
      status: "open",
      origin: "user",
      title: "Task",
      description: "",
      acceptanceCriteria: [],
      validationSteps: [],
      dependencies: [],
      sources: [],
      generationId: null,
      fingerprint: "fp-1",
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    };
    expect(() =>
      Task.parse({ ...task, title: repeat("t", M7_TASK_MAX_TITLE_CHARS + 1) })
    ).toThrow();
    expect(() =>
      Task.parse({ ...task, description: repeat("d", M7_TASK_MAX_DESCRIPTION_CHARS + 1) })
    ).toThrow();
    expect(() =>
      Task.parse({
        ...task,
        validationSteps: Array.from({ length: M7_TASK_MAX_VALIDATION_STEPS + 1 }, (_, i) => ({
          id: `v-${i}`,
          text: "step",
          kind: "manual"
        }))
      })
    ).toThrow();

    const recommendation: Recommendation = {
      id: "rec-1",
      goalId: "goal-1",
      type: "create_session",
      status: "proposed",
      source: "deterministic_provider",
      title: "Start implementation",
      rationale: "Task is open and ready",
      proposedAction: {
        kind: "create_session",
        adapterId: "shell-manual",
        role: "engineer",
        objective: "Implement task"
      },
      confidence: 0.8,
      sources: [{ type: "task", id: "task-1", reason: "subject" }],
      relatedTaskId: "task-1",
      relatedSessionId: null,
      relatedContextPackageId: null,
      relatedConflictId: null,
      generationId: "rg-1",
      fingerprint: "fp-rec-1",
      supersededById: null,
      createdAt: now,
      updatedAt: now
    };
    expect(() =>
      Recommendation.parse({
        ...recommendation,
        title: repeat("r", M7_RECOMMENDATION_MAX_TITLE_CHARS + 1)
      })
    ).toThrow();
    expect(() =>
      Recommendation.parse({
        ...recommendation,
        rationale: repeat("x", M7_RECOMMENDATION_MAX_RATIONALE_CHARS + 1)
      })
    ).toThrow();
    expect(() =>
      ModifyRecommendationRequest.parse({
        proposedAction: {
          kind: "pause_work",
          reason: "hold",
          relatedTaskIds: Array.from({ length: 20 }, (_, i) => `${i}-${repeat("x", 260)}`)
        }
      })
    ).toThrow();

    const conflict: Conflict = {
      id: "conf-1",
      goalId: "goal-1",
      conflictType: "workspace_overlap",
      severity: "warning",
      status: "open",
      title: "Workspace overlap",
      description: "Two sessions are writing in the same workspace",
      sources: [{ type: "workspace", id: "ws-1" }],
      fingerprint: "fp-conf-1",
      resolutionNote: null,
      detectedAt: now,
      resolvedAt: null
    };
    expect(() =>
      Conflict.parse({ ...conflict, description: repeat("c", 1025) })
    ).toThrow();

    const feedback: RecommendationFeedback = {
      id: "fb-1",
      goalId: "goal-1",
      recommendationId: "rec-1",
      action: "accept",
      note: "ok",
      modifiedPayloadJson: null,
      createdAt: now
    };
    expect(() =>
      RecommendationFeedback.parse({
        ...feedback,
        note: repeat("n", M7_FEEDBACK_MAX_NOTE_CHARS + 1)
      })
    ).toThrow();
  });

  it("includes required M7 source-ref literals and rejects unknown values", () => {
    expect(RecommendationSourceRefType.parse("context_package")).toBe("context_package");
    expect(TaskSourceRefType.parse("session_summary")).toBe("session_summary");
    expect(ConflictSourceRefType.parse("workspace")).toBe("workspace");
    expect(() => RecommendationSourceRefType.parse("output_tail")).toThrow();
    expect(() => TaskSourceRefType.parse("workspace")).toThrow();
    expect(() => ConflictSourceRefType.parse("conflict")).toThrow();

    expect(() =>
      RecommendationSourceRef.parse({ type: "task", id: "task-1", body: "bad" })
    ).toThrow();
    expect(() => TaskSourceRef.parse({ type: "refinement", id: "ref-1", extra: true })).toThrow();
    expect(() => ConflictSourceRef.parse({ type: "session", id: "sess-1", text: "bad" })).toThrow();
  });

  it("accept/reject/dismiss/resolve request schemas remain strict", () => {
    expect(() => ResolveConflictRequest.parse({ resolution: "resolved", body: "bad" })).toThrow();
    expect(() => ListConflictsQuery.parse({ status: "open", extra: true })).toThrow();
    expect(() =>
      AcceptRecommendationResponse.parse({
        recommendation: {},
        proposedAction: {},
        feedback: {}
      })
    ).toThrow();

    expect(RecommendationType.parse("run_validation")).toBe("run_validation");
    expect(ConflictType.parse("reviewer_rejection")).toBe("reviewer_rejection");
    expect(ConflictSeverity.parse("blocker")).toBe("blocker");
    expect(RecommendationFeedbackAction.parse("modify")).toBe("modify");
    expect(TriggerKind.parse("session_summary_updated")).toBe("session_summary_updated");
    expect(TaskRole.parse("qa")).toBe("qa");
  });
});

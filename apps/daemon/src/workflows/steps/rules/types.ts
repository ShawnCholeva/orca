import type Database from "better-sqlite3";
import type { DomainEvent, WorkflowArtifact, WorkflowArtifactType } from "@orca/contracts";

export interface StepRuleContext {
  goalId: string;
  workflowRunId: string;
  stepRunId: string;
  artifacts: WorkflowArtifact[];
  satisfiedExitCriteria: string[];
  outstandingExitCriteria: string[];
}

export interface NextQuestion {
  question: string;
  optionalChoices?: string[];
}

export interface RuleCreatedArtifactResult {
  satisfiedCriteria: string[];
  taskIds?: string[];
}

export interface SessionSummarySignal {
  sessionId: string;
  sessionStatus: string;
  headline: string;
  summaryText: string;
}

export interface StepRule {
  stepTemplateId: string;
  evaluateUserInputAsArtifact?(input: {
    answerText: string;
    ctx: StepRuleContext;
  }): {
    artifact?: { type: WorkflowArtifactType; title: string; body: string };
    satisfiedCriteria: string[];
  };
  nextQuestion?(ctx: StepRuleContext): NextQuestion | null;
  evaluateArtifactSatisfies?(
    artifact: WorkflowArtifact,
    ctx: StepRuleContext
  ): string[];
  onArtifactCreated?(input: {
    db: Database.Database;
    now: () => string;
    idFactory?: () => string;
    stagedEvents?: DomainEvent[];
    artifact: WorkflowArtifact;
    ctx: StepRuleContext;
  }): RuleCreatedArtifactResult;
  evaluateSessionSummarySatisfies?(
    summary: SessionSummarySignal,
    ctx: StepRuleContext
  ): string[];
}

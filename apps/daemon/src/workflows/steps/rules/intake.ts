import type { StepRule } from "./types.js";
import { appendSection } from "./common.js";

const CRITERIA = {
  brief: "goal brief captured",
  constraints: "constraints captured",
  questions: "open questions captured",
  outcome: "success outcome captured",
  workspaces: "relevant workspaces identified",
} as const;

export const intakeRule: StepRule = {
  stepTemplateId: "intake",
  nextQuestion(ctx) {
    if (!ctx.satisfiedExitCriteria.includes(CRITERIA.brief)) {
      return { question: "What problem are we solving?" };
    }
    if (!ctx.satisfiedExitCriteria.includes(CRITERIA.outcome)) {
      return { question: "What outcome should this optimize for?" };
    }
    if (!ctx.satisfiedExitCriteria.includes(CRITERIA.constraints)) {
      return { question: "What constraints should the workflow respect?" };
    }
    if (!ctx.satisfiedExitCriteria.includes(CRITERIA.workspaces)) {
      return { question: "Which workspaces or code areas are relevant?" };
    }
    if (!ctx.satisfiedExitCriteria.includes(CRITERIA.questions)) {
      return { question: "What open questions should be flagged before planning?" };
    }
    return null;
  },
  evaluateUserInputAsArtifact({ answerText, ctx }) {
    const answer = answerText.trim();
    if (!ctx.satisfiedExitCriteria.includes(CRITERIA.brief)) {
      return {
        artifact: {
          type: "goal_brief",
          title: "Goal Brief (draft)",
          body: `# Problem\n\n${answer}`,
        },
        satisfiedCriteria: [CRITERIA.brief],
      };
    }
    if (!ctx.satisfiedExitCriteria.includes(CRITERIA.outcome)) {
      return {
        artifact: {
          type: "goal_brief",
          title: "Goal Brief (draft)",
          body: appendSection(ctx, "goal_brief", "Success Outcome", answer),
        },
        satisfiedCriteria: [CRITERIA.outcome],
      };
    }
    if (!ctx.satisfiedExitCriteria.includes(CRITERIA.constraints)) {
      return {
        artifact: {
          type: "goal_brief",
          title: "Goal Brief (draft)",
          body: appendSection(ctx, "goal_brief", "Constraints", answer),
        },
        satisfiedCriteria: [CRITERIA.constraints],
      };
    }
    if (!ctx.satisfiedExitCriteria.includes(CRITERIA.workspaces)) {
      return {
        artifact: {
          type: "goal_brief",
          title: "Goal Brief (draft)",
          body: appendSection(ctx, "goal_brief", "Relevant Workspaces", answer),
        },
        satisfiedCriteria: [CRITERIA.workspaces],
      };
    }
    return {
      artifact: {
        type: "open_questions",
        title: "Open Questions",
        body: answer,
      },
      satisfiedCriteria: [CRITERIA.questions],
    };
  },
};

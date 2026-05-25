import type Database from "better-sqlite3";
import type {
  WorkflowGuardrailConfig,
  WorkflowStepTemplate,
} from "@orca/contracts";

export const ENGINEERING_ID = "orca/engineering";
export const ENGINEERING_VERSION = 1;

const ENGINEERING_NAME = "Engineering";
const ENGINEERING_DESCRIPTION =
  "Built-in workflow optimized for AI-assisted software delivery.";

const ENGINEERING_STEPS: WorkflowStepTemplate[] = [
  {
    id: "intake",
    ordinal: 0,
    name: "Intake",
    purpose: "Clarify the goal and capture the bounded brief that will drive the workflow.",
    requiredInputs: [],
    requiredOutputs: ["goal_brief", "open_questions"],
    gateType: "human-input",
    recommendedCapabilities: ["requirements_gathering", "clarification"],
    validationExpectations: [],
    exitCriteria: [
      "goal brief captured",
      "constraints captured",
      "open questions captured",
      "success outcome captured",
      "relevant workspaces identified",
    ],
    recommendedOperatorIds: ["human", "orca/anthropic:claude-sonnet-4-6"],
  },
  {
    id: "research",
    ordinal: 1,
    name: "Research",
    purpose: "Ground the implementation approach in the current codebase and known risks.",
    requiredInputs: ["goal_brief"],
    requiredOutputs: ["research_summary"],
    gateType: "human-approval",
    recommendedCapabilities: ["codebase_analysis", "risk_assessment"],
    validationExpectations: [],
    exitCriteria: [
      "relevant files and systems identified",
      "current implementation summarized",
      "dependencies and risks captured",
      "unknowns captured",
      "likely implementation area and module boundaries identified",
    ],
    recommendedOperatorIds: ["agent:claude-code", "orca/google-gemini:gemini-2.5-pro"],
  },
  {
    id: "prd",
    ordinal: 2,
    name: "PRD / Destination",
    purpose: "Turn alignment and research into a buildable destination document.",
    requiredInputs: ["goal_brief", "research_summary"],
    requiredOutputs: ["prd"],
    gateType: "human-approval",
    recommendedCapabilities: ["prd_writing", "product_thinking"],
    validationExpectations: [],
    exitCriteria: [
      "problem and solution stated",
      "user stories or behavior statements exist",
      "acceptance criteria exist",
      "non-goals exist",
      "implementation and testing decisions captured",
      "definition of done exists",
    ],
    recommendedOperatorIds: ["orca/anthropic:claude-sonnet-4-6"],
  },
  {
    id: "issue_breakdown",
    ordinal: 3,
    name: "Issue Breakdown",
    purpose: "Convert PRD into independently grabbable vertical-slice tasks.",
    requiredInputs: ["prd"],
    requiredOutputs: ["issue_breakdown"],
    gateType: "human-approval",
    recommendedCapabilities: ["task_decomposition", "dependency_inference"],
    validationExpectations: [],
    exitCriteria: [
      "work split into clear tasks",
      "dependencies explicit",
      "first vertical slice reaches user/test-visible behavior where possible",
      "validation expectations exist",
      "suggested role or capabilities exist for each task",
    ],
    recommendedOperatorIds: ["orca/anthropic:claude-sonnet-4-6", "orca/openai:gpt-4o"],
  },
  {
    id: "execution",
    ordinal: 4,
    name: "Execution",
    purpose: "Recommend and supervise bounded agent work for the next unblocked task.",
    requiredInputs: ["issue_breakdown"],
    requiredOutputs: ["implementation_result", "test_report"],
    gateType: "human-approval",
    recommendedCapabilities: ["code_editing", "test_writing", "validation"],
    validationExpectations: ["unit tests run", "typecheck run"],
    exitCriteria: [
      "assigned task completed or blocked with reason",
      "changed files summarized when applicable",
      "validation run or skipped with reason",
      "failures captured",
    ],
    recommendedOperatorIds: ["agent:codex", "agent:claude-code", "agent:opencode"],
  },
  {
    id: "qa",
    ordinal: 5,
    name: "QA",
    purpose: "Human-led product judgment with an Orca-generated checklist.",
    requiredInputs: ["implementation_result"],
    requiredOutputs: ["qa_report"],
    gateType: "human-input",
    recommendedCapabilities: ["qa", "human_judgment"],
    validationExpectations: ["acceptance criteria checked"],
    exitCriteria: [
      "acceptance criteria checked",
      "passing or failing items recorded",
      "bugs or gaps captured",
      "rework required or not required is explicit",
    ],
    recommendedOperatorIds: ["human", "orca/google-gemini:gemini-2.5-pro"],
  },
  {
    id: "review",
    ordinal: 6,
    name: "Fresh-Context Review",
    purpose: "Review in a separate context instead of degraded implementer context.",
    requiredInputs: ["prd", "research_summary", "implementation_result", "qa_report"],
    requiredOutputs: ["review_report"],
    gateType: "automated",
    recommendedCapabilities: ["code_review", "architecture_review"],
    validationExpectations: [],
    exitCriteria: [
      "architecture drift assessed",
      "test gaps assessed",
      "maintainability risks captured",
      "blocking issues identified or ruled out",
      "follow-up tasks created where needed",
    ],
    recommendedOperatorIds: ["orca/anthropic:claude-opus-4-7", "agent:claude-code"],
  },
  {
    id: "done",
    ordinal: 7,
    name: "Done",
    purpose: "Finalize the durable outcome and memory.",
    requiredInputs: ["review_report", "qa_report", "implementation_result"],
    requiredOutputs: ["final_summary", "memory_update"],
    gateType: "human-approval",
    recommendedCapabilities: ["summarization", "memory_curation"],
    validationExpectations: [],
    exitCriteria: [
      "final result summarized",
      "important decisions captured",
      "follow-up work captured",
      "goal marked complete or left active with explicit remaining work",
    ],
    recommendedOperatorIds: ["orca/anthropic:claude-sonnet-4-6"],
  },
];

const ENGINEERING_GUARDRAILS: WorkflowGuardrailConfig[] = [
  {
    id: "approval_launch_agent",
    kind: "approval_required",
    label: "Require approval to launch agents",
    configJson: { actions: ["launch_workflow_session"] },
  },
  {
    id: "approval_mark_done",
    kind: "approval_required",
    label: "Require approval to mark Done",
    configJson: { actions: ["mark_run_complete"] },
  },
  {
    id: "validation_required",
    kind: "validation_rule",
    label: "Require tests or typecheck or explicit skip reason",
    configJson: {
      appliesToSteps: ["execution"],
      required: ["unit_tests", "typecheck"],
    },
  },
  {
    id: "context_summary",
    kind: "context_rule",
    label: "Use summaries and artifacts instead of raw terminal output",
    configJson: { allowRawTerminalOutput: false },
  },
  {
    id: "concurrency_one",
    kind: "concurrency_rule",
    label: "Max one execution task running at a time",
    configJson: { maxConcurrentExecution: 1 },
  },
  {
    id: "cost_speed_balanced",
    kind: "cost_speed_preference",
    label: "Prefer cheapest sufficient",
    configJson: { preference: "cheapest_sufficient" },
  },
];

export function seedEngineeringTemplate(
  db: Database.Database,
  now: () => string
): void {
  const existing = db
    .prepare("SELECT version FROM workflow_templates WHERE id = ?")
    .get(ENGINEERING_ID) as { version: number } | undefined;

  if (existing && existing.version >= ENGINEERING_VERSION) {
    return;
  }

  db.transaction(() => {
    const timestamp = now();
    if (existing) {
      db.prepare(
        "UPDATE workflow_templates SET name = ?, description = ?, version = ?, is_built_in = 1, is_locked = 1, steps_json = ?, guardrails_json = ?, updated_at = ? WHERE id = ?"
      ).run(
        ENGINEERING_NAME,
        ENGINEERING_DESCRIPTION,
        ENGINEERING_VERSION,
        JSON.stringify(ENGINEERING_STEPS),
        JSON.stringify(ENGINEERING_GUARDRAILS),
        timestamp,
        ENGINEERING_ID
      );
      return;
    }

    db.prepare(
      "INSERT INTO workflow_templates (id, name, description, version, is_built_in, is_locked, steps_json, guardrails_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)"
    ).run(
      ENGINEERING_ID,
      ENGINEERING_NAME,
      ENGINEERING_DESCRIPTION,
      ENGINEERING_VERSION,
      JSON.stringify(ENGINEERING_STEPS),
      JSON.stringify(ENGINEERING_GUARDRAILS),
      timestamp,
      timestamp
    );
  })();
}

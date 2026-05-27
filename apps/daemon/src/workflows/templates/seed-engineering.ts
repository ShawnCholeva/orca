import type Database from "better-sqlite3";
import type {
  WorkflowGuardrailConfig,
  WorkflowStepTemplate,
} from "@orca/contracts";

export const ENGINEERING_ID = "orca/engineering";
export const ENGINEERING_VERSION = 2;

const ENGINEERING_NAME = "Engineering";
const ENGINEERING_DESCRIPTION =
  "Built-in workflow optimized for AI-assisted software delivery.";

const ENGINEERING_STEPS: WorkflowStepTemplate[] = [
  {
    id: "intake",
    ordinal: 0,
    name: "Intake",
    instructions:
      "Interview the user relentlessly about this goal until you reach shared understanding, " +
      "walking each branch of the decision tree and resolving dependencies one at a time. " +
      "Ask one question at a time. For each question, provide your recommended answer. " +
      "When a question may be answerable from attached workspace context, first use the " +
      "available workspace summaries or snippets; if no trustworthy workspace context is " +
      "available, ask the user directly instead of pretending to know. Complete only when the " +
      "brief is unambiguous; report remaining assumptions and open questions in the completion " +
      "self-check.",
    outputSchema: [
      { key: "problem", type: "string", required: true },
      { key: "success_outcome", type: "string", required: true },
      { key: "constraints", type: "array", itemType: "string", required: true },
      { key: "relevant_workspaces", type: "array", itemType: "string", required: false },
      { key: "open_questions", type: "array", itemType: "string", required: false },
    ],
  },
  {
    id: "research",
    ordinal: 1,
    name: "Research",
    instructions:
      "Ground the implementation approach in the current codebase and known risks.",
    outputSchema: [{ key: "summary", type: "string", required: true }],
  },
  {
    id: "prd",
    ordinal: 2,
    name: "PRD / Destination",
    instructions:
      "Turn alignment and research into a buildable destination document.",
    outputSchema: [{ key: "summary", type: "string", required: true }],
  },
  {
    id: "issue_breakdown",
    ordinal: 3,
    name: "Issue Breakdown",
    instructions:
      "Convert the PRD into independently grabbable vertical-slice tasks.",
    outputSchema: [{ key: "summary", type: "string", required: true }],
  },
  {
    id: "execution",
    ordinal: 4,
    name: "Execution",
    instructions:
      "Recommend and supervise bounded agent work for the next unblocked task.",
    outputSchema: [{ key: "summary", type: "string", required: true }],
  },
  {
    id: "qa",
    ordinal: 5,
    name: "QA",
    instructions:
      "Conduct human-led product judgment with an Orca-generated acceptance checklist.",
    outputSchema: [{ key: "summary", type: "string", required: true }],
  },
  {
    id: "review",
    ordinal: 6,
    name: "Fresh-Context Review",
    instructions:
      "Review the implementation in a fresh context instead of degraded implementer context.",
    outputSchema: [{ key: "summary", type: "string", required: true }],
  },
  {
    id: "done",
    ordinal: 7,
    name: "Done",
    instructions:
      "Finalize the durable outcome and capture memory for future goals.",
    outputSchema: [{ key: "summary", type: "string", required: true }],
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

import type Database from "better-sqlite3";
import type {
  WorkflowGuardrailConfig,
  WorkflowStepTemplate,
} from "@orca/contracts";

export const ENGINEERING_ID = "orca/engineering";
export const ENGINEERING_VERSION = 4;

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
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
  },
  {
    id: "research",
    ordinal: 1,
    name: "Research",
    instructions:
      "Ground the implementation approach in the current codebase and known risks. " +
      "Use the available workspaceContext (summaries and snippets) before asking the user. " +
      "Identify the smallest set of files, modules, and constraints the work will touch, " +
      "and call out any risks the brief did not capture. Complete only when the approach " +
      "is plausible and the risk set is enumerated.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "files_in_scope", type: "array", itemType: "string", required: true },
      { key: "risks", type: "array", itemType: "string", required: false },
    ],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-opus-4-7" }],
  },
  {
    id: "prd",
    ordinal: 2,
    name: "PRD / Destination",
    instructions:
      "Turn the intake brief and research into a buildable destination document. " +
      "Capture the user-visible outcome, the acceptance signals, and the non-goals. " +
      "Avoid premature design details — leave implementation choices to issue breakdown.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "user_outcome", type: "string", required: true },
      { key: "acceptance_signals", type: "array", itemType: "string", required: true },
      { key: "non_goals", type: "array", itemType: "string", required: false },
    ],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-opus-4-7" }],
  },
  {
    id: "issue_breakdown",
    ordinal: 3,
    name: "Issue Breakdown",
    instructions:
      "Convert the PRD into independently grabbable vertical-slice tasks. " +
      "Each task should be atomic, shippable, and have clear acceptance criteria. " +
      "Prefer fewer larger tasks over many trivial ones; flag tasks that require coordination.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      {
        key: "tasks",
        type: "array",
        itemType: "object",
        required: true,
        fields: [
          { key: "title", type: "string", required: true },
          { key: "acceptance", type: "string", required: true },
        ],
      },
    ],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-opus-4-7" }],
  },
  {
    id: "execution",
    ordinal: 4,
    name: "Execution",
    instructions:
      "Implement the next unblocked task in the issue breakdown. Edit only the files in scope. " +
      "Run unit tests and typecheck before declaring success; if you skip a check, record the reason. " +
      "If you hit an irrecoverable blocker, set blocked=true with a clear reason.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "changed_files", type: "array", itemType: "string", required: true },
      {
        key: "validation",
        type: "object",
        required: true,
        fields: [
          { key: "ran", type: "boolean", required: true },
          { key: "passed", type: "boolean", required: true },
          { key: "skipped", type: "string", required: false },
        ],
      },
      { key: "blocked", type: "boolean", required: true },
      { key: "blocked_reason", type: "string", required: false },
    ],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-sonnet-4-6" }],
  },
  {
    id: "qa",
    ordinal: 5,
    name: "QA",
    instructions:
      "Conduct human-led product judgment using an Orca-generated acceptance checklist. " +
      "Ask the user to confirm each acceptance signal from the PRD; record what passed, " +
      "what failed, and the user's verdict.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      {
        key: "checklist",
        type: "array",
        itemType: "object",
        required: true,
        fields: [
          { key: "item", type: "string", required: true },
          { key: "result", type: "string", required: true },
        ],
      },
      { key: "verdict", type: "string", required: true },
    ],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-sonnet-4-6" }],
  },
  {
    id: "review",
    ordinal: 6,
    name: "Fresh-Context Review",
    instructions:
      "Review the implementation against the PRD in a fresh context (no implementer assumptions). " +
      "Identify correctness, scope, and risk concerns. If anything is unsafe to ship, return " +
      "actionable change requests; otherwise approve.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "approved", type: "boolean", required: true },
      { key: "change_requests", type: "array", itemType: "string", required: false },
    ],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-opus-4-7" }],
  },
  {
    id: "done",
    ordinal: 7,
    name: "Done",
    instructions:
      "Finalize the durable outcome. Capture the lessons learned and any reusable " +
      "memory items for future goals.",
    outputSchema: [
      { key: "summary", type: "string", required: true },
      { key: "memory_items", type: "array", itemType: "string", required: false },
    ],
    agentPreference: [{ adapterId: "claude-code", modelId: "claude-haiku-4-5" }],
  },
];

const ENGINEERING_GUARDRAILS: WorkflowGuardrailConfig[] = [
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

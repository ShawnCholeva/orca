# Orca Terminal MVP

## Recommended MVP Workflow

### 1. User Starts an Initiative

```text
orca> create initiative to build the settings page from the current spec
```

Or through the UI.

Orca creates:

- initiative
- initial goal record
- workspace link
- orchestrator console session
- default worker sessions

### 2. Orca Asks the Architect to Create a Plan

`Orca -> Architect session`

Architect returns:

- task breakdown
- risks
- implementation notes
- validation suggestions

Orca creates tasks.

### 3. User Starts a Task

`Start Task`

Orca sends task context to the implementer.

### 4. Implementer Works

The implementer session modifies files through its CLI/tooling.

Orca streams important status to the orchestrator terminal.

### 5. Approval Needed

If the implementer asks to run a risky command:

```text
npm install zod
```

Orca creates an approval card:

```text
[Allow] [Deny] [Take Over]
```

The user clicks a button.

Orca sends the response back to the PTY.

### 6. Implementer Completes

Worker emits:

```text
ORCA_TASK_COMPLETE
```

Orca updates task state.

### 7. Orca Runs Validation

Orca runs configured validation commands.

If validation fails:

Orca sends failure summary back to implementer.

If validation passes:

Orca moves task to review.

### 8. Reviewer Reviews

Reviewer receives:

- task summary
- diff summary
- validation result
- relevant context records

Reviewer returns:

- approved
- needs changes
- blocked

### 9. User Approves Final Result

Orca presents:

- task completion summary
- files changed
- validation status
- review notes

User approves moving on.

## MVP UI Requirements

The MVP UI should include:

### 1. Orchestrator Terminal

Shows:

- orca prompt
- narrative progress
- important events
- manual commands
- shell passthrough

### 2. Worker Session Panel

Shows:

- architect status
- implementer status
- reviewer status
- tester status
- shell status

Each worker can be expanded.

### 3. Needs Attention Queue

Shows pending:

- approval requests
- user decisions
- blocked sessions
- interactive prompts

### 4. Approval Cards

Shows:

- request
- reason
- risk
- buttons
- source session
- related task

### 5. Task Panel

Shows:

- planned tasks
- current task
- task status
- assigned worker
- validation status
- review status

### 6. Context Ledger Panel

Shows:

- goals
- decisions
- constraints
- summaries
- test results
- blockers
- approvals

## MVP Data Model

### Initiative

```ts
type Initiative = {
  id: string;
  name: string;
  goal: string;
  workspacePath: string;
  status:
    | "active"
    | "waiting_for_user"
    | "paused"
    | "completed"
    | "failed";

  createdAt: string;
  updatedAt: string;
};
```

### Task

```ts
type Task = {
  id: string;
  initiativeId: string;
  title: string;
  description: string;

  status:
    | "planned"
    | "ready"
    | "in_progress"
    | "waiting_for_user"
    | "waiting_for_approval"
    | "validating"
    | "reviewing"
    | "done"
    | "blocked"
    | "failed";

  assignedSessionId?: string;

  createdAt: string;
  updatedAt: string;
};
```

### Session

```ts
type Session = {
  id: string;
  initiativeId?: string;

  kind:
    | "orchestrator_console"
    | "agent_architect"
    | "agent_implementer"
    | "agent_reviewer"
    | "native_shell"
    | "test_runner";

  transport: "virtual" | "pty";

  name: string;
  command?: string;
  cwd?: string;

  status:
    | "starting"
    | "idle"
    | "busy"
    | "waiting_for_approval"
    | "waiting_for_user"
    | "blocked"
    | "completed"
    | "failed"
    | "exited";

  visibility: "visible" | "collapsed" | "hidden";

  createdAt: string;
  updatedAt: string;
};
```

### InteractionRequest

```ts
type InteractionRequest = {
  id: string;
  initiativeId: string;
  taskId?: string;
  sessionId: string;

  kind:
    | "tool_permission"
    | "approval"
    | "confirmation"
    | "clarification"
    | "shell_prompt"
    | "merge_conflict"
    | "credential"
    | "unknown";

  title: string;
  message: string;
  rawPrompt?: string;

  options: InteractionOption[];

  status:
    | "pending"
    | "approved"
    | "denied"
    | "answered"
    | "expired";

  createdAt: string;
  resolvedAt?: string;
};
```

### InteractionOption

```ts
type InteractionOption = {
  id: string;
  label: string;
  response?: string;
  intent:
    | "approve"
    | "deny"
    | "answer"
    | "modify"
    | "takeover";
  description?: string;
};
```

### ContextRecord

```ts
type ContextRecord = {
  id: string;
  initiativeId: string;
  taskId?: string;
  sourceSessionId?: string;

  type:
    | "goal"
    | "task_summary"
    | "decision"
    | "constraint"
    | "test_result"
    | "diff_summary"
    | "blocker"
    | "approval"
    | "agent_note";

  title: string;
  content: string;

  createdAt: string;
};
```

## Best MVP design
No LLM in the orchestrator core.

Use deterministic code for:
- state transitions
- routing
- approval handling
- validation
- session lifecycle
- task lifecycle
- event recording

Use worker agents for:
- planning
- implementation
- review
- reasoning-heavy work

## MVP Non-Goals

Do not build these yet:

- full context graph
- deep code graph indexing
- fully autonomous long-running initiatives
- automatic PR creation
- automatic git push
- complex permission DSL
- enterprise audit controls
- team approval workflows
- multi-agent debate system
- background cloud execution
- fine-grained model cost optimization

These are valuable later, but not required to prove the MVP.

## MVP Success Criteria

The MVP is successful when:

- a user can start a goal
- Orca can spawn multiple worker sessions
- the user can interact through one orchestrator terminal
- Orca can delegate to an agent
- Orca can detect when the agent needs approval
- the UI shows clickable approval cards
- the user can approve, deny, or take over
- Orca can run validation
- Orca can summarize the task result
- Orca stores useful context records
- the user can understand what happened without reading every raw terminal log

## Final MVP Definition

The MVP should include:

1. One virtual orchestrator console
2. Multiple managed PTY worker sessions
3. Clickable approval and decision cards
4. Needs Attention queue
5. Session state and task state
6. Structured event log
7. Context Ledger
8. Basic validation runner
9. Session takeover
10. Task completion summaries
11. Simple safety approvals

This version is still focused enough to build, but strong enough to prove the real product direction.

The MVP is not just a terminal wrapper.

It is the first version of an AI Development Environment built on top of an agent harness.
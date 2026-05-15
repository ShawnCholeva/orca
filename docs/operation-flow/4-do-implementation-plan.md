You are implementing a bounded Milestone 1 task for the Orca orchestration platform found in docs/implementation-plans/milestone-1.md

Follow the implementation task exactly.

Do not redesign architecture.

Do not expand scope.

Do not introduce future systems.

Optimize for:

correctness
simplicity
maintainability
clean implementation
fast validation
preserving future extensibility

Current task:

M1-013

Important architectural constraints:

local-first
event-driven
daemon owns state
SQLite is internal in M1
no plugin system yet
no skill system yet
no PTY/session runtime yet
no AI reasoning yet
no workflow engine yet

Implementation instructions:

Analyze the current repository structure first.
Implement incrementally.
Keep files small and readable.
Use TypeScript strict typing.
Use zod validation where applicable.
Avoid unnecessary abstractions.
Prefer deterministic/simple logic.
Add comments only where helpful.
Ensure the task validation steps pass.

Before finishing:

verify all acceptance criteria
verify validation steps
explain what was implemented
explain any deviations
explain any technical concerns

After finishing:
Run /simplify
Output changes from a product perspective

Do not implement unrelated future milestone functionality.
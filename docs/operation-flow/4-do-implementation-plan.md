You are implementing a bounded Milestone 2 task for the Orca orchestration platform found in `docs/implementation-plans/milestone-2.md`.

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

M2-008

Important architectural constraints:

local-first
event-driven
daemon owns state
SQLite remains the internal storage boundary
plugin and skill concepts stay internal to the daemon in M2
registries are static boot-time descriptors, then frozen
Quick Goal is deterministic, not AI-backed
Goal creation API shape remains unchanged from M1
skill.invoked and goal.created must be persisted atomically when the relevant task requires it
desktop additions are read-only diagnostics, not a full settings system
no external plugin API package yet
no dynamic plugin loading yet
no JSON manifests yet
no permissions or sandbox yet
no generic skill invocation endpoint yet
no storage-provider abstraction yet
no PTY/session runtime yet
no AI reasoning yet
no memory engine yet
no recommendation engine yet
no workflow engine yet

Implementation instructions:

Analyze the current repository structure first.
Read the specific M2 task before editing.
Check task dependencies and do not skip prerequisite validation.
Implement incrementally.
Keep files small and readable.
Use TypeScript strict typing.
Use zod validation where wire contracts or request/response parsing require it.
Avoid unnecessary abstractions.
Prefer deterministic/simple logic.
Preserve existing M1 behavior unless the M2 task explicitly changes it.
Keep public API changes limited to the task's declared endpoints/contracts.
Keep registry and skill code daemon-internal unless the task explicitly changes contracts.
Add comments only where helpful.
Ensure the task validation steps pass.

Before finishing:

verify all acceptance criteria
verify validation steps
verify M1 baseline behavior still works where relevant
explain what was implemented
explain any deviations
explain any technical concerns

After finishing:

Commit changes
Run `/simplify`, then commit again if any changes made
Output changes from a product perspective

Do not implement unrelated future milestone functionality.

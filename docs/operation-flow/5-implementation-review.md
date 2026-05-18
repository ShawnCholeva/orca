You are acting as a principal engineer performing an architectural and implementation quality review for the Orca AI-native orchestration platform.

In the `docs/` directory, review the relevant source material before judging the implementation:

- `docs/PRODUCT.md` — product vision and operating principles
- `docs/MVP.md` — MVP scope for Levels 1-3
- `docs/TECHNICAL.md` — target architecture
- `docs/milestones/3.md` — simplified Milestone 3 scope and guardrails
- `docs/implementation-plans/milestone-3.md` — executable Milestone 3 task plan
- `docs/operation-flow/m3-implementation-review.md` — current M3 review notes, if present
- the current implementation state in the repository

Your task is to review the Milestone 3 implementation quality and detect architecture drift.

Milestone 3 is:

```text
Goal Creation and Workspaces
```

The intended M3 proof point is:

```text
User starts a Goal creation flow
  -> daemon auto-selects the internal Goal refinement skill
  -> user enters a rough Goal
  -> user reviews deterministic refined Goal fields
  -> user attaches one or more local workspaces
  -> daemon validates absolute paths and captures basic git metadata
  -> daemon commits Goal, refinement, workspace projections, and domain events atomically where appropriate
  -> daemon broadcasts events only after commit
  -> UI opens a Goal detail view showing refined Goal details and attached workspaces
  -> refined Goal and workspace state survive daemon restart
```

The platform remains:

- local-first
- Tauri v2 desktop app
- Node.js/TypeScript daemon
- event-driven
- plugin-oriented
- skill-oriented
- Goal-centric
- SQLite-backed for the MVP
- orchestration-focused

The long-term vision is large, but this review must optimize for MVP coherence, architectural integrity, regression safety, and strict Milestone 3 boundaries.

## Review Focus

### 1. M3 Scope Compliance

Identify any implementation that exceeds the Milestone 3 boundary.

M3 must include only:

- `goal.refine` extension point
- one deterministic `guided-goal-refinement` skill registered under `orca.default-skills`
- `goal.refined`, `workspace.attached`, and `workspace.removed` events
- `goal_refinements` table
- `workspaces` table without persisted `input_path`
- additive extension of `CreateGoalRequest` with optional `refined` and `workspaces`
- unchanged `CreateGoalResponse` shape from M1/M2
- refined Goal creation path that preserves the M1/M2 minimal create path
- absolute workspace path validation with canonical realpath persistence
- lazy attach-time git inspection using bounded subprocess calls
- duplicate workspace prevention by `goal_id` plus canonical path
- Goal detail bundle via `GET /v1/goals/:id`
- `POST /v1/goals/refine`
- `POST /v1/workspaces/inspect`
- `POST /v1/goals/:id/workspaces`
- `DELETE /v1/goals/:id/workspaces/:workspaceId`
- three-step desktop Create Goal flow
- Goal detail view with refinement and workspaces only
- attach/remove workspace controls after creation
- M1/M2 create/list/restart behavior preserved

Flag any of the following as drift unless explicitly justified by a documented defect:

- `GET /v1/goals/:id/workspaces`
- `GET /v1/workspaces`
- `PATCH /v1/workspaces/:id`
- `POST /v1/skills/:id/invoke`
- `ListWorkspacesResponse`
- `skillId` in `RefineGoalRequest`
- changes to `CreateGoalResponse`
- persisted `input_path`
- boot-time git probing
- refinement upsert or re-refinement behavior in the user flow
- visible skill picker
- "Create without refinement" path inside the new M3 desktop flow
- standalone confirmation-step component unless it is folded into the workspace step
- URL routing or deep-linking
- PTY/session runtime or `node-pty` usage
- agent adapters or agent process spawn
- memory extraction, context assembly, recommendations, workflows, task graph, workspace indexing, or file watching
- AI-backed refinement, model-provider SDKs, prompts, or network calls beyond the existing local daemon API
- cloud sync
- new top-level package
- Level 4/5 approval gates or autonomous execution systems

### 2. Architecture Drift Detection

Identify where the implementation has drifted from:

- the architecture docs
- `docs/milestones/3.md`
- `docs/implementation-plans/milestone-3.md`
- the product philosophy
- the event-driven model
- daemon-owned orchestration state
- the Goal-centric direction
- the M1/M2 operational baseline

Examples of drift:

- UI owning orchestration, refinement, registry, or workspace truth instead of rendering daemon state
- business logic leaking into React components instead of reducers/API/use cases
- registry mutation after boot/freeze
- `goal.refine` exposed as generic skill invocation before there is a second use case
- Quick Goal behavior changing as part of M3
- guided refinement becoming AI-backed, async I/O-driven, random, timestamped, or prompt/model-based
- workspace inspection becoming a watcher, indexer, scanner, or boot-time probe
- SQLite wrapped behind broad provider interfaces too early
- event emission happening outside the transaction that mutates projections
- WebSocket broadcasts happening before commit
- implementation preserving M3 features while breaking M1/M2 Goal behavior
- sidecar or launcher changes unrelated to a documented M1/M2 defect

### 3. Event And Transaction Integrity

Review the Goal creation, workspace attach, and workspace remove paths carefully.

Verify that:

- `POST /v1/goals` still accepts the M1/M2 body shape: `{ title, description? }`
- `CreateGoalResponse` is unchanged
- M3 additions to `CreateGoalRequest` are optional and additive only
- the daemon auto-selects the single registered `goal.refine` skill
- `POST /v1/goals/refine` performs pure deterministic refinement and writes no database rows
- successful minimal M1/M2 create still writes only `skill.invoked` then `goal.created`
- successful refined create writes events in this order: `skill.invoked`, `goal.created`, `goal.refined?`, `workspace.attached*`
- failed validation, failed refinement validation, failed workspace inspection, or duplicate workspace rejection persists no partial events or projection rows
- events, the Goal projection, the refinement projection, and initial workspace projections are written in one SQLite transaction where applicable
- `attachWorkspace` writes `workspace.attached` and the workspace projection in one transaction
- `detachWorkspace` writes `workspace.removed` and removes the workspace projection in one transaction
- forced projection failure leaves no partial event rows
- committed events are broadcast only after commit and in committed order
- event payloads stay bounded and contract-shaped

### 4. Refinement Skill Quality

Review whether `guided-goal-refinement` is intentionally small and deterministic.

Verify that:

- the skill is daemon-internal and registered under `orca.default-skills`
- the extension point is exactly `goal.refine`
- the skill id is exactly `guided-goal-refinement`
- input and output schemas match the contracts
- output `skillId` is the literal `guided-goal-refinement`
- parsing is synchronous, deterministic, and pure
- no model calls, prompts, provider SDKs, randomness, timestamps, background reasoning, generated plans, memory writes, tasks, or workflows were added
- field limits are enforced: title, description, item length, and max item count
- duplicate extracted items are deduplicated case-insensitively
- unmatched description text is preserved according to the milestone rules
- exactly one `goal.refine` skill is registered in M3

### 5. Workspace Design Quality

Review whether workspace support is the minimum needed to prepare for future sessions without building sessions.

Verify that:

- stored workspace paths are canonical realpaths
- the original `inputPath` / `input_path` is never persisted
- paths must exist, be directories, and be readable
- workspace identity is canonical path scoped to a Goal
- duplicates are rejected both by use-case logic and the unique database index
- duplicate workspaces within one create request reject before any write
- git inspection uses bounded `execFile`, not `exec`
- git metadata is an attach-time snapshot only
- non-git folders are accepted with `workspaceType: "folder"` and `gitProbe: "not_a_repo"`
- missing or failing git does not become an M3-wide failure unless the documented behavior says it should
- no git library, file watcher, workspace provider abstraction, indexer, search, refresh job, command config, or per-workspace env system was added
- remove workspace detaches from Orca only and never deletes files from disk

### 6. API And Contract Discipline

Verify the public surface is minimal and contract-driven.

Check that:

- `@orca/contracts` contains only M3-needed wire schemas/types
- `DomainEventType` adds only `goal.refined`, `workspace.attached`, and `workspace.removed`
- `SkillExtensionPoint` adds only `goal.refine`
- `CreateGoalRequest` is extended additively only
- `CreateGoalResponse` remains byte-compatible with M1/M2
- `RefineGoalRequest` rejects unknown keys and does not accept `skillId`
- `GuidedRefinementOutput.skillId` is a literal
- `GoalDetailResponse` is the single read bundle for Goal + refinement + workspaces
- `InspectWorkspaceRequest` and `AttachWorkspaceRequest` use `inputPath`, not persisted `input_path`
- M3 structured error codes are narrow and useful
- all M3 HTTP routes inherit existing local auth/CORS behavior
- no generic skill input/output runtime surface was added
- no breaking change was introduced for M1/M2 callers

### 7. Database And Projection Discipline

Review the M3 persistence shape.

Verify that:

- migration `0002_workspaces_refinements.sql` creates only `goal_refinements` and `workspaces`
- `0001_init.sql` is not rewritten for M3
- `goal_refinements` stores `skill_id`, JSON arrays for structured facts, and `refined_at`
- `workspaces` stores typed columns for path, name, workspace type, branch, dirty status, git probe, and attachment time
- there is no memory, session, task, recommendation, workflow, scan, index, or generic metadata table
- `workspaces` has unique `(goal_id, path)` enforcement
- workspace listing is stable by `attached_at ASC, id ASC`
- projection helpers do not open their own transactions or publish events
- projection helpers handle duplicate workspace errors explicitly
- restart behavior reads from projections rather than relying on event replay in M3

### 8. Desktop Integration Quality

Review the UI as the minimum product loop for refined Goal creation and workspace attachment.

Verify that:

- existing M1/M2 Goal list and minimal Goal behavior remain usable
- Create Goal is a three-step flow: rough input, refinement review, workspace attach/create
- the desktop calls daemon APIs for refinement and workspace inspection
- the desktop does not infer or own authoritative workspace/refinement registration state
- there is no visible skill picker in M3
- there is no command-center placeholder, session panel, task panel, memory panel, recommendation panel, or workflow panel
- zero workspaces is allowed if the milestone docs allow it, with a soft warning rather than a hard block
- submit calls `POST /v1/goals`, then fetches `GET /v1/goals/:id`
- Goal detail renders title, description, refinement, and workspaces
- Goal detail supports attach/remove workspace controls only
- Goal detail refetches on relevant committed WebSocket events
- failures are shown simply and do not block unrelated M1/M2 behavior unnecessarily
- the visual addition remains small and maintainable

### 9. Test And Validation Coverage

Assess whether validation proves the M3 loop without overbuilding a test matrix.

Expected coverage:

- M1 baseline still passes
- M2 loop still passes
- contracts parse happy paths and reject invalid M3 wire shapes
- migration apply/replay/upgrade tests cover both new tables and indexes
- `guided-goal-refinement` parsing, dedupe, limits, and registry registration
- workspace inspection for absolute paths, missing paths, non-directory paths, unreadable paths, git repos, non-git folders, missing git, failing git, and timeout behavior where practical
- refinement projection and workspace projection helpers
- create Goal minimal path still emits exactly `skill.invoked` + `goal.created`
- refined create emits `skill.invoked`, `goal.created`, `goal.refined?`, `workspace.attached*` in order
- create rollback prevents partial event/projection rows and prevents broadcasts
- duplicate workspace paths reject with the documented error behavior
- attach and detach use cases persist events/projections atomically
- M3 HTTP routes validate requests, map errors consistently, and preserve auth behavior
- full daemon integration test covers inspect -> refine -> create with git and non-git workspaces -> detail -> restart -> detach
- desktop API client tests cover M3 endpoints
- desktop reducer/component tests cover the Create Goal flow and Goal detail view
- manual desktop smoke is recorded with at least one git repo and one non-git folder, including attach, remove, close/reopen, and persistence check
- full typecheck, tests, daemon build, and desktop build pass if those are established project gates

Flag missing tests that create real regression risk. Do not demand tests for deferred systems such as PTY sessions, agent adapters, memory extraction, task graphs, recommendations, workflow engines, workspace indexing, file watching, crash-stress, or AI behavior.

## Findings Format

For each issue, provide:

- severity: `critical`, `high`, `medium`, or `low`
- file and line reference where possible
- the drift or defect
- why it matters long-term
- recommended correction
- correction timing: `immediate`, `soon`, or `acceptable for MVP`

Prioritize findings by risk to:

- M1/M2 regression safety
- event/transaction correctness
- M3 scope discipline
- daemon-owned state boundaries
- future Goal/workspace/session architecture
- future plugin/skill architecture

If no findings are discovered, state that explicitly and list any residual risks or testing gaps.

Do not rewrite the implementation during the review. Produce a review report focused on defects, drift, missing validation, and targeted remediation.

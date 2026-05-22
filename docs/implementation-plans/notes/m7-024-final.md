# M7-024 Final: End-To-End Proof, Restart Test, Full Regression, Docs

## Commit SHA

```
pending — Review Gate 7 remediation changes are currently uncommitted in the working tree.
```

## Commands Run

- `pnpm --filter @orca/daemon test -- src/tasks/usecases.test.ts src/recommendations/usecases.test.ts src/orchestrator/triggers.test.ts src/conflicts/usecases.test.ts`
- `pnpm --filter @orca/contracts test -- src/__tests__/m7-contracts.test.ts`
- `pnpm --filter @orca/desktop test -- src/goal-detail/GoalDetailView.test.tsx src/goal-detail/__tests__/session-create-modal.test.tsx src/goal-detail/recommendations/RecommendationsPanel.test.tsx src/goal-detail/tasks/TasksPanel.test.tsx src/goal-detail/conflicts/ConflictsBanner.test.tsx`
- `pnpm -r typecheck`
- `pnpm -r test`

## Review Gate 7 Remediation Summary

The final implementation review found and remediated transaction atomicity, task redaction, context-package trigger, desktop prefill, event payload cap, conflict-linked generation lifecycle, and documentation-record issues. No Level 4/Level 5, autonomous execution, generic action execution, provider/model configuration, prompt-management, embedding/vector, cross-Goal recommendation, or extra storage surface was introduced.

## Typecheck Summary

All 3 packages passed (`packages/contracts`, `apps/daemon`, `apps/desktop`). Zero errors.

## Test Summary

| Package | Files | Tests | Outcome |
|---------|-------|-------|---------|
| packages/contracts | 2 passed | 47 passed | green |
| apps/desktop | 18 passed | 255 passed | green |
| apps/daemon | 89 passed / 4 skipped | 1138 passed / 5 skipped | green |
| **Total** | **109 passed / 4 skipped** | **1440 passed / 5 skipped** | **green** |

Skipped tests are pre-existing smoke tests requiring live PTY/adapter processes (flagged `.skip`).

## New Test File

`apps/daemon/src/__tests__/orchestration-loop.test.ts` — 3 tests:

1. **End-to-end proof loop**: Goal creation → task generation → recommendation generation → accept (no-auto-launch assertion) → workspace_overlap conflict detection → conflict resolution with auto-dismiss → daemon restart reconciliation.
2. **Content-free events**: Asserts all M7 events are ≤ 4 KiB and contain no body text.
3. **No-auto-launch**: Asserts accepting a recommendation does not create sessions, context packages, or emit session.created/context.package.created events.

## Named M1–M6 Regression Anchors

| Anchor | Test file | Result |
|--------|-----------|--------|
| M1 Goal CRUD + live events | `test/m1-017.integration.test.ts` (6 tests) | PASS |
| M2 plugin/skill registry | `src/m2-loop.test.ts` (8 tests) | PASS |
| M3 Goal-with-workspaces integration | `test/m3-create-goal-with-workspaces.integration.test.ts` (1 test) | PASS |
| M4 session lifecycle integration | `test/m4-011-shell-vertical-slice.integration.test.ts` (2 tests) | PASS |
| M5 daemon proof-loop integration | `test/m5-shared-memory.integration.test.ts` (2 tests) | PASS |
| M6 daemon proof-loop integration | `test/context-proof-loop.integration.test.ts` (1 test) | PASS |

## M7 Definition of Done Checklist

1. **Goal-scoped tasks exist as durable domain.**
   - [x] `POST /v1/goals/:goalId/tasks/generate` → task generation works
   - [x] `POST /v1/goals/:goalId/tasks` → manual task creation works
   - [x] `PATCH /v1/tasks/:id` → update/status-change works
   - [x] `POST /v1/tasks/:id/split` → split works
   - [x] `POST /v1/tasks/:id/associate-session` → association works
   - [x] `GET /v1/goals/:goalId/tasks` → list with source attribution works
   - [x] Goal detail Tasks panel (M7-020) shows tasks

2. **Recommendations generated after meaningful state changes.**
   - [x] `session.exited`, `memory.extraction.completed` (with summaryId), `memory.item.promoted`, `decision.confirmed`, `context.package.created`, `task.created`, `task.status_changed`, `conflict.detected`, and manual request all map to trigger evaluation
   - [x] One in-process runner per Goal (single-flight via inFlightMap)
   - [x] Each recommendation carries all required fields

3. **Recommendations support full lifecycle.**
   - [x] `proposed → accepted | rejected | dismissed | modified | superseded`
   - [x] Terminal accept/reject/dismiss are DB-enforced one-shot
   - [x] Modify is non-terminal; pre-modify payload snapshotted in feedback
   - [x] Supersede happens on fingerprint match across generations

4. **User feedback persisted as supervision signal.**
   - [x] Every accept/reject/dismiss/modify writes `recommendation_feedback` row
   - [x] `user.feedback.recorded` event emits with no body content
   - [x] Rows survive restart (verified in orchestration-loop.test.ts)

5. **Accepted recommendations prefill existing flows without auto-launching.**
   - [x] Per-kind prefill map in desktop client (M7-021)
   - [x] User must still confirm via existing flows
   - [x] No `execute action` endpoint exists
   - [x] Verified in orchestration-loop.test.ts (no-auto-launch test)

6. **Validation recommendations appear after implementation evidence.**
   - [x] `run_validation` rule fires for engineer-role sessions with M5 summary containing implementation keywords
   - [x] Verified in orchestration-loop.test.ts (engineer session + summary seeding)

7. **Conservative conflicts detected and visible.**
   - [x] Five rule families: `workspace_overlap`, `contradictory_decisions`, `reviewer_rejection`, `blocker_reported`, `unresolved_question`
   - [x] Each detection emits `conflict.detected` + linked `resolve_conflict` recommendation in one TX
   - [x] Resolve/dismiss auto-dismisses linked recommendation in same TX
   - [x] Conflicts visible in Goal detail conflicts banner (M7-022)

8. **Task/recommendation/conflict state survives restart.**
   - [x] Integration test asserts post-restart state matches pre-restart
   - [x] Stale generations reconcile to `failed/daemon_restart` before HTTP listen

9. **Recommendation generation failures visible and retryable.**
   - [x] Generation banner shows pending/running/failed with `failureCode`
   - [x] Retry creates new generation row; failed rows don't block retry

10. **Recommendations panel, Tasks panel, and Conflicts banner exist.**
    - [x] Goal detail Tasks panel (M7-020)
    - [x] Goal detail Recommendations panel (M7-021)
    - [x] Goal detail Conflicts banner/drawer (M7-022)
    - [x] Live refresh from existing WebSocket subscription (M7-023)

11. **Event payloads remain content-free.**
    - [x] No event carries rendered context, rationale, proposed-action body, or body text
    - [x] 4 KiB per-event cap enforced in orchestration-loop.test.ts (content-free events test)
    - [x] Event payload content-free rule tested per event type

12. **Deterministic provider is the only production provider.**
    - [x] `DeterministicRecommendationProvider` registered via `DaemonContext`
    - [x] Fake provider used in tests only

13. **M7 storage uses 6 new tables + 4 column adds. No extra tables.**
    - [x] `tasks`, `task_generations`, `recommendations`, `recommendation_generations`, `recommendation_feedback`, `conflicts`
    - [x] `sessions.task_id`, `sessions.from_recommendation_id`, `context_packages.task_id`, `context_packages.from_recommendation_id`
    - [x] No source-reverse-index, workflow, approval-gate, embedding, or provider-config tables

14. **`POST /v1/sessions` and context-packages accept optional `taskId`/`fromRecommendationId`.**
    - [x] Without them, M4/M6 flows are byte-identical
    - [x] Verified in M7-016 and M7-017 tests

15. **Internal skill descriptors registered.**
    - [x] `orca/recommendation-generation`, `orca/task-generation`, `orca/conflict-detection` registered with M2 diagnostics
    - [x] No public skill invocation route

16. **M1–M6 behavior remains green.**
    - [x] All named regression anchors PASS
    - [x] `pnpm -r typecheck` and `pnpm -r test` pass (1440 tests)
    - [x] M4 session lifecycle, M5 memory/decision flows, M6 context preparation unchanged

17. **No excluded surface introduced.**
    - [x] No Level 4 workflow engine, no autonomous execution, no automatic session launching
    - [x] No automatic validation command execution
    - [x] No cross-Goal recommendations, no embedding/vector system
    - [x] No provider configuration UI, no prompt-management platform
    - [x] No background queue/worker, no manual conflict creation endpoint
    - [x] No AI-backed provider

18. **Section 15 final proof loop (M7-024) demonstrates end-to-end behavior.**
    - [x] `apps/daemon/src/__tests__/orchestration-loop.test.ts` passes
    - [x] Conflict detection + auto-dismiss verified
    - [x] Mid-generation restart recovery verified
    - [x] Green full regression at `pnpm -r typecheck && pnpm -r test`

## Non-Goals Verification

The following excluded endpoints do NOT exist (verified by absence from route registrations in `apps/daemon/src/server.ts`, `apps/daemon/src/tasks/routes.ts`, `apps/daemon/src/recommendations/routes.ts`, `apps/daemon/src/conflicts/routes.ts`):

- `POST /v1/recommendations/:id/execute` — absent
- `POST /v1/recommendations/:id/regenerate` — absent
- `GET /v1/recommendations` (cross-Goal) — absent
- `POST /v1/skills/:id/invoke` — absent
- Manual conflict creation endpoint — absent
- Any approval-gate, autonomous execution, or workflow endpoint — absent

## Technical Notes

- The `orchestration-loop.test.ts` uses direct DB seeding for engineer sessions and session summaries (following the M6 proof-loop pattern) to avoid PTY complexity while proving the full orchestration chain.
- The no-auto-launch assertion tracks `session.created` event count before and after `POST /v1/recommendations/:id/accept` to prove zero automatic downstream calls.
- The workspace_overlap conflict is triggered via direct `detectAndPersist` call (the test spec permits "trigger evaluation directly") after inserting two `running` sessions on the same workspace.
- Restart reconciliation uses direct DB insert of a `pending` generation row and `reconcileInFlightGenerations` to simulate a crash mid-generation without needing to kill a real process.

## Gate Note Deviations

- `docs/implementation-plans/notes/m7-gate-1.md` exists.
- Separate gate notes for gates 2-6 are not present; evidence is consolidated here and in `docs/implementation-plans/milestone-7.md`.
- A human desktop manual smoke record is not present in this note; desktop behavior is covered by automated component/API tests unless a separate manual smoke note is added.

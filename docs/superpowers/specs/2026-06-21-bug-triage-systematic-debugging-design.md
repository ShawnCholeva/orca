# Bug Triage & Fix → Systematic Debugging (Four Phases)

**Date:** 2026-06-21
**Status:** Approved, implementing

## Problem

The `orca/bug-triage-fix` built-in workflow loosely tracks debugging but does not
encode the discipline of the superpowers `systematic-debugging` skill: the **Iron
Law** (no fixes without root-cause investigation first), single-hypothesis testing,
pattern analysis against working examples, and the "3 failed fixes → question the
architecture" escalation. The graph is also linear, so a failed verification has no
structural path back to re-investigation.

## Goal

Rework Bug Triage & Fix so its steps map 1:1 to the skill's **Four Phases** and a
failed verdict loops back to Phase 1 (re-investigate, don't just re-patch).

## Design

### Steps (4 phases + Done)

| Phase | id | name | policy | notes |
|------|----|------|--------|-------|
| 1 | `root_cause` | Root Cause Investigation | `interview` | Absorbs the old `reproduce` step. Reproduce consistently, read errors, check recent changes, trace data flow to the *true* cause, cite code. Interview the user when the report is ambiguous; drain `open_questions`; confirm repro on the card. **No fixes.** |
| 2 | `pattern_analysis` | Pattern Analysis | `reasoning` | Find working examples, compare against references, list *every* difference, understand dependencies. |
| 3 | `hypothesis` | Hypothesis & Testing | `reasoning` | State **one** hypothesis ("X is the cause because Y"); write the failing test; test minimally — one variable at a time. |
| 4 | `implementation` | Implementation | `reasoning` | Implement the **single** smallest fix for the root cause; run tests/typecheck/lint. |
| — | `done` | Done | `handoff` | Record resolution, regression evidence, follow-ups; closing summary. |

Why `reasoning` (not a new policy) for Implementation: validation rigor already
comes from the `validation_rule` guardrail (skip-needs-a-reason) **and** the Verdict
gate independently judging the evidence. A bespoke `validation` completion policy
would duplicate the gate and self-gate on the agent's own (trusted) evidence — weaker
than the gate. YAGNI.

### Graph (with Verdict gate)

```
root_cause → pattern_analysis → hypothesis → implementation → [Verdict gate]
     ↑________________________________________________________| (rejected)
                                                               |→ done (approved)
```

- `verdict` is a **gate** node (only gates may branch via `approved`/`rejected` ports).
- `approved` → `done`: regression proven gone, nothing adjacent broke.
- `rejected` → `root_cause`: return to Phase 1, re-investigate.
- Gate instructions encode the **3-failed-fixes → question the architecture / escalate
  to the user** discipline, and treat step output as untrusted evidence (the
  independent verification that replaces the old separate `verify` step).

### Guardrails

`[validationRule(["implementation"]), APPROVAL_MARK_DONE]` — same as before, with the
validation rule rewired from `patch` to the renamed `implementation` step.

### Version

Bump `orca/bug-triage-fix` to **4**. The live daemon already persisted v3 to the DB
during the (now superseded) participatory-revision pass, so the version-guarded
upgrade (`existing.version >= def.version` is a no-op) requires v4 to actually
replace the installed steps.

## Out of scope

- No changes to other built-in workflows.
- No new `completionPolicy` enum value.
- No desktop changes (the catalog drives rendering generically).

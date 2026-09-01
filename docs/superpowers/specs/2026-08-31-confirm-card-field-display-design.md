# Confirm-Card Field Display (`display: user | agent`) — Design

**Date:** 2026-08-31
**Status:** Design — approved (audience vocabulary + `agent` default + explicit annotation of all existing fields confirmed in review)
**Scope:** Give each workflow step output field an explicit audience so the step-completion confirm card shows the human only what the human is deciding on, while every field continues to reach downstream agents unchanged. Annotate all 98 top-level catalog fields; demote five Triage fields.

---

## 1. Context & motivation

A live Triage confirm card rendered nine field rows: `problem`, `success_outcome`, `constraints` (10 items), `known_files` (26 paths), `risks` (8 items), `has_product_intent`, `codebase_state`, `recommended_tier`, `rationale`. The user's reaction: *"There is a lot of content in this card that I don't necessarily care about."*

The card is entirely generic. `buildConfirmationSummary` (`apps/daemon/src/workflows/orchestrator/confirmation-summary.ts:174`) walks the step's `outputSchema` in declaration order and emits one row per non-empty field, humanizing the key into a label. The only step-aware behavior is the splitter relabel: the branch field renders as `Recommended step: Clarify` instead of the raw `clarify_first` token.

So the noise is not a Triage bug — it is a **missing distinction**. Triage's schema serves two readers at once:

- The **decision**: `recommended_tier` + `rationale`, plus the framing in `problem` / `success_outcome`. This is what the human is confirming at the pause.
- The **provisional brief**: `constraints`, `known_files`, `risks`, `has_product_intent`, `codebase_state`. This exists so Proposal still has a frame when Clarify and Research are skipped. It is fuel for the next step, not review material for the human.

The irony that sharpened the case: the pasted run recommended `clarify_first`, meaning the brief it spent 26 file paths on was *about to be superseded by Clarify*. The card displayed at full volume the part of the output least load-bearing in the branch it had just chosen.

**User's governing principle (confirmed in review):** *"agents should see all outputs but the user should not have to"* — and, on defaults, *"I would rather see them and then exclude them rather than not see them and include them."*

Paper alignment: §3.5.1 — signals should link to concrete artifacts a reviewer can act on. A confirm pause is a human-review gate (§3.4.1); its surface should carry the decision, not the handoff payload.

---

## 2. Key finding: the flag cannot filter what agents see

Verified before designing. `buildStepExecutionInput` (`apps/daemon/src/workflows/orchestrator/step-input.ts:36-45`) hands every downstream step the **entire** parsed output block of every prior step, via `priorStepOutputs`. There is no field-level filtering anywhere on that path.

Two consequences that shape the whole design:

1. **The flag is display-only.** It cannot starve a downstream step, which makes the change impossible to get wrong in a way that breaks a run. Annotating a field is always safe.
2. **`agent` is the true baseline.** Every field is already agent-visible. Marking a field `user` is the act of *promoting* it onto the card — which is why the default is `agent`, not `user`.

An earlier draft used `display: "primary" | "detail"` to avoid implying routing that does not exist. The audience vocabulary was chosen instead, with the inclusivity stated in a code comment: `user` means *user **and** agent*; `agent` means *agent only, on the card*.

### Rejected: deriving prominence from existing metadata

Inferring "important" from the grounding rules gives the exact inverse of what is wanted. Triage's grounding references `known_files` (`paths_exist`), `has_product_intent`, and `codebase_state` (`implies`) — precisely the three fields the user wants demoted. The hint must be authored, not derived.

### Rejected: renderer-side truncation

Collapsing after N rows needs no backend change but is blind. Schema order is authored for the agent's writing flow, so `rationale` sits last; a top-N rule would hide the single most useful row and keep the 26 file paths.

---

## 3. Goals & non-goals

### Goals
- One optional `display` key on `WorkflowStepOutputField`, values `user` | `agent`, absent ⇒ `agent`.
- Demoted fields fold behind a disclosure on the confirm card — visible on demand, never dropped.
- All 98 top-level catalog fields carry an explicit `display`, so the default only ever governs fields added later.
- Triage's card face reduces to: lead → Problem → Success outcome → Recommended step → Rationale.
- Cards for in-flight runs and completed history keep their current face.

### Non-goals
- Filtering what any agent receives. Out of scope and explicitly undesirable.
- Reviewing the other six templates' card composition. They are annotated to **preserve today's behavior**; curating them is separate work, one card at a time.
- Any change to scoring, evidence bundles, refute banners, or the lead line.

---

## 4. Design

### 4.1 Contract

`packages/contracts/src/workflows/output-schema.ts:6` — add one optional key to both the TS type and the Zod object (which is `.strict()`, so the addition must be made in both places):

```ts
/** Who this field is for on the step-completion confirm card.
 *  `user` means user AND agent — it renders on the card face.
 *  `agent` means agent only *on the card*: it folds behind the card's
 *  disclosure. It does NOT filter the field out of `priorStepOutputs` —
 *  downstream steps receive every field either way (step-input.ts).
 *  Absent ⇒ `agent`, because agent visibility is the baseline; putting a
 *  field in front of the human is the deliberate act. */
display?: "user" | "agent";
```

`ConfirmationSummary` (`packages/contracts/src/index.ts:1391`) gains a sibling to `fields`:

```ts
details: z.array(CardField).max(32).optional(),
```

The card-field object is currently inline inside the `fields` array; extract it to a named `CardField` const and reuse it, keeping `label` (1–128) and `value` (string ≤4000, or ≤64 strings) identical. `details` is optional so cards persisted before this change parse unchanged.

### 4.2 Card builder

In `buildConfirmationSummary`, choose the target array per top-level schema field before flattening. `flattenField` already takes its output array as a parameter, so nesting inherits the parent's target with no further change:

```ts
const legacy = !outputSchema.some((f) => f.display !== undefined);
const target = legacy || field.display === "user" ? fields : details;
```

The `_completion` skip and the splitter relabel are unchanged; the relabel pushes to `target` rather than to `fields` directly, so a demoted branch field would fold correctly (none is demoted today). `details` is included in the returned object only when non-empty, so unannotated steps produce byte-identical cards.

**The `legacy` rule is what protects history.** Output schemas are snapshotted into each run's `steps_json`, and cards are rebuilt from that snapshot on read (`apps/daemon/src/activities/projection.ts:149,238`). Without this rule, every in-flight and completed run — whose snapshot predates `display` — would default to `agent` and lose its card face on next render. The rule reads "a schema in which *no* field declares an audience is a pre-`display` schema; treat all of it as `user`." Within an annotated schema the `agent` default still applies, so a newly added field is agent-only until deliberately promoted.

### 4.3 Desktop

`ActivityThread.tsx:105-120` renders `summary.fields` as a `<dl className="step-confirm-fields">`. Extract that `<dl>` into a small local component and reuse it for `summary.details` inside a `<details>` disclosure, matching the existing `step-confirm-selfassess` pattern at line 259. The disclosure summary carries the count — **"Brief for the next step (5)"** — so it is evident that nothing was dropped, only folded. Add the disclosure's class to `orchestrator.css`, reusing the self-assess styling where it fits.

`summary.lead` renders unconditionally at line 85, as do the refute banner and evidence bundle. No card can ever read empty as a result of this change.

### 4.4 Catalog annotation

Annotate all 98 **top-level** fields across 27 step definitions explicitly, so `catalog.ts` is self-describing and the default never applies silently to existing work:

| | fields | `display` |
|---|---|---|
| Triage — `problem`, `success_outcome`, `recommended_tier`, `rationale` | 4 | `user` |
| Triage — `constraints`, `known_files`, `risks`, `has_product_intent`, `codebase_state` | 5 | `agent` |
| All other steps, all templates | 89 | `user` |

**Nested subfields are deliberately left unannotated.** The catalog also holds 31 subfields inside `object` and `array`-of-`object` fields (e.g. Proposal's `approaches[].name` / `.tradeoffs`, `task_plan[].title` / `.detail` / `.files`). `flattenField` renders a nested field into whichever array its *parent* selected, so a `display` on a subfield would be inert. Annotating them would imply a control that does not exist. The audience is a property of the top-level field only — which also matches the legacy probe in §4.2, that scans top-level fields.

Top-level counts per step definition (for review completeness): triage 9, clarify 4, research 3, proposal 5, execution 9, done 8 · root_cause 6, pattern_analysis 3, hypothesis 3, implementation 3, done 5 · analyze_diff 2, risk_pass 2, report 3, done 4 · map_blast_radius 3, restructure 3, behavior_parity 3, done 3 · find_gaps 2, generate_checks 3, confirm_green 3, done 3 · draft 2, done 1 · intake 1, deliver 2.

### 4.5 Version bumps — required on all seven templates

The boot upgrade installs a template only when the catalog version **exceeds** the installed one. A template whose schema gains annotations but whose version does not move keeps its un-annotated installed copy — whose fields then default to `agent`, folding that card. Skipping a bump therefore causes exactly the regression this design exists to avoid.

| template | version |
|---|---|
| `orca/adaptive-delivery` | 14 → 15 |
| `orca/bug-triage-fix` | 4 → 5 |
| `orca/code-review` | 3 → 4 |
| `orca/refactor` | 3 → 4 |
| `orca/quality-coverage` | 3 → 4 |
| `orca/scope-brief` | 1 → 2 |
| `orca/scoped-delivery` | 1 → 2 |

**Verify installed versions before publishing.** The v10 comment in `catalog.ts` records a prior incident: a learning-applied proposal had written a forward version onto a live installation, so version 7 was already occupied and the change had to publish as 8. At implementation time, check each template's installed version and bump above it, not merely above the catalog literal.

Add a `v15:` comment to the adaptive-delivery block in the existing house style, noting the audience annotations and the five demoted Triage fields.

---

## 5. Testing

- **Builder** (`confirmation-summary.test.ts`): `agent` fields land in `details` and `user` fields in `fields`; a fully-unannotated schema puts everything in `fields` and omits `details` (the legacy rule); a schema with at least one annotation applies the `agent` default to its unannotated fields; the splitter relabel still yields `Recommended step` on the face; nested object and array-of-object fields inherit their parent's target.
- **Contracts**: `WorkflowStepOutputField` parses with and without `display`, and rejects a value outside the enum; `ConfirmationSummary` parses with `details` absent and present.
- **Catalog** (`catalog.triage-greenfield.test.ts` or a sibling): Triage's five brief fields are `agent` and its four decision fields are `user`; no top-level catalog field is left unannotated (a sweep over all seven templates, which also guards future additions); no nested subfield declares `display`; each of the seven templates' versions match the table above.
- **Desktop** (`ActivityThread.test.tsx`): given a summary with `details`, the disclosure renders with its count and the demoted labels are absent from the main `<dl>`; given no `details`, no disclosure renders.

---

## 6. Risks & notes

- **History and in-flight runs** are protected only by the legacy rule in §4.2. It is the single most important line to get right and is covered by a dedicated test.
- **Scope of the annotation sweep.** 93 of the 98 annotations are behavior-preserving `user` markers (89 outside Triage, plus Triage's own four). They are mechanical, but they touch six templates the user has not reviewed; the diff should be read as "no card changes except Triage."
- **Shared worktree.** Parallel agents are working on `main` in this worktree, with uncommitted changes in `OrcaChat.tsx`, `projection.ts` (`workflows/steps/`), `contracts/workflows/index.ts` and others. Stage explicit paths; never `git add -A`. The files this change touches — `output-schema.ts`, `contracts/src/index.ts`, `confirmation-summary.ts`, `catalog.ts`, `ActivityThread.tsx`, `orchestrator.css` — were all clean at design time.
- **Follow-up, not in scope.** Once Triage is validated in a live run, the same review applies one card at a time to Proposal (`approaches` + `task_plan` + `files` is the next-loudest), Research, and Execution.

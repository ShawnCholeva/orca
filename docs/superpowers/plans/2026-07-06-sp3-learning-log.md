# SP3 — Learning-Log Spine, Calibration Readout, Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the learning loop an append-only memory (`learning_events`, migration 0056), a display-only per-tier calibration readout, a timeline UI, and close the seven carried follow-ups.

**Architecture:** Spec: `docs/superpowers/specs/2026-07-06-sp3-design.md`. Control-plane only. Events are written by deterministic code inside the SAME transaction as each proposal transition; the rollback event freezes the falsifier snapshot computed just before rollback; an `analyzed` event makes skips visible. Calibration is a pure projection (`computeCalibration`) reused by summary and detail; divergence feeds `deriveInsights`. No behavior change to score math, whitelist, routing, judge, canary, or approval semantics.

**Tech Stack:** TypeScript, zod, better-sqlite3, vitest, React, Fastify.

## Global Constraints

- **Atomicity:** every event is written in the same `db.transaction` as its state change — a failed transition emits nothing; a failed event write rolls the transition back.
- **Deterministic writers only** — no LLM output is ever written to `learning_events` except bounded verdict/reason strings already validated by contracts.
- **Every event stamps `template_version` at event time** (pre-bump for `applied`: event `template_version` = version before the bump; payload carries `appliedAsVersion`).
- **Coefficients stay fixed constants** (`TIER_CONFIDENCE` untouched). Calibration is display-only.
- **Calibration math (spec §3.3):** `claims(T) = passes(T) + overturned(T)`; `measured = passes/claims`; `CALIBRATION_MIN = 5` claims; evidence tiers need refute coverage ≥ 0.5 of passes else `unmeasurable`; `self_reported` always `unmeasurable`; divergence insight when `state==="measured" && |measured−assumed| > CALIBRATION_DIVERGENCE (= 0.2) && claims ≥ 10`. Never emit `measured: 1.0` from absence of checks (the coverage rule enforces this).
- **Zero jargon** in rendered copy: `/\b(oracle|sensor|verdict|refute|veto)\b/i`.
- **Repo gotchas:** `pnpm --filter @orca/contracts build` after contract edits; new migration id appended to hardcoded lists in `apps/daemon/src/migrations.test.ts` (grep — 5 occurrences last time), `apps/daemon/src/migrations/suggested-orchestration.test.ts`, `apps/daemon/test/migrations-0006.test.ts`.
- Test commands: `pnpm -C apps/daemon test`, `pnpm -C apps/desktop test`, `pnpm -C packages/contracts test` (+ path arg for single file). Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Report files may hold stale prior-project content — always overwrite fresh.

---

### Task 1: Contracts + migration 0056 + events store module

**Files:**
- Modify: `packages/contracts/src/learning/index.ts`
- Modify: `packages/contracts/src/metrics/index.ts` (calibration on `TemplateMetricsSummary`)
- Create: `apps/daemon/migrations/0056_learning_events.sql`
- Modify: `apps/daemon/src/migrations.ts` (register after 0055) + the three snapshot-list test files
- Create: `apps/daemon/src/learning/events.ts`
- Test: contracts learning tests, `apps/daemon/src/learning/events.test.ts`

**Interfaces (later tasks rely on these exact names):**
- Contracts:
```ts
export const LearningEventType = z.enum([
  "created", "judged", "applied", "dismissed", "rolled_back", "superseded", "baseline_restored", "analyzed",
]);
export type LearningEventType = z.infer<typeof LearningEventType>;

export const RollbackOutcomeSnapshot = z.object({
  targetDelta: z.number().nullable(),
  targetDeltaVersions: z.object({ latest: z.number().int(), prior: z.number().int() }).strict().nullable(),
  invalidOutputRateDelta: z.number().nullable(),
  regressionDetected: z.boolean(),
}).strict();
export type RollbackOutcomeSnapshot = z.infer<typeof RollbackOutcomeSnapshot>;

export const LearningEventPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), component: ProposalComponent, rule: z.enum(["R1", "R2", "R3", "R4"]), failureCode: z.string().nullable() }).strict(),
  z.object({ kind: z.literal("judged"), verdict: JudgeOutcome, solvedSampleSize: z.number().int(), failureSampleSize: z.number().int() }).strict(),
  z.object({ kind: z.literal("applied"), appliedAsVersion: z.number().int(), humanEdited: z.boolean() }).strict(),
  z.object({ kind: z.literal("dismissed") }).strict(),
  z.object({ kind: z.literal("rolled_back"), outcome: RollbackOutcomeSnapshot }).strict(),
  z.object({ kind: z.literal("superseded"), by: z.enum(["apply", "staleness", "restore"]) }).strict(),
  z.object({ kind: z.literal("baseline_restored"), supersededCount: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("analyzed"), stepsDiagnosed: z.number().int().nonnegative(), proposalsCreated: z.number().int().nonnegative(), skips: z.array(z.object({ stepTemplateId: z.string(), reason: z.string().max(300) }).strict()).max(20) }).strict(),
]);
export type LearningEventPayload = z.infer<typeof LearningEventPayload>;

export const LearningEvent = z.object({
  id: z.string(), templateId: z.string(),
  proposalId: z.string().nullable(), stepTemplateId: z.string().nullable(),
  eventType: LearningEventType, templateVersion: z.number().int(),
  payload: LearningEventPayload, createdAt: z.string(),
}).strict().superRefine((e, ctx) => {
  if (e.payload.kind !== e.eventType) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "payload.kind must equal eventType" });
});
export type LearningEvent = z.infer<typeof LearningEvent>;
```
- `TemplateMetricsSummary` gains (additive):
```ts
  calibration: z.array(z.object({
    tier: VerificationTier, assumed: z.number(), measured: z.number().nullable(),
    sampleSize: z.number().int().nonnegative(),
    state: z.enum(["measured", "insufficient", "unmeasurable"]),
  }).strict()),
```
(import `VerificationTier` from the metrics module where it's defined).
- Events store (`apps/daemon/src/learning/events.ts`):
```ts
export function recordEvent(db: Database.Database, e: Omit<LearningEvent, "id" | "createdAt">, now: string): void; // validates via LearningEvent.parse after stamping id (crypto.randomUUID) + createdAt=now; payload serialized ≤ 4096 chars (throw if over)
export function listEventsByTemplate(db: Database.Database, templateId: string, limit = 50): LearningEvent[]; // newest-first by seq DESC, limit clamped to [1,100]
export function currentTemplateVersion(db: Database.Database, templateId: string): number; // SELECT version FROM workflow_templates; throws StepNotFoundError-style Error if missing
```

- [ ] **Step 1: Migration.** Create `apps/daemon/migrations/0056_learning_events.sql` with the spec §3.1 SQL verbatim (CREATE TABLE learning_events + idx_learning_events_template). Register in `migrations.ts` after 0055 following its pattern; append `0056_learning_events` to every hardcoded snapshot list (grep all three files for `0055` and mirror).

- [ ] **Step 2: Failing contract + store tests.** Contracts: parse one valid event per type; reject payload.kind ≠ eventType; reject unknown eventType. Store test (`events.test.ts`, follow `store.test.ts`'s in-memory-db + migrations setup pattern):

```ts
it("round-trips each event type and lists newest-first with a clamped cap", () => {
  const mk = (i: number): void => recordEvent(db, {
    templateId: "tpl", proposalId: `p${i}`, stepTemplateId: "s1",
    eventType: "dismissed", templateVersion: 1, payload: { kind: "dismissed" },
  }, `2026-07-06T00:00:0${Math.min(i, 9)}.000Z`);
  for (let i = 0; i < 7; i++) mk(i);
  const events = listEventsByTemplate(db, "tpl", 3);
  expect(events).toHaveLength(3);
  expect(events[0].proposalId).toBe("p6"); // newest first
  expect(listEventsByTemplate(db, "tpl", 500)).toHaveLength(7); // clamp ≤100 still returns all 7
});

it("rejects an oversized payload and a mismatched kind", () => {
  expect(() => recordEvent(db, { templateId: "tpl", proposalId: "p", stepTemplateId: "s1", eventType: "created",
    payload: { kind: "dismissed" } as never, templateVersion: 1 }, NOW)).toThrow();
  const bigSkips = Array.from({ length: 20 }, (_, i) => ({ stepTemplateId: `step-${i}`, reason: "x".repeat(300) }));
  expect(() => recordEvent(db, { templateId: "tpl", proposalId: null, stepTemplateId: null, eventType: "analyzed",
    payload: { kind: "analyzed", stepsDiagnosed: 20, proposalsCreated: 0, skips: bigSkips }, templateVersion: 1 }, NOW)).toThrow(/payload/i);
});

it("rolled_back payload round-trips the frozen outcome snapshot", () => {
  recordEvent(db, { templateId: "tpl", proposalId: "p1", stepTemplateId: "s1", eventType: "rolled_back", templateVersion: 3,
    payload: { kind: "rolled_back", outcome: { targetDelta: -0.08, targetDeltaVersions: { latest: 3, prior: 2 }, invalidOutputRateDelta: null, regressionDetected: true } } }, NOW);
  const [e] = listEventsByTemplate(db, "tpl");
  expect(e.payload).toMatchObject({ kind: "rolled_back", outcome: { targetDelta: -0.08, regressionDetected: true } });
});
```

- [ ] **Step 3: Run to verify failures** — `pnpm -C packages/contracts test -- src/learning && pnpm -C apps/daemon test -- src/learning/events.test.ts` → FAIL (missing exports/module/table).

- [ ] **Step 4: Implement** contracts, `events.ts` (INSERT with explicit columns; `LearningEvent.parse` before insert; serialized-payload length check with a clear error), migration registration. `pnpm --filter @orca/contracts build`.

- [ ] **Step 5: Run** — contracts + `pnpm -C apps/daemon test -- src/learning src/migrations.test.ts src/migrations test/migrations-0006.test.ts && pnpm -C apps/daemon exec tsc --noEmit` → PASS.

- [ ] **Step 6: Commit**
```bash
git add packages/contracts apps/daemon/migrations/0056_learning_events.sql apps/daemon/src/migrations.ts apps/daemon/src/learning/events.ts apps/daemon/src/learning/events.test.ts apps/daemon/src/migrations.test.ts apps/daemon/src/migrations/suggested-orchestration.test.ts apps/daemon/test/migrations-0006.test.ts
git commit -m "feat(learning): learning_events spine — contracts, migration 0056, store module

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Emission wiring + atomicity + rollback outcome snapshot

**Files:**
- Modify: `apps/daemon/src/learning/diagnose.ts` (return skips), `apps/daemon/src/learning/usecases.ts` (created/judged/analyzed), `apps/daemon/src/learning/apply.ts` (applied/superseded/rolled_back/baseline_restored + `dismissProposal`), `apps/daemon/src/learning/routes.ts` (dismiss uses new fn; rollback computes outcome)
- Test: `apps/daemon/src/learning/usecases.test.ts`, `apps/daemon/src/learning/apply.test.ts`, `apps/daemon/src/learning/diagnose.test.ts`

**Interfaces:**
- Consumes: `recordEvent`, `currentTemplateVersion` (Task 1); `RollbackOutcomeSnapshot` (Task 1).
- Produces:
  - `diagnoseTemplate` returns `{ bundles: DiagnosisBundle[]; skips: { stepTemplateId: string; reason: string }[] }` (the R4 invalid-schema skip populates `skips`; keep the console-warn-free `continue` but record the reason).
  - `analyzeTemplate` emits: one `created` event per inserted proposal (same transaction as `insertProposal`), then one `analyzed` event (payload: `stepsDiagnosed = bundles.length + skips.length`, `proposalsCreated`, `skips` = diagnose skips + safeParse-net skips, each reason ≤ 300 chars).
  - `judgeProposal`'s `persist` wraps `setProposalJudgment` + `judged` event in one transaction.
  - `apply.ts`: `applied` + one `superseded {by:"apply"}` per superseded pending (extend `supersedeOtherPending` to return the superseded ids: `RETURNING id` or a pre-select) inside the apply transaction; `rolled_back` (payload from `opts.outcome ?? {targetDelta:null,targetDeltaVersions:null,invalidOutputRateDelta:null,regressionDetected:false}`) inside the rollback transaction — `rollbackAppliedProposal` opts gains optional `outcome?: RollbackOutcomeSnapshot`; staleness-supersede in `applyLearnedInstructionEdit` emits `superseded {by:"staleness"}` (OUTSIDE the transaction like the supersede itself — wrap the pair in their own mini-transaction); `restoreTemplateDefault` emits `baseline_restored {supersededCount}` (use `.run().changes` from `supersedeAppliedForTemplate`, extend it to return the count) inside its transaction. New export `dismissProposal(db, id, { decidedBy, now })` in apply.ts: transaction of `updateProposalDecision(status dismissed)` + `dismissed` event; throws `StepNotFoundError`/`ProposalNotPendingError` like siblings.
  - `routes.ts`: dismiss handler calls `dismissProposal`; rollback handler, BEFORE calling rollback, computes the outcome: `const p = getProposal(db, id)` (404 if missing); if `p.status === "applied"`, `const enriched = listProposalsEnriched(db, p.templateId, "30d").find((x) => x.id === id)`, build `outcome` from its `targetDelta/targetDeltaVersions/invalidOutputRateDelta/regressionDetected` (each `?? null` / `?? false`), pass into `rollbackAppliedProposal`.
- `template_version` rules: `created`/`analyzed`/`judged`/`dismissed`/`superseded` = `currentTemplateVersion(db, templateId)` at emit time; `applied` = the pre-bump `tpl.version`; `rolled_back` = pre-bump version at rollback; `baseline_restored` = pre-restore version.

- [ ] **Step 1: Failing tests.**

`diagnose.test.ts` — update every call site for the new return shape (`const { bundles } = diagnoseTemplate(...)` or destructure), and:
```ts
it("returns the R4 invalid-schema skip as a skip entry", () => {
  const r4 = step({ score: 70, failureClusters: [], quality: { ...step().quality, verdictPassRate: 0.9, oracleSufficientRate: null } });
  const { bundles, skips } = diagnoseTemplate({ detail: detail([r4]), signals: [], stepMeta: new Map() });
  expect(bundles).toHaveLength(0);
  expect(skips).toEqual([{ stepTemplateId: "s1", reason: expect.stringMatching(/schema/i) }]);
});
```

`usecases.test.ts` (extend the existing real-sqlite harness):
```ts
it("analyze emits created + analyzed events; skipped proposals appear in the analyzed payload", async () => {
  // reuse the existing forced-bad-bundle setup: diagnoseTemplate mocked to return one good
  // instructions bundle and one bad schema bundle (beforeInstructions "[]" via the net path)
  const created = await analyzeTemplate(deps, db, TPL, "7d", NOW);
  const events = listEventsByTemplate(db, TPL);
  const types = events.map((e) => e.eventType);
  expect(types).toContain("created");
  expect(types).toContain("analyzed");
  const analyzed = events.find((e) => e.eventType === "analyzed")!;
  expect(analyzed.payload).toMatchObject({ kind: "analyzed", proposalsCreated: created.length });
  expect((analyzed.payload as { skips: unknown[] }).skips.length).toBeGreaterThanOrEqual(1);
});
```

`apply.test.ts`:
```ts
it("apply emits applied (pre-bump version) + superseded-by-apply; failed apply emits nothing", () => {
  seedSecondPendingForSameStep(); // sibling pending proposal
  applyLearnedInstructionEdit(db, proposalId, { decidedBy: "user", now: NOW });
  const events = listEventsByTemplate(db, TPL);
  const applied = events.find((e) => e.eventType === "applied")!;
  expect(applied.templateVersion).toBe(1);                      // pre-bump
  expect(applied.payload).toMatchObject({ appliedAsVersion: 2 });
  expect(events.filter((e) => e.eventType === "superseded")).toHaveLength(1);

  const before = listEventsByTemplate(db, TPL).length;
  expect(() => applyLearnedInstructionEdit(db, schemaProposalId, { editedInstructions: "not json", decidedBy: "user", now: NOW })).toThrow(InvalidSchemaEditError);
  expect(listEventsByTemplate(db, TPL)).toHaveLength(before);   // nothing emitted
});

it("rollback emits rolled_back with the provided frozen outcome", () => {
  rollbackAppliedProposal(db, appliedId, { decidedBy: "user", now: NOW2,
    outcome: { targetDelta: -0.08, targetDeltaVersions: { latest: 2, prior: 1 }, invalidOutputRateDelta: null, regressionDetected: true } });
  const e = listEventsByTemplate(db, TPL).find((x) => x.eventType === "rolled_back")!;
  expect(e.payload).toMatchObject({ outcome: { targetDelta: -0.08, regressionDetected: true } });
});

it("dismissProposal transitions + emits atomically; restore emits baseline_restored with count", () => {
  dismissProposal(db, pendingId, { decidedBy: "user", now: NOW });
  expect(getProposal(db, pendingId)!.status).toBe("dismissed");
  expect(listEventsByTemplate(db, TPL).some((e) => e.eventType === "dismissed" && e.proposalId === pendingId)).toBe(true);
  restoreTemplateDefault(db, TPL, NOW2); // baseline captured earlier by the apply above
  const r = listEventsByTemplate(db, TPL).find((e) => e.eventType === "baseline_restored")!;
  expect((r.payload as { supersededCount: number }).supersededCount).toBeGreaterThanOrEqual(0);
});
```
(Adapt seeding/fixture names to the files' real helpers, as in all prior tasks.)

- [ ] **Step 2: Run to verify failures.**
- [ ] **Step 3: Implement** per the Interfaces block. Emission is plain function calls to `recordEvent` inside the existing `db.transaction(...)` bodies (better-sqlite3 nests fine via savepoints when needed — but prefer emitting inside the SAME transaction function, not a nested one). For `analyzed`, emit AFTER the proposal loop, outside per-proposal transactions (its own single insert; wrap `insertProposal`+`created` per proposal in one small transaction). Cap each skip reason with `.slice(0, 300)`.
- [ ] **Step 4: Run** — `pnpm -C apps/daemon test -- src/learning && pnpm -C apps/daemon exec tsc --noEmit`, then full `pnpm -C apps/daemon test`. Route tests may need the dismiss handler update reflected.
- [ ] **Step 5: Commit**
```bash
git add apps/daemon/src/learning
git commit -m "feat(learning): every loop transition emits a learning event — atomic, version-stamped, rollback freezes its outcome

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Events route + desktop API client

**Files:**
- Modify: `apps/daemon/src/learning/routes.ts` (GET events), `apps/desktop/src/api.ts` (client fn near the other learning calls, ~line 950+)
- Test: `apps/daemon/src/learning/routes.test.ts`

**Interfaces:**
- Produces: `GET /v1/learning/templates/:id/events?limit=N` → `{ events: LearningEvent[] }` (404 `template_not_found` for unknown template; limit default 50, clamped 1–100). Desktop: `export async function listLearningEvents(templateId: string, limit = 50): Promise<LearningEvent[]>` following the existing fetch-wrapper idiom in api.ts.

- [ ] **Step 1: Failing route test** (follow `routes.test.ts`'s existing server+db harness):
```ts
it("GET events returns newest-first events; 404 on unknown template", async () => {
  // seed two events via recordEvent
  const res = await server.inject({ method: "GET", url: `/v1/learning/templates/${TPL}/events?limit=1` });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { events: unknown[] };
  expect(body.events).toHaveLength(1);
  const missing = await server.inject({ method: "GET", url: `/v1/learning/templates/nope/events` });
  expect(missing.statusCode).toBe(404);
});
```
- [ ] **Step 2: RED.** — [ ] **Step 3: Implement** route (mirror the proposals GET shape) + api.ts client. — [ ] **Step 4: Run** learning tests + desktop tsc. — [ ] **Step 5: Commit**
```bash
git add apps/daemon/src/learning/routes.ts apps/daemon/src/learning/routes.test.ts apps/desktop/src/api.ts
git commit -m "feat(learning): events route + desktop client

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Calibration projection + divergence insights

**Files:**
- Modify: `apps/daemon/src/metrics/verification.ts` (add `computeCalibration` — it owns tier logic), `apps/daemon/src/metrics/aggregate.ts` (summary embeds calibration; `deriveInsights` gains optional calibration arg; `computeStepMetrics` input gains optional `calibration`), `apps/daemon/src/metrics/usecases.ts` (compute once in detail path, pass to steps)
- Test: `apps/daemon/src/metrics/verification.test.ts`, `apps/daemon/src/metrics/aggregate.steps.test.ts`

**Interfaces:**
- Produces:
```ts
// verification.ts
export const CALIBRATION_MIN = 5;        // min independently-concluded claims per tier
export const CALIBRATION_COVERAGE = 0.5; // evidence tiers: refutes-run / passes floor
export const CALIBRATION_DIVERGENCE = 0.2;
export type CalibrationEntry = { tier: VerificationTier; assumed: number; measured: number | null; sampleSize: number; state: "measured" | "insufficient" | "unmeasurable" };
export function computeCalibration(transitions: TemplateTransition[]): CalibrationEntry[];
```
Semantics (Global Constraints block): dedupe to final completions per `(workflowRunId ?? id)::(stepTemplateId ?? "")` latest-by-createdAt over `boundary === "step_complete"`; per tier T ∈ {verified_executed, partially_verified, ai_reviewed, self_reported}: `passes` = non-vFail completions at T (same vFail semantics as aggregate: evidence failed/partial, or no-evidence+refuted); `overturned` = completions at T with `refute?.verdict === "refuted"`; `claims = passes + overturned`; `measured = claims === 0 ? null : passes/claims`; state: self_reported → `unmeasurable`; evidence tiers with `passes > 0 && refutesRunAmongPasses/passes < CALIBRATION_COVERAGE` → `unmeasurable`; `claims < CALIBRATION_MIN` → `insufficient`; else `measured`. (`measured` value still reported for insufficient/unmeasurable? No — null unless state === "measured", keeping the display honest.)
- `computeTemplateSummary` calls `computeCalibration(input.current.transitions)` → `calibration` on the returned summary.
- `deriveInsights(step, calibration?: CalibrationEntry[])`: appends, when the entry for `step.verification.tier` has `state === "measured" && sampleSize >= 10 && |measured − assumed| > CALIBRATION_DIVERGENCE`:
  `"Independent review upholds ${pct(measured)}% of this step's passes; the score assumes ${pct(assumed)}% — scores here may be too ${measured > assumed ? "pessimistic" : "optimistic"}."`
- `computeStepMetrics` input gains `calibration?: CalibrationEntry[]`, forwarded to `deriveInsights`. `getTemplateMetricsDetail` computes calibration once from the same transitions and passes it to `computeStepMetrics` (the summary recomputes internally — same pure function, same inputs, same result).

- [ ] **Step 1: Failing tests.** `verification.test.ts` (build transitions with the same inline fixture shape used in aggregate.steps.test.ts):
```ts
describe("computeCalibration", () => {
  it("measures ai_reviewed survival among independently-concluded claims", () => {
    // 13 upheld + 2 refuted no-evidence completions (distinct runs) → claims 15, measured 13/15 ≈ 0.867, state measured
    const entry = computeCalibration(ts).find((c) => c.tier === "ai_reviewed")!;
    expect(entry.state).toBe("measured");
    expect(entry.measured).toBeCloseTo(13 / 15);
    expect(entry.sampleSize).toBe(15);
    expect(entry.assumed).toBeCloseTo(0.55);
  });
  it("self_reported is always unmeasurable; zero-refute evidence tier is unmeasurable (never measured 1.0)", () => {
    // 6 evidence-passed completions with NO refute → verified/partially tier: passes 6, coverage 0 → unmeasurable, measured null
  });
  it("below CALIBRATION_MIN claims → insufficient with measured null", () => { /* 3 upheld + 1 refuted */ });
});
```
`aggregate.steps.test.ts`: divergence insight — feed `computeStepMetrics` a calibration array `[{ tier: "ai_reviewed", assumed: 0.55, measured: 0.87, sampleSize: 13, state: "measured" }]` with an ai_reviewed step fixture → `step.insights` contains `/upholds 87%.*assumes 55%.*pessimistic/`; a non-matching tier or sampleSize 9 → no such insight.

- [ ] **Step 2: RED.** — [ ] **Step 3: Implement** per Interfaces (constants beside `TIER_CONFIDENCE`, single table, commented as designed priors). — [ ] **Step 4: Run** `pnpm -C apps/daemon test -- src/metrics && pnpm -C apps/daemon exec tsc --noEmit`, then full daemon + contracts build/test (summary contract gained a required field — fixture ripple: any `TemplateMetricsSummary` literal in tests gains `calibration: []`; grep daemon `diagnose.test.ts` `detail()` fixture and desktop fixtures; desktop tsc must stay green).
- [ ] **Step 5: Commit**
```bash
git add packages/contracts/src/metrics/index.ts apps/daemon/src/metrics apps/desktop
git commit -m "feat(metrics): per-tier calibration readout (display-only) + divergence insights

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Carried follow-ups cleanup

**Files:**
- Create: `packages/contracts/src/metrics/failure-labels.ts` (catalog moves here); Modify: `apps/daemon/src/metrics/failure-labels.ts` (re-export), `packages/contracts/src/metrics/index.ts` (export), `apps/desktop/src/metrics/SelfImprovement.tsx` (targets line uses `labelForFailure`), `apps/daemon/src/learning/routes.test.ts` (422 test), `apps/desktop/src/metrics/SelfImprovement.tsx` (empty-chips fallback), `apps/daemon/src/learning/schema-mutation.test.ts` (fresh-add test), `apps/daemon/src/metrics/aggregate.ts` (verification.confidence comment + survivorship-edge fix), `apps/desktop/src/metrics/SelfImprovement.tsx` (0.2 comment)
- Test: named per item below.

**The seven items (each = failing test or comment, then fix):**
1. **Shared failure labels.** Move the `CATALOG` + `labelForFailure` from `apps/daemon/src/metrics/failure-labels.ts` into `packages/contracts/src/metrics/failure-labels.ts` (exported from the contracts package index); the daemon file becomes `export { labelForFailure } from "@orca/contracts";` (keep its test importing the daemon path — it must still pass unchanged, proving the re-export). Desktop `SelfImprovement.tsx` targets line becomes `targets {p.targetedFailureMode.failureCode ? labelForFailure(p.targetedFailureMode.failureCode) : p.targetedFailureMode.rule}`. Test: SelfImprovement render with `failureCode: "evidence_veto"` shows "Automated checks failed, so the completion was rejected" and passes the five-term guard.
2. **Routes 422 test.** In `routes.test.ts`: POST apply with `editedInstructions: "not json"` on a seeded schema proposal → 422 `{ error: { code: "invalid_schema_edit" } }`.
3. **Empty-chips fallback.** In the pending card, when `p.component === "step_output_schema"` and `schemaChips(...)` returns `[]`, render `<div>Adds required structure — open Review change.</div>` instead of nothing. Test: schema proposal whose after only extends a description → fallback text renders.
4. **Fresh-add description test.** `schema-mutation.test.ts`: adding a `description` to a field that never had one → `{ ok: true }`.
5. **`verification.confidence` comment.** In `aggregate.ts` where `confidence: scoreValue ?? 0` is set: `// null score collapses to 0 here — UI gates on score==null first; widen if a consumer ever needs the distinction.`
6. **Survivorship edge fix.** In `aggregate.ts`, `completeRunIds` currently includes ANY final completion's run — a run whose final step-run attempt hard-failed AFTER an earlier completed attempt still counts its earlier pass and escapes `hardFailedFinals`. Fix: build `completeRunIds` only from final completions, and additionally treat a run as hard-failed when its FINAL step-run attempt has a FAILED_STATUSES status AND finished after the run's last `step_complete` (`finals` row's `finishedAt` > the completion's `createdAt`); such runs move from the scored-completion set into `hardFailedFinals` (remove their completion from `finalStepCompletes` scoring via exclusion from `conclusive` — implement as a `supersededByHardFail` set checked in `scoreOver`'s filter). Test: run r1 with attempt-1 passed `step_complete` at T1 and a final attempt-2 step-run `status: "failed", finishedAt: T2 > T1`, no second completion → `score` treats r1 as a hard fail (score 0 contribution), not a 1.0 pass. Keep the fix surgical; if `finishedAt` is null on the failed final attempt, fall back to current behavior (no reclassification) — comment why (no evidence of ordering).
7. **Threshold comment.** Above the desktop canary line's `0.2`: `{/* mirrors SCHEMA_INVALID_OUTPUT_THRESHOLD (daemon canary.ts) — regressionDetected still gates the button */}`.

- [ ] **Step 1:** Write the failing tests/items 1–4, 6. — [ ] **Step 2: RED.** — [ ] **Step 3:** Implement all seven. — [ ] **Step 4:** `pnpm -C packages/contracts test && pnpm --filter @orca/contracts build && pnpm -C apps/daemon test && pnpm -C apps/daemon exec tsc --noEmit && pnpm -C apps/desktop test -- src/metrics && pnpm -C apps/desktop exec tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**
```bash
git add packages/contracts apps/daemon apps/desktop
git commit -m "fix(learning,metrics): carried follow-ups — shared failure labels, 422 test, survivorship edge, whitelist + UI nits

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Timeline UI + calibration panel

**Files:**
- Create: `apps/desktop/src/metrics/learning-log.ts` (pure event→line mapper, testable)
- Modify: `apps/desktop/src/metrics/SelfImprovement.tsx` (timeline replaces the history `<details>`; calibration panel section)
- Test: `apps/desktop/src/metrics/learning-log.test.ts`, `apps/desktop/src/metrics/SelfImprovement.test.tsx`, `apps/desktop/src/metrics/no-jargon.test.tsx`

**Interfaces:**
- Consumes: `listLearningEvents` (Task 3), `LearningEvent` contract (Task 1), `labelForFailure` from contracts (Task 5), `TemplateMetricsSummary.calibration` (Task 4).
- Produces (`learning-log.ts`):
```ts
export function eventLine(e: LearningEvent, stepName: (id: string | null) => string): string;
export function synthesizedLine(p: TemplateInstructionProposal, stepName: (id: string | null) => string): string; // "(before the learning log existed)" marker
```
Copy map (exact strings, jargon-free — spec §3.4):
- created → `Proposed ${component === "step_output_schema" ? "a tighter output check" : "an instruction edit"} for ${step} — targets ${failureCode ? labelForFailure(failureCode) : ruleText(rule)}.` where `ruleText` = R1 "underperforming scores" / R3 "repeated user re-steers" / R4 "weak verification" (R2 always has a failureCode).
- judged → `Independent evaluation: ${verdictLabel} (${s} solved · ${f} failure cases).` (reuse the existing VERDICT_META labels)
- applied → `Applied as v${appliedAsVersion}${humanEdited ? " (edited before applying)" : ""}.`
- dismissed → `Dismissed.` · superseded → `Superseded (${by === "apply" ? "another change was applied" : by === "staleness" ? "the template moved on" : "defaults restored"}).`
- rolled_back → outcome-driven: regressionDetected && invalidOutputRateDelta != null && invalidOutputRateDelta > 0.2 → `Rolled back — new checks were rejecting output (+${round}%).`; regressionDetected && targetDelta != null && !targetImproved-equivalent (targetDelta <= 0) → `Rolled back — the target step didn't improve (${pts} points, v${prior}→v${latest}).`; regressionDetected otherwise → `Rolled back — a watched measure regressed.`; else `Rolled back.`
- analyzed → `Reviewed ${stepsDiagnosed} step${s} — ${proposalsCreated > 0 ? `created ${n} proposal${s}` : "nothing to propose"}${skips.length ? `; skipped ${skips.map(k => `${stepName(k.stepTemplateId)}: ${k.reason}`).join("; ")}` : ""}.`
- UI: replace the `history` `<details>` block with **"Learning log"**: fetch `listLearningEvents(templateId)` alongside proposals (same effect), render newest-first `eventLine` rows (timestamp `e.createdAt.slice(0, 16).replace("T", " ")` in `--text-4`), append `synthesizedLine` rows for proposals whose id appears in NO event (match by proposalId). Second collapsed section **"How well-calibrated are the scores?"** rendering `summary.calibration` per the approved mock: per tier — tier label (reuse the TIER label strings already rendered elsewhere in desktop metrics), `assumed N%`, then `measured M% (n=K)` / `— (n=K, too few)` / `unmeasurable — no independent check exists` / `unmeasurable — checks rarely run at this tier`, plus the fixed footer line "Coefficients are fixed constants; this panel shows whether they match reality as runs accrue." Needs `summary` — `SelfImprovementRail` already receives `detail` (which has `summary`).

- [ ] **Step 1: Failing tests.** `learning-log.test.ts`: one assertion per event type against the exact copy above (fixtures = LearningEvent literals); rolled_back all four variants; analyzed with and without skips; synthesized line contains "(before the learning log existed)". `SelfImprovement.test.tsx`: rail renders the learning log from mocked `listLearningEvents` (newest first), synthesized row for an event-less proposal, calibration panel three states. `no-jargon.test.tsx`: extend the rail render to include events of every type + calibration panel; five-term regex finds nothing.
- [ ] **Step 2: RED.** — [ ] **Step 3: Implement.** — [ ] **Step 4:** `pnpm -C apps/desktop test -- src/metrics && pnpm -C apps/desktop exec tsc --noEmit` → PASS.
- [ ] **Step 5: Commit**
```bash
git add apps/desktop/src/metrics apps/desktop/src/api.ts
git commit -m "feat(metrics-ui): learning log timeline + calibration panel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Docs + repo verification + live check

- [ ] **Step 1: Docs.** ORCA.md (5B/SP2 paragraphs gain SP3: event spine per FA's append-only invariant, calibration readout display-only with fixed coefficients, timeline; honesty caveats: calibration is observational/windowed, events start at SP3 with synthesized markers for older proposals). FUTURE_WORK.md: SP3 landed; note remaining (owner-scoping, per-version calibration, coefficient governance) as future. FUTURE_ARCHITECTURE.md: only if the learning-loop paragraph should note the spine now covers learning (one clause, additive).
- [ ] **Step 2: Sweep.** `pnpm -C packages/contracts test && pnpm -C apps/daemon exec tsc --noEmit && pnpm -C apps/daemon test && pnpm -C apps/desktop exec tsc --noEmit && pnpm -C apps/desktop test` (App.test.tsx flake excepted, same-on-base check if it fires). Purity grep over the branch diff → production hits zero.
- [ ] **Step 3: Live check** (tsx-watch daemon hot-reloads this tree; confirm via daemon.json pid + a request): migration 0056 applied; `GET /v1/learning/templates/orca%2Fadaptive-delivery/events` → `{"events":[]}`; metrics summary carries `calibration` (expect ai_reviewed measured/insufficient per live sample sizes, self_reported unmeasurable); Metrics tab renders the learning log (synthesized/empty state) + calibration panel with no jargon/NaN. Billed analyze remains user-triggered.
- [ ] **Step 4:** Commit docs; final whole-branch review per the executing skill.

---

## Self-Review Notes
- **Spec coverage:** §3.1→T1+T2; §3.2→T3; §3.3→T4; §3.4→T6; §5 edge cases→T2 (atomicity, zero-steps analyzed, null snapshot), T1 (cap), T4 (no measured-1.0-by-absence); §6→T5 (all seven); §8 criteria 1-9→T2,T2,T2,T2,T3,T4,T6,T5,T7.
- **Type consistency:** `recordEvent`/`listEventsByTemplate`/`currentTemplateVersion`, `LearningEvent(Payload)`/`RollbackOutcomeSnapshot`, `computeCalibration`/`CalibrationEntry`/`CALIBRATION_MIN|COVERAGE|DIVERGENCE`, `dismissProposal`, `eventLine`/`synthesizedLine`, `listLearningEvents` — names used identically across tasks.
- **Known simplifications, deliberate:** rollback snapshot uses the 30d window (widest available; noted in T2); calibration recomputed twice on the detail path (same pure fn — cheap, keeps computeTemplateSummary self-contained); survivorship-edge fix declines to reclassify when `finishedAt` is null (no ordering evidence — commented).

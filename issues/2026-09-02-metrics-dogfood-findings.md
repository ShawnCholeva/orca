# Findings — Metrics redesign + live dogfooding (2026-09-02)

Tracked defects and inconsistencies found during the Metrics-tab redesign and the
Playwright drive-through of the real app. Owner column is the session that found or
holds it. **Status: `open` unless stated.**

---

## A. Product bugs (outside the metrics work, higher user impact)

| # | Issue | Status | Notes |
|---|---|---|---|
| A1 | **Boot reaper killed live workers mid-spawn.** `sessions.status` inserts as `created`, flips to `running` only after spawn; reaper kept only `('running','starting')`, and `'starting'` is written nowhere. 14 of 19 recorded worker deaths were within 40s of a daemon boot. | **FIXED** `defb43e` | Denylist, not widened allowlist. Twin bug in `workerSessionIdsForRun` fixed same commit. |
| A2 | **Nothing notifies the user when a run parks on them.** A confirm card sat **17h 57m**. Reproduced on a fresh run within 10 minutes: the agent asked a question and there was no badge, title change, or notification. | **OPEN — highest user impact** | Not a metrics gap. No screen design fixes it. |
| A3 | **Runs terminate without resolving/expiring pending activities.** 3 prompts orphaned 48–50h on runs already blocked. One prompt opened **8s after** its run's last transition. | OPEN | Likely downstream of A1; expiry path exists but didn't fire. |
| A4 | **`SessionCostAccumulator` grew unbounded** — one `drain()`, reachable only from `step_complete`/`mark_done`; gate surrogates, refute turns, shadow sessions and crashed steps never drain. | **FIXED** `4559e0e` | ⚠️ **Bounding it saves MEMORY, not money.** Those tokens were never written anywhere and died with the process either way. The lead repeatedly mis-stated this as "actively destroying cost data" — see E. Eviction is by **age on ingest**, deliberately not on session termination: a crashed step's `step_complete` fires *after* the session is marked failed, so evicting there would race the drain and destroy exactly the cost data a crashed run makes most interesting — and 74% of recorded worker deaths are crashes. |
| A11 | **Gate emission is the fix that actually makes gate spend visible.** Gates spawn real agent sessions on the user's subscription and emit no transitions, so their cost is `captured-but-discarded` — ingested into the accumulator, never persisted. Distinct from A4 and not addressed by it. | OPEN — raised in priority | Contract written in `2026-09-02-run-trace-contract.md` §6: emit the existing `step_launch`/`step_complete` on the gate surrogate, inside `closeSurrogate()` (five call sites). |
| A5 | **Trust prompt quit the agent.** Blind `sendEnter` selected `❯ No, exit`. Shadow path and worker path. | **FIXED** `81347d7`, `1ca6200` | Worker path was still live and would have poisoned scratch-workspace data generation. |
| A6 | **924s watchdog lag.** `sessions.exited_at` is the watchdog's stamp, not the death; one row lagged 15.4 min. | OPEN | Consequence: any duration derived from `exited_at` measures *detection*, not death. |
| A7 | **5 remaining `IN ('running','starting')` read sites** blind to a session in its spawn window. | **FIXED** `ca56037`, `4de1bc3`, `f15f47b` | 7 of 9 swept; 2 excluded deliberately with reasons. |

| A8 | **A step phase set by three paths and cleared by one.** `maybeRefute` sets `orchestrator_phase='independent_check'` and is reachable from all three `applyOrchestratorAction` call sites, but only `onAgentResponseDone` wraps it in a `try/finally` that clears it. A call arriving via `runStashedJudgeRetry` or `onUserMessage` raises the phase and nothing lowers it. The chat renders "Running an independent check…" off that flag, so the step advertises a check that finished minutes ago and **the mark-done card never gets a turn** — the run is parked on the user with no control to unpark it. Proof is in the *sequence*: every healthy cycle is `reviewing → independent_check → null`; the broken one is missing `reviewing`. Fix: whoever sets the phase clears it (`maybeRefute` gets its own `finally`), not a wrapper at each call site — that's the allow-list mistake `'starting'` already taught us. | **OPEN — fix A in progress** | Found by two surfaces on two tables disagreeing; diagnosed by the append-only event stream, which the mutable row could not have revealed. |
| A10 | **`awaiting_user` is never set when `mark_done_pending` is raised.** It's written from `applyOrchestratorAction`'s `postedChatReply`, the right discriminator for chat replies — but the mark-done park comes up the recommendation/activity path, which never touches the column. A gap in wiring, not a misfiring feature. | OPEN | Separate commit from A8; may or may not be required for the card to render. |
| A8-orig | *(superseded by A8 above)* Orchestrator stuck in `orchestrator_phase='independent_check'`. Refute completed (valid JSON verdict, pane idle, `Cooked for 30s · done`), `finished_at` written, but status stayed `active` and the phase never advanced. `pending_completion_json` NULL. Preceded by a daemon restart mid-flight (`crash_retries=2`). Suspected restart-durability gap in the completion path — the worker survives now, the orchestrator's memory of what it was doing does not. | **OPEN — live reproduction** | Run `01a06587`. `finished_at` set while `status='active'` should not coexist. |
| A9 | **500 on `POST /decide-gate` when the daemon restarts mid-request.** The write commits; only the response is lost. User sees an error for an action that succeeded, inviting a double-submit. | OPEN | Same root condition as A8. |

| A12 | **A2 demonstrated at 38.6 hours, on the lead's own test run.** Run `01a06587` parked on `provider_recovery_pending` and nothing notified anyone. Current state: **elapsed 39.4h, parked 39.2h (99.5%), working 0.1h**, still `accruing: true`. The founder's original complaint was an 18-hour confirmation card; this is the same defect at twice the duration, reproduced accidentally by the person investigating it, while actively working on the project. Nobody noticed for a day and a half. | **OPEN** — the strongest single argument for A2's priority |
| A13 | **The ledger has no staleness bound on a live run.** An abandoned run renders identically to one that started 30 seconds ago, and its `elapsedMs` grows forever because `accruing: true` has no upper bound. Note this is the *mirror* of the settled elapsed rule: product correctly decided elapsed must NOT tick for a **terminated** run (a 17-minute run must not claim "50h and counting"); the unexamined case is a run that is technically `active` and practically abandoned. Consequence for aggregates: one forgotten run's parked time grows without limit and will eventually dominate any window that includes it. | OPEN — framing is product's call |

## B. Metrics screen — data and doctrine

| # | Issue | Status |
|---|---|---|
| B1 | `Triage 16/100 F` next to "Nothing failing this period" — score from step_run **status**, failure list from evidence **facets**. A crash loop through a quality lens. | Diagnosed; dissolved by redesign |
| B2 | Score, tier and band computed over **three different populations** (n=4.5, n=1, n=1), rendered adjacently with no indication. | OPEN — rule recorded |
| B3 | `trajectoryEfficiency` unit collision — mean tokens/transition, unnormalised, in a grid of 0..1 fractions, inverted sign. Renders `23103.596…`. | Adjudicated: redefine as wasted-spend ratio |
| B4 | `recovery` and `replayability` don't measure their names. | Adjudicated: retire both |
| B5 | `versionComparison` has no per-side sample guard — renders v16 (1 run) vs v14 (3 runs). | OPEN — `deltaAllowed` must gate at emit |
| B6 | Period selector inert: 7d and 30d return byte-identical data. | OPEN |
| B7 | `opacity: 0.55` as the entire response to low confidence. | Banned by spec |
| B8 | `gate-metrics.ts` sums `tokens_in + tokens_out`, excluding cache — reports 11k for a step that moved 690k (60× understatement). | OPEN |
| B9 | Gates emit **zero** harness transitions; every gate cost/latency field is structurally null. | OPEN — contract written |
| B10 | `betaMean` would render **75%** for an observed 4-of-4. | Prevented — Wilson for display, test asserts it |
| B11 | `3/n` rule of three overstates below n≈30; exact bound is `1 − 0.05^(1/n)` (53% at n=4, not 75%). | Fixed in spec + module |

## C. Metrics screen — UI defects found by driving it

| # | Issue | Status |
|---|---|---|
| C1 | Self-improvement panel contradicts itself: **"6 steps underperforming"** directly above **"steps are healthy"**. | OPEN |
| C2 | After analysis: header says **6 steps**, result says **1 step**. Two populations, unreconciled. | OPEN |
| C3 | **"Analyze this template" spends money silently** — 60.8s, no cost warning, no elapsed counter, no cancel. Spawns an LLM call per qualifying step. | OPEN |
| C4 | `$0.00` rendered as the primary figure with "This isn't being recorded yet" as caption — *unmetered reads as free*. | **FIXED** `1ea4900` |
| C5 | Wilson interval on a **census** ("3 of 3 nodes reported a cost; between 37% and 100%"). | **FIXED** `1ea4900` |
| C6 | Ledger headline over-claimed ("killed by the daemon") past what session history supports. | **FIXED** `1ea4900` |
| C7 | Gate spans: `unaccountedMs` not computed, so four terms summed to 0 against nonzero elapsed. Caught by the `IntervalBar` mismatch guard on live data. | **FIXED** `1ea4900` |
| C8 | Gate spans rendered as raw `__gate__:critique`. | **FIXED** `1ea4900` |
| C9 | `"1 runs"` pluralization in the aggregate view. | **FIXED** `88fce5e` |
| C11 | **The aggregate view still renders a bare em dash for null metrics.** Its own test — `"renders em dash for null metrics (not 0 / F)"` — passes and honestly describes today's screen, but an em dash is exactly the untyped absence this project exists to remove. Flagged rather than silently ported during the default flip; converting the aggregate view to typed nulls is its own piece of work. | OPEN |
| C12 | **Metrics tab now defaults to the ledger.** Both the headline and the "can't tell you" block derive from one exported `workflowEvidenceRuns()` rather than two duplicate predicates that happened to agree. | **DONE** `88fce5e` |
| C10 | Copy dates were UTC; screen renders local. Screen is right — copy needs updating. | OPEN (copy) |
| C13 | **The run detail's title is invisible.** `RunDetailPanel`'s `<h2>` sets only `font-size` and `margin` inline, so its colour falls through to the global `styles.css` rule `h2 { color: #1a1a1a }` — near-black on the `#0B1020` app background. Measured on the live screen: **1.09:1** contrast against a 4.5:1 requirement, i.e. the template name on the detail view is not readable at all. The `<h3>`s beside it are fine because `styles.css` never styled `h3`. This is D7 not staying hypothetical: the defect is one inherited declaration from the legacy stylesheet, on the newest screen in the app. | OPEN — UI, mine |
| C14 | **`--accent` carries five meanings at once, three of them visible in a single run row.** It is simultaneously: the link/button colour (`MetricsPage` `linkBtn`, `← All runs`), the selected-tab state (`MetricsPage.tsx:194`), the `running` termination tone (`RunLedger.tsx:39`), the **"waiting on you"** duration segment (`interval-bar.tsx:138`), and the `insufficient`-sample border (`n-gate-ui.tsx:165`). So the widest band on most rows — the intervention tax, the screen's headline finding — is painted in the app's "this is interactive" colour. Compounding it, the segments render as a left-anchored green→blue fill, which is the progress-bar idiom; on a mixed row it is literally a green bar at 26%. Encoding fix proposed: hue = whose time (Orca/you), material = measured or not, unmeasured becomes the **track** rather than a third segment. | OPEN — UI, mine |

## C+. Executable axis — the harness over-crediting itself

| # | Issue | Status |
|---|---|---|
| E1 | **The sensor ladder counted a no-op stub script as a passing deterministic sensor.** `"typecheck": "echo no types"` exits 0, so the runner recorded `passed` — while the *agent* correctly classified it `skipped` ("it exercises no type checker, so it provides no signal"). This inverts the Executable axis: the deterministic oracle the self-report is meant to be checked against became the softer of the two. It fed `oracleAdequacy.sufficient`, the verification tier, and `composedScore` at `executable` weight **1.0** — the strongest tier in the ladder — for a command that did nothing. Widespread rather than exotic, since the catalog encourages declaring these scripts. | **FIXED** `d5e1f5c` |
| E2 | **The independent-check line contradicted the sensor list directly above it** — "a second AI reviewed it and agreed *but nothing was run or tested*" on a step where `npm test` ran and 5 tests passed. The clause was baked into the verdict label instead of reading `evidence.executed`. Mirror image of E1: E1 oversells a stub, E2 undersells real execution. | **FIXED** `d5e1f5c` |

**The invariant E1 establishes:** *a sensor's exit code is evidence about the command that ran; it is evidence about the artifact only if the command actually exercises the artifact.* Detection is deliberately narrow and provable — it reads the script **body** (which the detector already had and discarded) and asks whether any segment can fail. `echo x && node --test` is not a stub. Perfect detection is impossible (`tsc --version` exercises nothing either), so it catches the provable case and claims nothing about the rest. The asymmetry sets the bias: wrongly crediting a stub over-claims at the highest confidence in the ladder; wrongly skipping a real check only under-claims and is recoverable.

## D. App-wide UX found by driving it

| # | Issue | Status |
|---|---|---|
| D5 | Stepper shows `running` while the DB has `awaiting_user=1` — the stepper isn't consuming the flag. | OPEN |
| D6 | `tsx watch` daemon restarts (triggered by any agent editing a file) kill in-flight workers and burn crash-retry budget even with the reaper fixed. | OPEN — environmental |

| # | Issue | Status |
|---|---|---|
| D1 | **`Browse…` is dead in browser mode.** Calls the Tauri dialog unconditionally — `TypeError: Cannot read properties of undefined (reading 'invoke')` at `CoordinateStep.tsx:673`. No `isTauri()` guard, no user-facing error. **`WorkspacesPage.tsx` already does this correctly.** | OPEN |
| D2 | **"Step 4 of 6" vs stepper numbering 1,2,3,4,[gate],6,[gate],8** — numbering counts gates, total doesn't. | OPEN |
| D3 | **Confirm-card toggle named two things**: live card says "Evidence", resolved card says "Scores". `4c0f85e` missed the confirmed-card path. | OPEN |
| D4 | Attached workspace shows folder name (`orca-scratch`) not registered name ("Orca Scratch"). | OPEN |
| D7 | **Two design languages ship at once, and the dead one is the bigger file.** `theme/theme.css` + `theme/themes.ts` is the real system — three registered themes, tokens applied to `<html>` at runtime, referenced as `var(--…)`. `styles.css` is the legacy one: **2400 lines, 275 hardcoded hex values, 74 `var()` uses**, and a light-mode `body { background: #f5f5f5; color: #1a1a1a }` — still imported globally by `App.tsx:28`. Provably dead in part: `.status-header`, `.create-section`, `.goals-section`, `.connection-indicator` match **zero** `.tsx` files. The app renders dark correctly, so this is not a live theming bug — it is a live **precedent** bug: the largest stylesheet in the repo teaches hardcoded light-mode colour to whoever opens it next. **C13 is this hazard already biting**, via an inherited `h2` colour. Not scheduled, and deliberately not swept — CLAUDE.md §3 says don't delete pre-existing dead code on the way past. Recorded so the next person finds the diagnosis rather than repeating it. | OPEN — logged, not scheduled |
| D8 | **The token set stops before type and space, which is where the sprawl is.** `themes.ts` defines colour, radius, shadow and motion tokens and no type or spacing scale. Measured across `apps/desktop/src`: **21 distinct font sizes**, six of them half-pixel (8.5 / 9.5 / 10.5 / 11.5 / 12.5 / 13.5px), **88 uses below 11px**; **23 distinct spacing values** including 1, 2, 3, 5, 7, 9 and 11px; **564 inline `style={{…}}` objects**, densest on the newest surfaces (`RunLedger.tsx` 53, `StepPerformance.tsx` 63, `WorkspacesPage.tsx` 86). Colour is fine from inline styles because they reference `var(--…)` as strings; type and space have nothing to reference. Consequence: every new screen re-picks its own sizes and drifts on contact. | OPEN — scale landing with the ledger redesign |

## E. Process hazards (recurring, worth guarding)

- **A label travels further than its evidence.** Six instances: an illustration hardening into copy; the lead's cost reasoning; "confirmation cards" for a set containing a `tool_use`; "a permission request" for a stomped field; a constant (`SAMPLE_MIN`) used to conclude a code path was dead without reading it; a SHA cited for content it didn't contain.
  → **Guard: trace every label to the field that produces it before it ships.**
- **An enum value read but never written is a predicate that lies to its readers**, and it lies in the safe-looking direction. `'starting'`: read in 17–20 places, written in none.
  → **Guard: a test driving off the contract's own enum options.** Landed in `ca56037`.
- **In a shared worktree, file content answers "what is someone working on", never "what is committed."** Three agents hit this on one file inside an hour.
  → **Guard: `git show --stat <sha>` before citing a commit; check if the file is dirty before claiming what the running daemon does.**
- **`git add` and `git commit` are not atomic across agents.** One commit landed under another agent's message.
  → **Guard: `git add <paths> && git commit --only <paths>`. "no changes added to commit" is an alarm, not a no-op.**
- **A mechanism travels further than its evidence, the same way a label does.** The lead saw a daemon restart at 04:42:54 and a stall at 04:47 and connected them; one continuous pid spanned both. Read "UI still spinning" as "verdict never delivered" without looking for the delivery — the hook had fired 3ms before `finished_at`. Called `finished_at`-with-`status=active` a partial completion when it is the correct terminal-step shape, and would have "fixed" a non-bug.
  → **Guard: a plausible cause already in hand is the moment to keep looking, not to stop.**
- **State tells you what is; the append-only event stream tells you what didn't happen.** The mutable row said `independent_check` with no history and could never have shown that a clear was *missing* rather than *late*. Only the `phase_changed` sequence — and its missing `reviewing` — cracked it.
- **A claim true of one thing travels to the thing next to it, and hardens through retelling.** The lead took the `captured-but-discarded` framing — accurate about *gate cost* — attached it to the *accumulator leak*, and repeated the fused version three times, including to the founder. The vector was a lead paraphrasing between two specialists, which is precisely what peer-to-peer working is meant to reduce.
  → **Guard: when relaying a specialist's claim, relay which artifact it was about, not just the claim.**
- **A mutable row's `updated_at` is not evidence of progress.** A row touched by a retry loop is indistinguishable from a row doing work. On the stuck run, `activities.updated_at` and `activity.changed` both read *minutes ago* while every source that tracks real advancement read *39 hours ago* — so the obvious source for "last activity", the column literally named for it, would have inverted the design meant to surface the stall. Second timestamp on this project whose name promises more than it delivers (`sessions.exited_at` is the watchdog's stamp, not the death).
  → **Guard: ask what the number would SAY on real data before approving the surface that displays it.** Three findings tonight came from computing the value rather than reasoning about the field.
- **Name a field after its definition, not its concept — or the next implementer re-enters through the name.** The field was first specced as `lastActivityAt`, and "activity" is exactly what the misleading source (`activities.updated_at`) measures; the name was the trap's delivery mechanism. Renamed `lastProgressAt`. Generalised: **progress is defined by append-only state transitions, never by mutation timestamps.** A transition happened; a touch merely occurred.
- **A divergence between two clocks can be the only available discriminator.** `lastProgressAt` vs `lastSignalAt` looked like a data trap and turned out to separate *silent* (dead worker — both clocks old) from *spinning* (loop — progress old, signal recent). Nothing else in the system can see the second: the stall sensor only fires while Orca owes the next move, so a worker churning on its own looks alive to every existing check. Verified live on run `01a06587` — progress 39h stale, signal moving every few seconds.
- **When two stores can answer the same question, something must force them to agree** — a test at minimum. Three instances: the mark-done card (activities vs step-run row), A10 (`awaiting_user=0` while `paused_for_input`), and the rate denominators (per-step filtered, summary tiles not).
- **A ban recorded in a spec is not a ban applied to the code.** `opacity: 0.55` — the defect this project began with — was banned, logged as "banned by spec", and left rendering on the founder's screen in `MetricsPage.tsx:135` and `StepPerformance.tsx:142`. The new components' no-opacity test inspects only their own markup, so it could never reach the old ones.
  → **Guard: a rule needs a test with the same reach as the rule.**
- **An assertion that fires on healthy data is worse than none** — it burns the reader's belief that it means something.
- **Non-random termination contaminates a population** exactly as non-random missingness invalidates a bound. 4 of 5 runs died from infrastructure ⇒ effective n for workflow quality is **1, not 5**.

## F. Executable axis (found on a live run)

| # | Issue | Status |
|---|---|---|
| F1 | **Sensor ladder credited a stub script as a passing check.** `echo no types` exiting 0 recorded as `✓ typecheck`, while the agent honestly reported it `skipped` ("exercises no type checker, provides no signal"). Inverts the axis — the deterministic oracle was softer than the model's self-report. Also inflated `oracleAdequacy` and the tier, since `classifyTier`/`sourcesPassed`/`executed` all tested `sensorsRun.length > 0`, which a *skipped* sensor satisfies. | **FIXED** `d0ff433` |
| F2 | **"but nothing was run or tested" hardcoded into the `upheld` refute label**, firing on steps where sensors demonstrably ran and passed. Mirror image of F1 — undersells real execution evidence. | **FIXED** `d0ff433` |

Shared root cause, and it is E's hazard again: **a label that outlived the evidence it was written for.**

## G. Design system (found while grounding the UI work)

| # | Issue | Status |
|---|---|---|
| G1 | **The token system stops before type and space.** `themes.ts` defines color, radius, shadow and motion — no type scale, no spacing scale. Measured: **21 distinct font sizes** app-wide including six half-pixel values (8.5/9.5/10.5/11.5/12.5/13.5px) and 88 uses below 11px; 23 distinct spacing values including 1, 2, 3, 5, 7, 9, 11px; 564 inline style objects (53 in `RunLedger.tsx` alone). The metrics screens are the densest users of both — the sprawl is the ledger faithfully reflecting that there is no scale to snap to. | **IN PROGRESS** — additive type + space scale approved as part of the ledger cleanup |
| G2 | **Two design languages, one a trap.** `theme/theme.css` + `themes.ts` is the real system. `styles.css` is 2400 lines with **275 hardcoded hex colors** and a light-mode `body { background: #f5f5f5; color: #1a1a1a }`, still globally imported by `App.tsx`. Provably dead selectors: `.status-header`, `.create-section`, `.goals-section`, `.connection-indicator` match zero `.tsx`. Not a live visual bug — the app renders dark correctly — but a live **precedent** bug: the largest stylesheet in the repo teaches hardcoded light-mode colors to anyone who opens it. | OPEN — logged deliberately, not to be cleaned up in passing (CLAUDE.md §3) |

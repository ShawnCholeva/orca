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
| A4 | **`SessionCostAccumulator` grows unbounded.** One `drain()` in the daemon, reachable only from `step_complete`; gate surrogates, refute turns, shadow sessions and crashed steps never drain. | OPEN | Also means gate cost is `captured-but-discarded` — metered in RAM, lost on restart. |
| A5 | **Trust prompt quit the agent.** Blind `sendEnter` selected `❯ No, exit`. Shadow path and worker path. | **FIXED** `81347d7`, `1ca6200` | Worker path was still live and would have poisoned scratch-workspace data generation. |
| A6 | **924s watchdog lag.** `sessions.exited_at` is the watchdog's stamp, not the death; one row lagged 15.4 min. | OPEN | Consequence: any duration derived from `exited_at` measures *detection*, not death. |
| A7 | **5 remaining `IN ('running','starting')` read sites** blind to a session in its spawn window. | **FIXED** `ca56037`, `4de1bc3`, `f15f47b` | 7 of 9 swept; 2 excluded deliberately with reasons. |

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
| C9 | `"1 runs"` pluralization in the aggregate view. | OPEN |
| C10 | Copy dates were UTC; screen renders local. Screen is right — copy needs updating. | OPEN (copy) |

## C+. Executable axis — the harness over-crediting itself

| # | Issue | Status |
|---|---|---|
| E1 | **The sensor ladder counted a no-op stub script as a passing deterministic sensor.** `"typecheck": "echo no types"` exits 0, so the runner recorded `passed` — while the *agent* correctly classified it `skipped` ("it exercises no type checker, so it provides no signal"). This inverts the Executable axis: the deterministic oracle the self-report is meant to be checked against became the softer of the two. It fed `oracleAdequacy.sufficient`, the verification tier, and `composedScore` at `executable` weight **1.0** — the strongest tier in the ladder — for a command that did nothing. Widespread rather than exotic, since the catalog encourages declaring these scripts. | **FIXED** `d5e1f5c` |
| E2 | **The independent-check line contradicted the sensor list directly above it** — "a second AI reviewed it and agreed *but nothing was run or tested*" on a step where `npm test` ran and 5 tests passed. The clause was baked into the verdict label instead of reading `evidence.executed`. Mirror image of E1: E1 oversells a stub, E2 undersells real execution. | **FIXED** `d5e1f5c` |

**The invariant E1 establishes:** *a sensor's exit code is evidence about the command that ran; it is evidence about the artifact only if the command actually exercises the artifact.* Detection is deliberately narrow and provable — it reads the script **body** (which the detector already had and discarded) and asks whether any segment can fail. `echo x && node --test` is not a stub. Perfect detection is impossible (`tsc --version` exercises nothing either), so it catches the provable case and claims nothing about the rest. The asymmetry sets the bias: wrongly crediting a stub over-claims at the highest confidence in the ladder; wrongly skipping a real check only under-claims and is recoverable.

## D. App-wide UX found by driving it

| # | Issue | Status |
|---|---|---|
| D1 | **`Browse…` is dead in browser mode.** Calls the Tauri dialog unconditionally — `TypeError: Cannot read properties of undefined (reading 'invoke')` at `CoordinateStep.tsx:673`. No `isTauri()` guard, no user-facing error. **`WorkspacesPage.tsx` already does this correctly.** | OPEN |
| D2 | **"Step 4 of 6" vs stepper numbering 1,2,3,4,[gate],6,[gate],8** — numbering counts gates, total doesn't. | OPEN |
| D3 | **Confirm-card toggle named two things**: live card says "Evidence", resolved card says "Scores". `4c0f85e` missed the confirmed-card path. | OPEN |
| D4 | Attached workspace shows folder name (`orca-scratch`) not registered name ("Orca Scratch"). | OPEN |

## E. Process hazards (recurring, worth guarding)

- **A label travels further than its evidence.** Six instances: an illustration hardening into copy; the lead's cost reasoning; "confirmation cards" for a set containing a `tool_use`; "a permission request" for a stomped field; a constant (`SAMPLE_MIN`) used to conclude a code path was dead without reading it; a SHA cited for content it didn't contain.
  → **Guard: trace every label to the field that produces it before it ships.**
- **An enum value read but never written is a predicate that lies to its readers**, and it lies in the safe-looking direction. `'starting'`: read in 17–20 places, written in none.
  → **Guard: a test driving off the contract's own enum options.** Landed in `ca56037`.
- **In a shared worktree, file content answers "what is someone working on", never "what is committed."** Three agents hit this on one file inside an hour.
  → **Guard: `git show --stat <sha>` before citing a commit; check if the file is dirty before claiming what the running daemon does.**
- **`git add` and `git commit` are not atomic across agents.** One commit landed under another agent's message.
  → **Guard: `git add <paths> && git commit --only <paths>`. "no changes added to commit" is an alarm, not a no-op.**
- **An assertion that fires on healthy data is worse than none** — it burns the reader's belief that it means something.
- **Non-random termination contaminates a population** exactly as non-random missingness invalidates a bound. 4 of 5 runs died from infrastructure ⇒ effective n for workflow quality is **1, not 5**.

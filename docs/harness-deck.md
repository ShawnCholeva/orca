# Understanding Coding Harnesses & Loop Development — VP Explainer

*A primer on what a coding harness and loop development are, and why they matter —
and where a harness we'd build sits: **a harness around Claude Code, not around the
raw model.** Threads toward the highest-value application: **modernizing a legacy
system to AI-native.** Not a proposal — no resource ask. Grounded in the "Code as
Agent Harness" research (PEV loop §3.4, governance §3.4.3/§5.2.5, multi-agent
orchestration §4, shared substrate §4.3, learning loop §3.5).*

Paste each slide into Google Slides; the **Speaker notes** belong in the notes
pane. Concrete illustrations use a generic "a harness that…" framing on purpose.

---

## SLIDE 1 — Title

**Coding Harnesses & Loop Development**
*How AI coding becomes a dependable engineering system — the concepts, not a proposal*

**Speaker notes:** Set expectations explicitly: "This isn't a pitch for headcount
or time — it's a 15-minute primer so we share a vocabulary. By the end you'll know
what a 'harness' is, what 'the loop' is, and — importantly — that the harness worth
building sits *around* tools like Claude Code, not around the model." Lowering the
stakes makes a VP more curious and less defensive.

---

## SLIDE 2 — The shift happening right now

- AI coding started as **one-shot generation**: ask → get code → hope
- It moved to **harnessed agents**: plan, edit, run tests, inspect, revise — in a loop (this is what Claude Code *is*)
- The next shift: **orchestrating** those harnesses — many sessions, one goal, governed and coordinated
- The frontier isn't a smarter model, or even a better single agent — it's the **system that coordinates them**

**Speaker notes:** Three eras: one-shot → single-agent harness (Claude Code, Cursor)
→ orchestration *above* the agent. The VP already lives in era two. The takeaway:
*the differentiator keeps moving up the stack — from model, to agent, to the harness
that coordinates agents.* That's where a build at our company would sit.

---

## SLIDE 3 — AI coding without a harness

- Prompt → paste → hope it works
- The model **drifts** on long tasks — loses track of constraints
- "Looks right" ≠ "is right"; problems surface in review or prod
- No memory, no guardrails, no proof

**Speaker notes:** The historical "before." A model *alone* has no mechanism to
catch its own mistakes — that gap is what a harness fills. This is the baseline that
tools like Claude Code already solved; we show it so the *next* layer makes sense.

---

## SLIDE 4 — What is a coding harness?

- The **engineered system around the model** — context, tools, guardrails, and a verify loop
- It makes the model's output **executable, inspectable, and stateful** — operations with checkable outcomes, not just text
- *Claude Code is a harness:* given a task, it plans, edits, runs tests, and only finishes when they pass
- Key point: **a harness is a layer — and layers stack**

**Speaker notes:** Comprehension anchor. Use Claude Code as the concrete example
since they know it — it *is* a harness: the engine (model) wrapped in a car (tools,
loop, permissions). The last bullet sets up the next slide: Claude Code is one
harness layer, and you can build another *around* it. That nesting is the whole
insight for our context.

---

## SLIDE 5 — The layers: harnesses nest

```
┌─────────────────────────────────────────────────────────┐
│  ORCHESTRATION                                           │
│  many sessions · shared context/goal ·                   │
│  autonomy & governance policy · telemetry / learning loop│
├─────────────────────────────────────────────────────────┤
│  CLAUDE CODE  — single-agent harness                     │
│  single-agent PEV loop · tools · per-action permissions  │
├─────────────────────────────────────────────────────────┤
│  MODEL — Claude                                          │
│  judgment · generation                                   │
└─────────────────────────────────────────────────────────┘
```

- The model generates; Claude Code wraps it in a single-agent loop
- The **orchestration layer** sits above — coordinating Claude Code sessions around a long-running goal
- *For example: a harness that fans one goal across three Claude Code sessions, keeps them on shared context, and merges only what passes review*

**Speaker notes:** The slide that makes the talk click — rebuild as a clean stacked
diagram. The message: *harnesses stack — each layer wraps the one below.* It
pre-empts "why not just use Claude Code?" — it's a layer in the stack, and the
orchestration layer adds the coordination, governance, and learning a single session
can't provide. This is the "code as harness" thesis: orchestration code becomes the
harness around the harness.

---

## SLIDE 6 — The harness stack: what's inside one

Slide 5 showed how harnesses *nest*. This is what sits *inside* the orchestration
layer — and most of it is familiar tooling:

- **Context / memory** — repo map, specs, conventions, decisions log → what each session sees
- **Execution substrate** — sandboxed workspaces, isolated from prod
- **Tools** — run code, tests, linters, static analysis → the governed action interface
- **Verification** — deterministic sensors that decide pass/fail → *our CI, our tests*
- **Governance** — permission tiers · human approval gates · audit log
- **Orchestration** — dispatch a goal across sessions, route work, merge results
- **Observability** — deep telemetry threading through all of it → feeds the learning loop

The harness is the **wiring** that turns these into a loop. **Orchestration** and
**governance** are the parts a single session can't provide for itself.

**Speaker notes:** The "tech stack" view of a harness — its building blocks — vs.
slide 5's nesting view. Two messages: (1) **de-mystify** — a harness isn't one
monolith; the research treats orchestration, working state, execution, evaluation,
observability, and governance as distinct, separable layers; (2) **de-risk** — most
of these are familiar tools (CI, linters, sandboxes), and a harness is mostly the
*wiring that turns them into a loop*, with orchestration and governance as the parts
a single session can't provide. The next few slides drill into the three that matter
most — the loop, governance, and guardrails.

---

## SLIDE 7 — The loop: Plan → Execute → Verify

- **Plan** — turn the request into a contract: what changes, what must stay true
- **Execute** — apply it in a sandboxed workspace
- **Verify** — deterministic sensors: compiler, types, lint, tests, static analysis
- The loop stops when checks pass, not when the model feels done
- *Claude Code runs this loop inside one session; an orchestration harness runs a higher-order loop across sessions — dispatch, verify, merge, repeat*

**Speaker notes:** "Loop development." Crux line: *termination is governed by
verification, not the model's confidence* — the research calls the harness a
"cybernetic governor." Important nuance for our framing: the PEV loop exists at
*both* layers. Claude Code loops within a task; our harness loops at the goal level
— fan out work, verify results, integrate what passes, re-dispatch the rest.

---

## SLIDE 8 — Why a raw model isn't enough

| Raw model | Model + harness |
|---|---|
| One-shot guess | Loops until **sensors** pass |
| No memory of constraints | Holds specs & invariants as state |
| Ungoverned access | **Governed interface** — permissions by tool, args, state |
| "Looks right" | Deterministic proof it's right |

- *This is the gap Claude Code already closes for a single session — and the same logic, applied across sessions, is the gap our layer would close*

**Speaker notes:** Explains why this is *engineering*, not prompting — a better model
nudges the left column but never produces the right column. Then the bridge: Claude
Code solved this for one agent; coordinating many agents around a goal re-opens the
same problems (shared state, governed access, verified integration) one layer up.

---

## SLIDE 9 — Governance: sandbox, permissions, human gates

- **Permission tiers**: read-only → sandbox-edit → full-access
- **Mandatory human approval** on the riskiest tier — network, credentials, deploys, destructive ops
- **Executable accountability**: each approval is an auditable record — what, what evidence, who
- *For example: a harness that lets supervised sessions run freely, but routes anything touching prod through one human approval queue across the whole fleet*

**Speaker notes:** The risk-minded VP's slide. Claude Code already prompts
per-action; the orchestration layer adds *policy across sessions* — consistent
autonomy tiers, one audit trail, one approval surface instead of N. Research
(§5.2.5): approvals are durable harness state, not one-off popups — "a safety layer
that filters, vetoes, escalates, and records before anything reaches the real world."

---

## SLIDE 10 — Guardrails: code that looks like ours, and stays in bounds

A harness prevents the two things that scare people about AI at scale:

**Inconsistency** — many agents, many dialects → one shared standard
- *injects the same architecture spec + conventions into every session — five agents, one style*
- *shares the approved-library list — agents reuse the existing client instead of adding a new dependency*
- *hands every session the same decisions log, so none relitigate settled choices*

**Unwanted changes** — going out of bounds or gaming the check → blocked and auditable
- *rejects any session that touched files outside the ticket's scope*
- *blocks "make the test pass by deleting the assertion" — weakened tests are auto-rejected*
- *won't merge edits to migrations, schemas, or the public API without human sign-off*
- *catches a session silencing an error with `@ts-ignore` instead of fixing it*

**Speaker notes:** This answers the skeptical exec's real fear — "won't the AI make
sweeping changes I didn't want, or cheat to make the build pass?" The harness
standardizes what goes *in* (shared context → consistency) and constrains what comes
*out* (scope + verification → no unwanted changes). Both halves are deterministic and
auditable. This is also where the orchestration layer earns its keep: enforcing one
standard across *many* sessions is something a single session can't do for itself.

---

## SLIDE 11 — Why it matters: three payoffs

- 🚀 **Velocity** — many sessions iterate-until-green in parallel; less babysitting and rework
- 💰 **Economics** — leverage per engineer goes up; one person supervises a fleet, not one session
- 🛡️ **Quality & risk** — gated, verified, auditable — fewer regressions reach prod

**Speaker notes:** Inherent benefits of the orchestration layer, framed as "why this
matters," not "give me budget." The economics bullet is the one that lands: the leap
isn't one engineer + one agent, it's one engineer supervising *many* governed agents
around a goal. That's the leverage step-change.

---

## SLIDE 12 — The harness compounds (the learning loop)

- Every session emits **deep telemetry**: cost, tool calls, diffs, test results, rejected paths
- The orchestration layer can see across *all* sessions — where the fleet wastes effort or loops on bad strategies
- The harness tunes itself from its own traces — improving without retraining the model
- *For example: a harness that notices its context step ships 200 files to every session when 3 matter, and tightens the rule fleet-wide so every run gets cheaper*

**Speaker notes:** Strategic punchline (research §3.5). The cross-session vantage is
something no single Claude Code session has — only the layer above can compare runs
and improve the whole system. For a VP: **a compounding capability, not a static
tool** — and the compounding happens at the layer we'd own.

---

## SLIDE 13 — What we'd build: the layer above Claude Code

- **Buy** the model and the single-agent harness — Claude Code, Cursor, agent runtimes are good; use them
- **Build** what they don't provide: orchestration, shared goal/context, autonomy policy, cross-session telemetry
- Staying **model- and agent-agnostic** means we ride their improvements without re-platforming
- The durable advantage is the *harness that knows our repo, our tests, our risk tiers, our goals*

**Speaker notes:** The crux slide for our context. Not a build-vs-buy *decision*
today — it's *understanding where value sits*. Vendors race on the engine and the
single-agent car; the coordination-and-governance layer around them is the part no
vendor ships for *our* codebase and *our* risk posture. That's the differentiated,
retained value — and it survives the next model and the next agent CLI.

---

## SLIDE 14 — Legacy → AI-native: the hardest case is the best fit

Modernizing a legacy system is the canonical job that's *too big for one engineer,
too risky to wing, too repetitive to hand-do* — exactly what an orchestration
harness is for.

**Why it stalls today:** huge scale · thin or no tests · tribal knowledge · fear of silent breakage

**The harness play:**
1. **Pin behavior** — generate characterization tests so "don't change behavior" becomes a *checkable sensor*
2. **Fan out** — one session per module/service; the *same* transformation everywhere
3. **Constrain** — every change must keep tests green and stay in scope; out-of-bounds edits rejected
4. **Learn** — capture the migration recipe from the first conversions, apply it fleet-wide
5. **Govern** — schema, public-API, and security changes gated to a human

- *For example: a harness that moves 40 services off a deprecated framework — writing golden tests first, converting each service in its own session, and merging only the ones that stay behavior-equivalent*

**Speaker notes:** This is the capstone — and likely the closest case to ours. The
key unlock is characterization tests: they turn the scariest constraint ("don't
break anything") into a deterministic sensor the loop can enforce, so agents move
fast without silent regressions. The two guardrails from slide 10 are what make a
40-service migration safe instead of terrifying: *consistency* (same transform
everywhere) and *constraints* (behavior-preserving, in-scope). And the learning loop
means the migration gets cheaper and faster as the recipe sharpens — the first few
conversions teach the harness how to do the rest.

---

## SLIDE 15 — Takeaways

- A **harness** is the engineered system around the model — and **harnesses stack**
- Claude Code is a harness; the one worth building is the **layer above it**
- **Loop development** = Plan → Execute → Verify, stopping only when checks pass — at both layers
- The orchestration layer makes AI coding **fast, safe, and auditable** across many sessions
- It turns legacy modernization from a multi-year slog into a **governed, parallel, verifiable** effort
- And it **compounds** — the system improves as it runs

**Speaker notes:** Recap the ideas you want them to walk out with. No ask. Close:
"That's the vocabulary — and the key point for us: the leverage isn't a better
model, it's the harness we'd build *around* Claude Code. The clearest place to point
it is the legacy modernization we already know we need. When we talk about applying
it here, this is the foundation."

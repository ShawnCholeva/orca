# FUTURE ARCHITECTURE

The **destination** — the end-state every decision is checked against, independent of the order we reach it.

This is the third durable doc, and it answers a different question than the other two:

- **ORCA.md** — the durable *present*: what Orca is, why it's shaped that way, where things live.
- **FUTURE_WORK.md** — the sequenced *path*: substrate-up phases (0→5) of work, with dates and ordering.
- **FUTURE_ARCHITECTURE.md** (this doc) — the *destination*: where the path leads, stated as direction, not schedule.

It is deliberately **two layers**: a **capability north-star** (what Orca becomes) on top, and the **structural spine that must hold** (the load-bearing shape) underneath. When a near-term decision is in tension, ask: *does this move us toward — or at least not preclude — the spine below?* Sequencing lives in FUTURE_WORK; this doc states the shape we're steering into.

**The codebase is still the source of truth for the present.** This doc describes a future that does not yet exist; it informs direction. Where it and the code disagree about *today*, the code wins.

---

## The destination, in one line

Orca becomes a **hostable, multi-tenant, *learning* agent-orchestration platform** with a thin-client ecosystem and subscription tiers — **without abandoning** the local-first, subscription-billed, hooks-first model it is built on today.

The free tier is still someone's laptop running their own agents against their own subscription. The paid tiers add hosted orchestration, teams, and a learning loop. One codebase reaches both.

---

## Layer 1 — Structural spine (the load-bearing shape)

These are the seams that must hold. Everything in Layer 2 is built on them.

### 1. The daemon graduates into a standalone server in its own repo

The orchestration runtime stops being a managed child of the desktop app and becomes an **independently-deployable server with its own repository**. Its **HTTP/WS API plus the shared `contracts` package become the product's public spine** — versioned and stable, treated as an external contract rather than an internal convenience.

Consequence: the API is the product. Clients come and go; the contract is forever (or at least versioned forever).

### 2. Control-plane / execution-plane split (the keystone)

The single decision the rest of the architecture hangs from. The system has two halves with very different gravity:

- **Server (control plane)** — goals, workflows, memory, decisions, the append-only event spine, the API, tenancy, billing. **Portable**: hostable on a laptop *or* as multi-tenant cloud. It **never holds the user's subscription token or their source code.**
- **Runner (execution plane)** — owns PTYs, shadow sessions, the **interactive subscription**, and the **local git repos**. **Gravitationally bound** to wherever the code and credentials physically live. It connects **outbound** to the server (NAT/firewall-friendly, no inbound ports), receives step-dispatch intents, and streams back hook events + output.

The **Runner Protocol is a first-class contract**, a peer to the HTTP API — it is the in-process "spawn session → register hook → stream output" dance promoted to a network boundary.

Why this and not "run everything in the cloud":

- **Subscription billing.** Shadow sessions exist precisely because interactive sessions bill the user's Claude/Codex subscription, not the API budget. Cloud execution can't use the interactive login → forces API keys → 5–10× cost → the free tier's economics collapse.
- **Source egress.** Cloud execution means cloning user repos server-side. Enterprise security will not let source + secrets + uncommitted state leave the machine.
- **Local truth.** Agents test against local toolchains, running services, and uncommitted changes.

**Runner placement is policy, not a fork.** Default = **local** (preserves billing + source locality + the free tier). A **cloud runner is additive** — "just a runner in a sandbox with cloud creds" — so per-Goal placement (local vs cloud) becomes configuration, decided later, without redesign.

**The seam already exists in the code.** In the current daemon map (ORCA §4), `sessions/`, `pty/`, `tmux/`, `adapters/`, and `shadow-hooks/` *are* the execution plane; everything else is control plane. Reaching the destination is extracting an existing in-process boundary into a network one — not a rewrite.

### 3. Clients are interchangeable and thin

The Tauri desktop app becomes **one** client among peers: a **web client**, a **CLI**, and **programmatic / agent** consumers all sit on the same API. **No orchestration logic lives in any client** — a client renders projections and sends commands. Terminal streaming flows **runner → server → client** as WS relay.

This is the literal payoff of the split: goal creation and workflow execution become reachable "via HTTP, agents, desktop, web, or whatever it is."

### 4. Local-first becomes a deployment mode, not a law

One server codebase, **config-switched**, never two products:

- **Single-tenant local** — SQLite, the user's machine, the free tier. Local-first survives here intact.
- **Multi-tenant hosted** — Postgres, auth, the paid tiers.

This lives behind the **storage-provider seam** already reserved in ORCA §8. Domain logic stays storage-agnostic; the local↔hosted difference is configuration, not divergent builds.

### 5. Tenancy — the GitHub model: `owner = User | Org`

- **Root identity is always the User.** A free user has a **personal account** and owns their Goals/workspaces/memory **directly — no org required.** The free tier is genuinely org-free.
- **An Org is a first-class *paid* tenant** (team / enterprise): members, roles, seats, billing. Goals can be owned by — or transferred/shared into — an Org.
- **Ownership is polymorphic** — every Goal, workspace, and memory item is owned by a **User or an Org**, exactly as a GitHub repo is.
- **Identity & entitlements are explicit seams:** a local token for single-tenant; OIDC/SSO for enterprise; and a **tier/entitlement layer** that gates seats, cloud runners, marketplace publishing, and the learning features.

---

## Layer 2 — Capability north-star (what Orca becomes)

Four things that are deliberate **non-goals today** (ORCA §13 / FUTURE_WORK Appendix A) become deliberate **destinations**. A hosted, multi-tenant server that retains outcome data is what makes them tractable — and safe, because each is **walled at the owner boundary** (per-User for personal Goals, per-Org for org Goals).

- **Cross-goal memory.** Memory pools across Goals within a single owner; patterns, constraints, and decisions learned in one Goal inform others. (Today: deliberately Goal-scoped only.)
- **Experiential learning loop.** The system measurably improves over time — recommendation feedback, step-quality signals, and harness telemetry (already *captured* by the Inspectable axis) feed back into better orchestration. **Partially realized (Phase 5B, 2026-06-30):** a per-template propose-and-confirm reflective optimizer is live and control-plane-pure (the falsifier is the forward version-comparison projection; no execution-plane access). Owner-scoping of proposals is the additive tenancy step. **The Inspectable axis gained a refute telemetry channel (5.4, 2026-07-04):** an independent, adversarial second-model verdict (`upheld`/`refuted`/`uncertain`/`unavailable`) on self-reported step scoring, recorded as an inspectable `RefuteFacet` on the `step_complete` `HarnessTransition` — control-plane-pure (the refute call rides the existing `ShadowAsk` seam, no execution-plane access) and comparable across runs, providing the independently-verified ground truth the learning loop needs. **The evaluate stage is now realized (2026-07-04):** a pre-promotion counterfactual judge over persisted past outputs, independent and adversarial, bucketed by `RefuteFacet`/`EvidenceFacet` verdicts, returning a calibrated `CounterfactualJudgment` that informs (never gates) the governed promotion — control-plane-pure via the `ShadowAsk` seam, imagined execution (real replay-re-run remains the deferred execution-plane step).
- **Evolution Agent.** An agent that proposes changes to workflows, templates, and prompts from outcome data — the harness tunes itself, **under human approval**. **Partially realized (Phase 5B):** the propose-and-confirm per-template variant has landed (see above); autonomous self-modification remains a non-goal.
- **Plugin / template marketplace.** The frozen internal registry (ORCA §9) opens into an external, dynamically-loaded ecosystem others publish into. The extension *interface* is already first-party-only-but-stable by design, so this is opening a door that was built to open. **Composition is the enabling seam (Phase 5E, landed).** A `delegate` node runs a child of another independently-versioned template, and the child's **typed template interface** — declared `inputs` mapped in via `reads`, terminal `outputSchema` mapped back via `writes` — is exactly the *composable, versioned unit* a marketplace assembles: published templates compose by contract, not by copy-paste. It stays on-worldview because spawn/join is **control-plane** `DispatchEngine` logic and child steps ride the existing `RunnerPort` **runner-agnostically** (no execution-plane code), and the version pin keeps a composition reproducible/replayable. **Owner-scoping child-template resolution is the additive tenancy step** — the same walled boundary the other destinations use.

The throughline: Orca's end-state is a **learning** orchestration platform, not merely a hosted one. The harness telemetry it already emits is the training signal.

---

## Invariants — what does NOT relax at the destination

These are *why* the system can scale safely. The destination strengthens them rather than trading them away.

- **Deterministic core, selective AI** — the cost spine. The LLM is invoked only where judgment is needed; deterministic code owns lifecycle, routing, gates.
- **Hooks / events over stdout scraping** — a hard rule. Agent-native hooks are first-class orchestration inputs; the Runner Protocol carries hook events, it does not scrape panes.
- **The harness axes — Executable / Governed / Stateful / Inspectable** — remain the safety + autonomy spine. **L4 (Supervised) → L5 (Autonomous)** stays the autonomy ladder, now enforceable **server-side** for scheduled and autonomous runs (the laptop need not be open).
- **Append-only event spine + projections** — reconstruct history by replaying events; clients read projections.
- **Human-authoritative completion** — the orchestrator recommends; the human decides a Goal is done.

---

## Remaining non-goals (even at the destination)

- **Cross-*owner* memory / learning** — the learning loops stop at the User/Org wall. Contextual integrity and trust over breadth.
- **Custom model hosting**, a **generic chatbot UI**, an **IDE / VS Code replacement** — still out, as today.

---

## Migration narrative (pointer, not schedule)

How today's fused, single-tenant, laptop-bound daemon becomes the destination is a **seam-extraction story**, in roughly this dependency order:

1. **Extract the execution plane** behind the Runner Protocol — the in-process `sessions/ pty/ tmux/ adapters/ shadow-hooks/` boundary becomes a network one; the local runner is the first runner.
2. **Activate the storage-provider seam** — SQLite (local) ⟷ Postgres (hosted) behind one interface.
3. **Add multi-tenancy & identity** — the polymorphic `owner = User | Org`, auth, roles.
4. **Add the entitlement layer** — tiers gate seats, cloud runners, marketplace, learning.
5. **Build the four learning capabilities** on the retained outcome data.

Each step is additive against a seam that already exists or is already reserved. **Sequencing, dates, and the substrate work that must land first live in FUTURE_WORK.md** — this doc only states where the steps lead.

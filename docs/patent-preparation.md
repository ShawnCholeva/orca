# Patent Preparation Brief: Replay-Safe Adaptive Agent Workflow Control

**Date:** 2026-06-15
**Status:** Internal preparation brief; not a patent application or legal opinion
**Repository visibility:** Confirmed private on 2026-06-15

## Purpose

This document prepares Orca's workflow-completion and AI Performance Metrics
(`AIPM`) work for technical validation and review by qualified patent counsel.
It deliberately does not assume that the broad product idea is patentable.

The broad concepts of multi-agent orchestration, evaluator-directed revision,
structured model output, performance scoring, learned model routing, and shadow
deployment all have substantial prior art. The candidate invention should
therefore be evaluated as a narrower ordered combination that addresses a
specific technical problem:

> Preserving deterministic, reproducible workflow state while adapting the
> control policies of workflows whose workers and evaluators are probabilistic.

## Executive Assessment

Do not pursue claims directed merely to:

- an agent producing output that another model evaluates;
- schema validation followed by approval or revision;
- a bounded generator-reviewer conversation;
- scoring AI agents or models;
- selecting models based on historical performance;
- shadow-testing a candidate model or policy;
- using human feedback to improve an AI workflow; or
- a generic self-learning workflow.

Those features are individually crowded and would likely face novelty,
obviousness, or subject-matter eligibility challenges.

The potentially defensible candidate is a **replay-safe adaptive control plane**
with the following ordered behavior:

1. Resolve and bind an immutable control-policy snapshot to each workflow
   attempt before probabilistic work begins.
2. Treat worker output as an untrusted structured completion proposal.
3. Apply deterministic structural and objective validation before requesting a
   probabilistic completion judgment.
4. Restrict the evaluator to proposing controller-defined outcomes; only the
   deterministic controller may mutate durable workflow state.
5. Persist the attempt, evidence, judgment, transition, and policy identity in a
   replayable history.
6. Attribute delayed downstream outcomes to the exact attempt and policy
   snapshot that produced them.
7. Prevent evaluator-generated scores from becoming adaptation truth without
   independent corroborating evidence.
8. Express adaptations as validated deltas in a constrained policy language,
   rather than arbitrary generated prompts or executable code.
9. Counterfactually evaluate candidate deltas against recorded histories and
   shadow executions.
10. Activate a validated candidate atomically for future attempts without
    changing the policy identity or outcome of in-progress or historical
    attempts.
11. Reproduce historical decisions from their original policy snapshots and
    automatically roll back a promoted policy when attributable outcomes cross
    a regression boundary.

This candidate remains unproven until the algorithms, invariants, implementation,
and comparative technical results described below exist.

## Existing Orca Foundation

Orca already implements or specifies several relevant mechanisms:

- structured workflow-step completion output;
- schema validation of step output;
- independent orchestrator approval and scoring;
- bounded revision;
- deterministic workflow transition ownership;
- persisted step-result facts and evaluation status;
- supervised completion checkpoints;
- canonical capture of revision-after-approval divergence;
- append-only domain events and replayable Goal history; and
- model and agent selection through workflow templates.

Relevant internal documents include:

- `docs/superpowers/specs/2026-06-03-workflow-step-result-design.md`
- `docs/superpowers/specs/2026-06-08-step-result-scoring-and-activity-visibility-design.md`
- `docs/superpowers/specs/2026-06-11-supervised-step-completion-checkpoints-design.md`
- `docs/superpowers/specs/2026-06-12-feature-development-workflow-design.md`

These materials establish useful conception and implementation history. They do
not by themselves establish patentability.

## Technical Problem

Probabilistic workflow participants create several computer-control problems:

1. The same input can produce different worker output or evaluator judgment.
2. A policy update can make historical behavior impossible to reproduce.
3. Delayed defects or downstream validation results can be attributed to the
   wrong worker, model, workflow configuration, or policy version.
4. An evaluator can create a self-reinforcing feedback loop by scoring output
   and then using its own score as the basis for changing future evaluation.
5. Unrestricted model-generated policy changes can mutate prompts, routing, or
   transition criteria outside deterministic safety bounds.
6. Updating policy during an active attempt can make the attempt internally
   inconsistent.
7. Aggregate improvement can hide regressions in safety-critical dimensions or
   specific workflow classes.
8. A restart, replay, or audit can produce a state different from the state
   originally reached.

The candidate invention should be framed around controlling these failure modes,
not around automating project management or making an AI "learn."

## Proposed System Boundaries

### Worker

The worker performs a step and submits:

- a structured completion proposal;
- artifacts;
- assumptions and warnings;
- validation evidence; and
- references to measurable execution facts.

The worker cannot score itself, approve itself, select a state transition, or
modify an active policy.

### Deterministic Validator

The validator checks:

- output-schema conformance;
- required artifacts and evidence;
- hard constraints and guardrails;
- objective measurements available to the daemon; and
- whether the proposal refers to valid workflow and ledger state.

Validation failure produces a controller-defined revision or failure path. It
does not permit a state transition based solely on model interpretation.

### Independent Evaluator

The evaluator receives validated output and evidence. It may propose:

- approval;
- revision with bounded feedback;
- quality dimensions;
- confidence;
- risk;
- handoff readiness; and
- a rationale.

The evaluator cannot write durable state, execute arbitrary transitions, change
the policy, or make its score authoritative adaptation evidence.

### Workflow Controller

The controller:

- owns the state machine;
- enforces revision and retry limits;
- validates evaluator proposals;
- selects only authored transitions;
- records the policy snapshot used by the attempt;
- persists the complete decision record; and
- applies state mutations atomically.

### AIPM Policy Engine

The AIPM engine:

- gathers attributable outcome evidence;
- calculates evidence confidence and conflicts;
- proposes constrained policy deltas;
- performs counterfactual and shadow evaluation;
- classifies policy-change risk;
- requests authorization when required;
- activates policy versions only at attempt boundaries; and
- monitors promoted versions for rollback conditions.

## Required Invariants

The implementation and tests should enforce these invariants:

1. **Single transition authority:** no model directly mutates workflow state.
2. **Policy immutability per attempt:** an attempt retains one resolved policy
   identity from start through terminalization.
3. **Historical reproducibility:** replay uses the recorded policy snapshot and
   recorded model proposals; it does not call a current model to reconstruct a
   past decision.
4. **Evidence provenance:** every adaptation signal identifies its source,
   collection time, related attempt, and policy version.
5. **No self-score training:** evaluator scores alone cannot authorize a policy
   update or satisfy the minimum evidence requirement.
6. **Constrained adaptation:** a candidate policy can change only fields allowed
   by the policy-delta schema and within controller-defined bounds.
7. **Future-only activation:** promotion does not change active or historical
   attempts.
8. **Atomic promotion:** readers resolve either the complete parent policy or
   the complete promoted policy, never a partial mixture.
9. **Deterministic rollback:** a promoted version has an identified parent or
   rollback target and explicit regression conditions.
10. **Honest evaluation failure:** missing or failed evaluation remains distinct
    from a measured score of zero.

## Policy Snapshot

A resolved policy snapshot should be content-addressed or otherwise immutable
and should include:

- policy identifier and version;
- parent identifiers;
- resolution scope;
- workflow and step applicability;
- worker and model selection rules;
- metric definitions and weights;
- required evidence;
- approval and revision thresholds;
- revision and retry limits;
- permitted transition ports;
- confidence and sample requirements;
- risk classification rules;
- promotion and rollback rules; and
- a canonical serialization hash.

Policy resolution may use:

```text
global baseline -> workflow-type policy -> Goal-specific override
```

The resolved result, not merely the three source identifiers, must be bound to
the attempt. This prevents later edits to a parent policy from changing the
meaning of a historical attempt.

## Performance Evidence

Each attempt should produce an immutable performance record containing:

- Goal, workflow, node, step type, and attempt identifiers;
- worker, evaluator, model, and execution-mode identifiers;
- resolved policy identifier and hash;
- input and output contract versions;
- objective validation results;
- artifact and ledger references;
- duration, retries, turns, tool calls, and resource use when reliably measured;
- downstream validation, defect, rollback, or repair outcomes;
- human approve, refine, reject, or override actions;
- independent evaluator dimensions, confidence, risk, and rationale;
- timestamps and source provenance; and
- redaction and integrity metadata.

### Evidence Authority

Evidence should be classified rather than flattened immediately into one score:

1. **Objective evidence:** deterministic tests, schema checks, observed defects,
   resource measurements, downstream failures, and durable state outcomes.
2. **Human evidence:** acceptance, revision, override, rejection, and categorized
   feedback.
3. **Evaluator evidence:** subjective quality dimensions, confidence, risk, and
   rationale from a model that did not perform the work.

Objective evidence should normally receive the highest authority. Human evidence
calibrates task intent. Evaluator evidence supplements judgment but cannot alone
create adaptation truth.

Missing evidence should lower confidence. Conflicting evidence should remain
represented as a conflict rather than being silently averaged away.

## Evidence Attribution Algorithm

Before filing, the system needs a specific, implementable attribution algorithm.
At minimum, it should:

1. Link an immediate signal directly to its attempt and policy snapshot.
2. Link a delayed signal through durable artifact, ledger, validation-run, or
   descendant-step relationships.
3. Assign an attribution confidence based on relationship strength, elapsed
   time, intervening policy changes, and competing causal candidates.
4. Preserve all contributing source references.
5. Reject or quarantine signals below a minimum attribution confidence.
6. Prevent one delayed event from being counted repeatedly through multiple
   relationship paths.
7. Distinguish correlation from controller-confirmed causation.

The disclosure should include pseudocode, data structures, conflict examples,
and at least one complete delayed-defect attribution example.

## Constrained Policy-Delta Language

A candidate update should not contain arbitrary executable code or unrestricted
natural-language instructions. It should use a strict schema such as:

```ts
type PolicyDelta =
  | { kind: "adjust_metric_weight"; metricId: string; from: number; to: number }
  | { kind: "adjust_threshold"; thresholdId: string; from: number; to: number }
  | { kind: "reorder_model_preference"; stepType: string; orderedModelIds: string[] }
  | { kind: "adjust_revision_limit"; stepType: string; from: number; to: number }
  | { kind: "change_route_preference"; gateId: string; evidenceClass: string; port: string };
```

The actual grammar must define:

- valid operations;
- field types and ranges;
- maximum change magnitude;
- mutually exclusive operations;
- required evidence classes;
- minimum sample size and confidence;
- risk classification;
- authorization requirements; and
- deterministic application and rejection behavior.

A model may recommend a delta, but deterministic code must parse, validate,
classify, and apply it.

## Counterfactual Replay

Counterfactual replay should compare a candidate policy with its parent without
rewriting historical truth.

For a recorded attempt, the replay system should:

1. Load the immutable historical inputs, evidence, proposals, and parent policy.
2. Apply the candidate policy only to decisions that can be evaluated from
   recorded evidence.
3. Mark decisions requiring unavailable counterfactual model output as
   unevaluable rather than inventing results.
4. Compare candidate and parent decisions across primary outcomes, safety
   dimensions, cost, and latency.
5. Group results by workflow type, step type, risk class, model, and evidence
   confidence.
6. Prevent promotion when the evaluable sample is too small or unrepresentative.

Historical replay and live shadow execution are separate evidence sources.
Replay measures policy behavior on fixed records. Shadow execution measures
behavior under current inputs without controlling live workflow state.

## Promotion And Rollback

### Low-Risk Changes

Small metric-weight changes may be eligible for automatic promotion only when:

- the delta remains within a fixed magnitude;
- required evidence classes are represented;
- minimum sample and confidence thresholds are satisfied;
- the candidate improves the declared primary metric;
- no protected dimension crosses a regression tolerance; and
- replay and shadow results agree within a configured bound.

### High-Impact Changes

Changes to model selection, routing, approval thresholds, or revision limits
should require explicit human authorization after validation.

### Activation

Promotion should:

- create a new immutable version;
- identify its parent and evidence set;
- occur atomically;
- affect only attempts started after activation; and
- emit an auditable event containing the authorization basis.

### Rollback

Rollback should occur when attributable post-promotion evidence satisfies a
versioned regression rule. Rollback must:

- activate a known prior version atomically;
- preserve the promoted version and its evidence for audit;
- avoid changing active attempts;
- emit a reasoned rollback event; and
- prevent automatic re-promotion until new evidence or authorization exists.

## Threat And Failure Model

Validation should cover:

- a worker manipulating its own evidence;
- an evaluator favoring output from the same model family;
- prompt injection inside worker artifacts;
- duplicate or replayed feedback events;
- one user or workflow dominating global policy;
- delayed evidence attached to the wrong attempt;
- sparse evidence producing an exaggerated policy change;
- aggregate improvement hiding a safety regression;
- candidate-policy evaluation using leaked future outcomes;
- policy changes during active execution;
- restart between promotion decision and activation;
- rollback loops; and
- historical replay invoking current probabilistic services.

## Candidate Claim Families For Counsel

These are technical themes, not proposed legal claims.

### Claim Family A: Replay-Safe Completion Controller

Potential focus:

- immutable policy binding before probabilistic execution;
- structured completion proposal;
- deterministic validation;
- independent probabilistic judgment;
- controller-exclusive state transition;
- persisted decision envelope; and
- replay without re-invoking probabilistic participants.

### Claim Family B: Attributable Multi-Source Performance Evidence

Potential focus:

- joining immediate and delayed outcomes to an attempt and policy snapshot;
- authority classes for objective, human, and evaluator evidence;
- conflict and confidence preservation;
- anti-duplication rules; and
- exclusion of uncorroborated self-generated evaluation from adaptation truth.

### Claim Family C: Constrained Adaptive Policy Control

Potential focus:

- generation of a typed policy delta;
- deterministic safety validation;
- risk classification;
- counterfactual replay and shadow comparison;
- future-only atomic activation; and
- version-targeted rollback.

### Claim Family D: Combined Closed Loop

Potential focus:

```text
immutable policy snapshot
-> probabilistic work proposal
-> deterministic validation
-> independent judgment
-> controller-owned transition
-> attributable downstream evidence
-> constrained policy delta
-> counterfactual and shadow validation
-> future-only activation or rollback
```

Counsel should evaluate whether this ordered combination produces a
non-predictable technical result beyond the established functions of its known
parts.

## Prior-Art Pressure

The following references should be supplied to counsel at the beginning, not
discovered after drafting:

| Area | Reference | Relevance |
|---|---|---|
| Iterative feedback and revision | [Self-Refine (2023)](https://arxiv.org/abs/2303.17651) | Generator feedback and iterative refinement |
| Language-agent learning from feedback | [Reflexion (2023)](https://arxiv.org/abs/2303.11366) | External/internal feedback retained for later attempts |
| LLM evaluator | [Judging LLM-as-a-Judge (2023)](https://arxiv.org/abs/2306.05685) | Model-based quality evaluation and known evaluator biases |
| Metric-optimized LM pipelines | [DSPy (2023)](https://arxiv.org/abs/2310.03714) | Pipeline optimization against declared metrics |
| Cost/performance model selection | [FrugalGPT (2023)](https://arxiv.org/abs/2305.05176) | Learned model cascades |
| Preference-trained routing | [RouteLLM (2024)](https://arxiv.org/abs/2406.18665) | Learned routing between models |
| Automated agent design | [Automated Design of Agentic Systems (2024)](https://arxiv.org/abs/2408.08435) | Performance-driven search over agent designs |
| Automated workflow generation | [AFlow (2024)](https://arxiv.org/abs/2410.10762) | Execution-feedback optimization of agent workflows |
| Multi-agent review loop | [US20250356313A1](https://patents.google.com/patent/US20250356313A1/en) | Execution agent, review agent, validation criteria, revision dialogue, bounded turns |
| Shadow model evaluation and routing | [US11257002B2](https://patents.google.com/patent/US11257002B2/en) | Ground truth, user feedback, performance metrics, shadow operation, model-selector updates |
| AI self-improvement | [US12210849B1](https://patents.google.com/patent/US12210849B1/en) | Evaluation, weighted analysis, logs, and self-improvement |
| Self-learning workflow automation | [US10839404B2](https://patents.google.com/patent/US10839404B2/en) | Validation, review, analytics, performance targets, and learned automation |
| Event-sourced agent execution | [ESAA (2026)](https://arxiv.org/abs/2602.23193) | Validated intentions, deterministic state mutation, append-only events, replay verification |

This list is preliminary and incomplete. Patent counsel should search patent
families, prosecution histories, citations, non-patent literature, products,
open-source repositories, and unpublished applications that become visible
later.

## Patentability Risks

### Novelty

A broad hybrid-completion claim is unlikely to be novel in view of the Microsoft
reference and earlier generator-reviewer work. Broad adaptive scoring and routing
claims are unlikely to be novel in view of Amazon and established MLOps systems.

The search must determine whether one reference discloses every element of a
narrow proposed claim.

### Obviousness

The largest risk is that an examiner combines:

- a generator-reviewer workflow;
- deterministic schema validation;
- event-sourced state control;
- multi-source performance measurement;
- shadow evaluation; and
- adaptive model or policy routing.

The technical case must show more than the predictable use of these elements
according to their established functions. Useful evidence may include a failure
mode the art did not recognize, an unconventional control relationship, or
measured results that would not have been expected from the combination.

### Subject-Matter Eligibility

"Scoring work and improving a policy" can be characterized as an abstract
evaluation or management process performed on generic computers.

The specification and claims should instead describe a particular technical
solution to nondeterministic state control, including:

- concrete data structures;
- binding and hashing behavior;
- transition constraints;
- replay semantics;
- atomic activation boundaries;
- evidence-integrity rules; and
- measured improvements in reproducibility, invalid-transition prevention, or
  feedback-loop resistance.

### Enablement And Written Description

A high-level block diagram is not enough. Before filing, the disclosure should
teach a skilled engineer how to implement the claimed scope without an
unreasonable research program.

The filing package should contain:

- schemas and canonical serialization;
- algorithms or pseudocode;
- policy-resolution examples;
- attribution examples;
- replay behavior;
- conflict calculations;
- promotion and rollback logic;
- failure handling;
- alternative embodiments; and
- working experimental results.

### Freedom To Operate

Patentability and freedom to operate are separate. Counsel should independently
review active claims, including the Amazon model-deployment family, against the
planned product implementation.

## Prototype Requirements

Build one narrow end-to-end prototype before deciding to file:

```text
resolve immutable policy
-> start bound attempt
-> receive structured worker proposal
-> deterministically validate
-> obtain independent judgment
-> commit controller-owned transition
-> record delayed downstream evidence
-> attribute evidence to attempt and policy
-> propose constrained delta
-> replay and shadow-test candidate
-> authorize and activate, reject, or roll back
```

The prototype must demonstrate:

- identical replayed state from the same event history;
- historical behavior remaining unchanged after policy promotion;
- failed or missing evaluator output not becoming a false score;
- evaluator scores being insufficient to promote a policy alone;
- conflicting or poisoned evidence blocking promotion;
- delayed evidence attaching to the intended attempt exactly once;
- invalid deltas being deterministically rejected;
- high-impact changes requiring authorization;
- active attempts retaining their original policy; and
- deterministic rollback after an attributable regression.

## Comparative Evaluation

Compare the prototype with a conventional generator-evaluator workflow that has
no policy snapshots, evidence provenance, or replay-safe activation.

Measure:

- invalid durable transitions;
- premature approvals;
- replay divergence after policy updates;
- misattributed delayed outcomes;
- policy promotions caused by evaluator-only evidence;
- successful feedback-poisoning attempts;
- downstream defect and repair rates;
- time and resource overhead;
- rollback detection and recovery time; and
- improvement consistency across workflow and risk classes.

Record the experimental protocol, datasets, random seeds where applicable,
software and model versions, raw outcomes, exclusions, and negative results.

## Inventorship Record

For each potentially claimed mechanism, record:

- the human who conceived it;
- the conception date;
- the problem being solved;
- the concrete mechanism conceived;
- supporting notes, commits, diagrams, or messages;
- contributions from other humans; and
- how AI tools were used.

Do not name an AI system as an inventor. Human inventorship must be analyzed
claim by claim by counsel.

## Disclosure Record

Maintain a dated record of:

- public repositories;
- public or recorded demonstrations;
- conference or customer presentations;
- social-media posts;
- sales or offers for sale;
- external builds;
- accelerator or investor materials;
- contractors and collaborators;
- confidentiality agreements; and
- documents shared without confidentiality restrictions.

As of 2026-06-15, the GitHub repository was confirmed private. Reconfirm before
relying on that statement.

Avoid publishing enabling details of the candidate mechanism before counsel
advises on filing. U.S. grace-period rules do not preserve all foreign rights.

## Package For Patent Counsel

Provide counsel:

1. This brief.
2. A concise product and architecture overview.
3. Dated source-control history for each mechanism.
4. The prototype source and tests.
5. Architecture, sequence, state-machine, and data-model diagrams.
6. The complete prior-art table and claim-element comparison.
7. Comparative experiment design and results.
8. Inventorship records.
9. Disclosure records.
10. Product roadmap and likely design alternatives.

Ask counsel to perform:

- a patentability search;
- a claim-element and obviousness analysis;
- a subject-matter eligibility assessment;
- an inventorship review;
- a foreign-filing and disclosure-deadline review;
- a freedom-to-operate analysis; and
- a recommendation on provisional, nonprovisional, continuation, and trade-secret
  strategy.

## Filing Decision Gate

Proceed toward a detailed filing only when all are true:

- the attribution and policy-delta mechanisms are concretely specified;
- the replay and activation invariants are implemented;
- at least one useful ordered combination is not found in the search;
- comparative evidence shows a technical improvement;
- the useful scope is not trivially designed around;
- the disclosure enables the intended claim breadth;
- human inventorship is documented;
- known disclosures and deadlines are understood; and
- counsel believes expected protection justifies filing and prosecution cost.

If these conditions are not met, preserve the valuable implementation as a trade
secret where practical and reconsider filing after further technical development.

## Immediate Work Sequence

1. Finalize the evidence-attribution algorithm.
2. Finalize the constrained policy-delta grammar.
3. Specify replay, promotion, and rollback semantics as executable invariants.
4. Implement the narrow prototype.
5. Build adversarial and comparative tests.
6. Record measurable results.
7. Update the prior-art claim chart.
8. Assemble inventorship and disclosure records.
9. Obtain patentability and freedom-to-operate opinions from counsel.
10. Make a filing or trade-secret decision based on the resulting evidence.

## Legal And Examination References

- [USPTO MPEP § 2106: Patent Subject Matter Eligibility](https://www.uspto.gov/web/offices/pac/mpep/s2106.html)
- [USPTO 2025 memorandum on software and AI eligibility](https://www.uspto.gov/sites/default/files/documents/memo-101-20250804.pdf)
- [USPTO MPEP § 2141: Obviousness](https://www.uspto.gov/web/offices/pac/mpep/s2141.html)
- [USPTO MPEP § 2164: Enablement](https://www.uspto.gov/web/offices/pac/mpep/s2164.html)
- [USPTO provisional application guidance](https://www.uspto.gov/patents/basics/apply/provisional-application)

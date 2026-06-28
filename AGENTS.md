# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## What Is Orca

Orca is a **local-first desktop application for multi-agent AI orchestration**. It coordinates multiple AI agent sessions (Claude Code, opencode, Codex, shell) around long-running engineering Goals by preserving operational reasoning, managing shared context, and enabling progression from supervised to autonomous execution (Levels 4 and 5).

## Orientation docs (consult to stay aligned)

Three durable docs sit at the repo root. Read the relevant one **before non-trivial work** so changes align with how Orca actually works and where it's headed:

- **ORCA.md** — the durable **present**: what Orca is, why it's shaped this way, and where things live (the daemon subsystem map, the workflow model, the harness axes). **Consult before touching any subsystem** to match existing patterns and intent. When the code and ORCA.md disagree about *today*, the code wins — fix ORCA.md.
- **FUTURE_ARCHITECTURE.md** — the **destination**: the end-state Orca steers toward (daemon as a standalone server, the control-plane/execution-plane split + Runner Protocol, multi-tenant SaaS tiers, the learning loop). **Consult before any architectural or design decision** — new seams, abstractions, storage/identity choices, or cross-subsystem changes — to confirm the work moves toward, or at least does not preclude, the end-state spine. Flag in your response when a proposed change conflicts with it.
- **FUTURE_WORK.md** — the sequenced **path** (substrate-up phases 0→5). Consult to see whether a task is already planned and where it fits.

Rule of thumb: ORCA.md answers *"how does this work today?"*; FUTURE_ARCHITECTURE.md answers *"is this the right direction?"*; FUTURE_WORK.md answers *"when/where does this land?"*.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## Shadow session interactions

Below you will find relevant files based on the provider building on in Orca.

- Always prefer to utilize hooks instead of parsing the shadow workers/sessions

### Claude

Hooks: https://code.claude.com/docs/en/hooks

### Codex

Hooks: https://developers.openai.com/codex/hooks

## Debugging daemon

There is a live daemon running in a tmux session named daemon-terminal if you need to interact with the logs directly

## Context Assembly (Token Efficiency)

Context injected into agent sessions is assembled selectively:
- **Always included:** objective, current task, role, hard constraints, confirmed decisions, success criteria
- **Conditionally included:** sibling session summaries, architecture notes, risks, open questions
- **Always excluded:** stale logs, irrelevant discussion, raw transcripts

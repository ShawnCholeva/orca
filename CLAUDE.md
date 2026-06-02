# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is Orca

Orca is a **local-first desktop application for multi-agent AI orchestration**. It coordinates multiple AI agent sessions (Claude Code, opencode, Codex, shell) around long-running engineering Goals by preserving operational reasoning, managing shared context, and enabling supervised progression through five autonomy levels.

**Current status:** Pre-implementation — comprehensive specifications exist in `docs/` but no code has been written yet.

**Stack:** Tauri v2 desktop shell (React/TypeScript), Node.js orchestrator daemon (TypeScript), SQLite (MVP storage), node-pty (agent session management).

## Specification Documents

Before implementing anything, read the relevant spec:

- `docs/PRODUCT.md` — Vision, core concepts, user-facing features
- `docs/MVP.md` — Detailed MVP specification for Levels 1–3 (~1,100 lines)
- `docs/TECHNICAL.md` — Full technical design and architecture (~1,770 lines)

## Core Domain Model

```
Goal            — the unit of work; all memory and sessions are Goal-scoped
Workspace       — a repo/folder attached to a Goal (many per Goal)
Workflow        - instructions that guide the orchestration of the goal
Step            — a decomposed unit of work within a workflow
MemoryItem      — extracted reasoning: decision | assumption | constraint | risk |
                  blocker | architecture_note | session_summary | validation_result | open_question
Recommendation  — orchestrator suggestion: next_session | review | validation | etc.
```

Memory lifecycle: `observed → extracted → promoted → canonical`

## Architecture Overview

```
Tauri v2 Desktop (React/TypeScript)
    ↓ IPC
Node.js Orchestrator Daemon (TypeScript)
    ├── Plugin Runtime        (AgentAdapter, WorkflowProvider, SkillProvider, etc.)
    ├── Event Store           (append-only, SQLite projections)
    ├── Session Manager       (PTY via node-pty)
    ├── Memory Engine         (extraction, promotion, canonical store)
    ├── Context Assembly      (selective, token-efficient injection)
    ├── Orchestrator Engine   (rule-based triggers → selective AI reasoning)
    └── Recommendation Engine
    ↓
Agent Adapters
    ├── Claude Code Adapter
    ├── opencode Adapter
    ├── Codex Adapter
    └── Shell/Manual Adapter
```

**Key design principles:**
- **Plugin-first:** All first-party features implement the same interfaces as external plugins
- **Event-driven:** Append-only event store; state derived from projections
- **Deterministic core:** Lifecycle managed by cheap rule-based systems; AI invoked selectively for judgment only
- **Token efficient:** Events/hooks fire before AI inspection; reasoning jobs are targeted
- **Native agent UX preserved:** Claude Code sessions feel like Claude Code — Orca wraps, not replaces

## Orchestration Pipeline

```
Events / Hooks / User Actions
    ↓
Event Bus & Projections
    ↓
Rule-Based Triggers (deterministic)
    ↓
Selective AI Reasoning Jobs (only where judgment needed)
    ↓
Memory / Tasks / Recommendations updated
```

## Autonomy Levels

MVP targets Levels 1–3:

| Level | Name | Behavior |
|-------|------|----------|
| 1 | Manual | User drives orchestration; Orca provides central coordination |
| 2 | Shared Context | Goal memory injected into all sessions automatically |
| 3 | Suggested | Recommendations, task generation, conflict detection — human supervises |
| 4 | Supervised | Orca proposes full workflows with confirmation gates |
| 5 | Autonomous | Full self-directed orchestration (out of scope for MVP) |

## Shadow session interactions

Below you will find relevant files based on the provider building on in Orca.

- Always prefer to utilize hooks instead of parsing the shadow workers/sessions

# Claude

Hooks: https://code.claude.com/docs/en/hooks

# Codex

Hooks: https://developers.openai.com/codex/hooks


## Context Assembly (Token Efficiency)

Context injected into agent sessions is assembled selectively:
- **Always included:** objective, current task, role, hard constraints, confirmed decisions, success criteria
- **Conditionally included:** sibling session summaries, architecture notes, risks, open questions
- **Always excluded:** stale logs, irrelevant discussion, raw transcripts

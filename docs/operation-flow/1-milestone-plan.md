You are acting as the lead principal engineer for this platform.

I have attached the following documents:

Product Brief
Technical Design Document
MVP Specification (Levels 1–3)
Level 4 Specification
Level 5 Specification

Your task is NOT to immediately generate code.

Your task is to produce:

an implementation architecture and milestone execution plan for Milestone 2 of the MVP.

The system is:

Tauri v2 desktop app
Node.js/TypeScript orchestration daemon
local-first
event-driven
plugin-oriented
skill-oriented
PTY/session-based
Goal/memory/reasoning-centric
optimized for orchestration and token efficiency

The implementation plan must optimize for:

architectural correctness
clean boundaries
future extensibility
token efficiency
maintainability
operational simplicity
avoiding premature complexity
preserving future Level 4 and Level 5 evolution

The implementation plan should NOT overengineer the MVP.

We are currently implementing:

## Milestone 2 — Plugin and Skill Foundation

Build:

- internal plugin registry
- internal skill registry
- default skill provider
- default storage plugin
- shell/manual adapter plugin

Exit criteria:

- app can list available skills/adapters
- Goal creation can invoke a skill

The implementation document should include:

1. Milestone Purpose

Explain why this milestone exists and what architectural foundation it establishes.

2. High-Level Runtime Architecture

Show how:

Tauri app
Node daemon
IPC/API layer
SQLite storage
event system
projections
interact during this milestone.
3. Repository Structure

Design the repository layout for:

desktop app
daemon
shared packages
storage
plugins
skills
types
infrastructure
tests

Favor a monorepo if appropriate.

4. Technology Decisions

Recommend:

package manager
monorepo tooling
ORM/query layer
API framework
WebSocket solution
schema validation
logging
testing framework
build tooling

Explain WHY each choice is appropriate.

5. Runtime Lifecycle

Describe:

how the desktop app starts
how the daemon starts
how health checks work
how reconnection works
how shutdown works
6. Event System Design

Design:

event interfaces
event persistence
event bus architecture
projection update flow

Keep this MVP-appropriate.

7. Database Design

Design the initial SQLite schema for:

goals
events
projections

Avoid premature schema complexity.

8. API Contract Design

Define the initial API surface for:

Goal CRUD
daemon health
event streaming

Use concrete endpoint examples.

9. UI Architecture

Define:

state management
event subscriptions
Goal dashboard structure
runtime connection indicators

Keep the UI minimal for Milestone 2.

10. Milestone Task Breakdown

Break Milestone 2 into:

sequential implementation tasks
dependencies
expected outputs
validation steps

This section should be detailed enough that another agent could execute tasks one-by-one.

11. Validation Strategy

Define how we validate:

daemon startup
desktop connectivity
database persistence
event persistence
Goal CRUD
reconnect behavior
12. Risks and Simplifications

Identify:

biggest technical risks
things intentionally deferred
overengineering traps to avoid
13. Definition of Done

Provide a precise “Milestone 2 complete” definition.

Very important constraints:

Preserve plugin-first architecture
Preserve skill-first architecture
Preserve event-driven design
Do NOT build cloud infrastructure
Do NOT build Level 4/5 systems yet
Avoid premature microservices
Avoid overengineering
Favor clean boundaries over feature quantity
Favor deterministic systems over excessive AI reasoning
Favor hooks/events over constant orchestration loops

Output the implementation plan as a professional engineering design document with clear sections, rationale, and implementation sequencing.
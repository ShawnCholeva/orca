# Internal Plugins and Skills — Developer Guide

**Milestone:** M2 — Plugin and Skill Foundation  
**References:** [`docs/milestones/2.md`](../milestones/2.md) · [`docs/implementation-plans/milestone-2.md`](../implementation-plans/milestone-2.md)

---

## Overview

Orca uses a static, internal plugin/skill registry that is populated once at daemon boot and then frozen. Plugins are plain descriptors (id, name, version, capabilities). Skills are typed invocables registered to an extension point.

There is no dynamic loading, no JSON manifests, and no external plugin API package in M2. All plugin and skill definitions live inside the daemon source tree.

---

## How to Add a Plugin Descriptor

1. Choose a capability from `PluginCapability` in `apps/daemon/src/registry/types.ts`:
   - `'storage'` — provides a data store
   - `'skill.provider'` — provides one or more skills
   - `'agent.adapter'` — can spawn/wrap an agent

2. Add a `plugins.register(...)` call in `bootstrapRegistries()` inside `apps/daemon/src/registry/bootstrap.ts`, before the `plugins.freeze()` call:

   ```ts
   plugins.register({
     id: 'orca.my-plugin',
     name: 'My Plugin',
     version,
     capabilities: ['skill.provider'],
   });
   ```

3. The new descriptor will appear in `GET /v1/plugins` immediately on the next daemon boot.

4. Update the assertion in `apps/daemon/src/registry/bootstrap.test.ts` that checks the plugin count — it expects exactly the registered built-ins.

**Validation:** Start the daemon (`pnpm --filter @orca/daemon dev`) and run:

```sh
curl -H "Authorization: Bearer <token>" http://127.0.0.1:8787/v1/plugins
```

---

## How to Add a Skill

1. Add a new extension point to `SkillExtensionPoint` in `apps/daemon/src/registry/types.ts` if needed. Currently the only value is `'goal.create'`.

2. Create `apps/daemon/src/skills/<your-id>.ts` exporting a `SkillDescriptor`:

   ```ts
   import type { SkillDescriptor } from '../registry/types.js';

   export const mySkill: SkillDescriptor<{ input: string }, { result: string }> = {
     id: 'my-skill',
     pluginId: 'orca.default-skills',
     extensionPoint: 'goal.create',
     title: 'My Skill',
     description: 'What this skill does.',
     invoke(input, _ctx) {
       // pure logic only — no I/O, no DB writes, no event bus calls
       return { result: input.input.trim() };
     },
   };
   ```

3. Register the skill in `bootstrapRegistries()` inside `apps/daemon/src/registry/bootstrap.ts`, before `skills.freeze()`:

   ```ts
   import { mySkill } from '../skills/my-skill.js';
   // ...
   skills.register(mySkill);
   ```

4. Update `apps/daemon/src/registry/bootstrap.test.ts` — the test asserts the exact set of registered skills.

5. The skill will appear in `GET /v1/skills` on next boot.

**Rules for `invoke`:**
- No I/O, no database access, no event bus calls — the usecase owns those.
- Throw `ValidationError` (from `apps/daemon/src/goals.ts`) for user-facing validation errors.
- Throw a plain `Error` for configuration/programming errors.
- Keep it synchronous — async skills are not wired in M2.

---

## Intentionally Deferred

The following are explicitly out of scope until later milestones. Do not introduce them without a new milestone scoping them:

- **No external plugin API package** (`@orca/plugin-api`) — interfaces stay daemon-internal.
- **No dynamic plugin loading** — `bootstrapRegistries()` is the only registration path.
- **No JSON manifests** — descriptors are TypeScript, not filesystem configuration.
- **No permissions or sandbox** — all internal plugins run in the same process with full trust.
- **No `StorageProvider` abstraction** — SQLite is the only storage layer; it is not wrapped.
- **No `SkillRuntime`** — skills are invoked inline by the usecase that owns the extension point.
- **No generic skill invocation endpoint** (`POST /v1/skills/:id/invoke`).
- **No skill detail endpoint** (`GET /v1/skills/:id`).
- **No agent adapter spawn** — `orca.shell-manual` is a descriptor only; there is no PTY runtime.
- **No `EventSubscriber` extension point** — plugins cannot subscribe to the event bus in M2.
- **No skill failure events** — only successful `skill.invoked` events are persisted.

See [`docs/milestones/2.md §3`](../milestones/2.md) for the full rationale behind each deferral.

# Design: LLM query rewrite for paper auto-RAG

**Date:** 2026-06-23
**Status:** SUPERSEDED by `2026-06-23-paper-rag-prf-design.md`. Shipped, then replaced:
a dry run showed `claude -p` rewrite produces good queries but takes ~3–22s (vs the
4s timeout), so it almost always timed out and fell back to the raw prompt. Replaced
with local pseudo-relevance feedback, which is instant and (empirically) retrieves
better. The sections below describe the original, now-removed approach.
**Component:** `scripts/paper-rag/`

## Problem

The `UserPromptSubmit` hook (`query-hook.mjs`) feeds the user's prompt **verbatim**
to the local ChromaDB search server as the retrieval query. When the user types a
casual build request ("i wanna build a thing that retries failed agent steps"), the
raw text is a poor retrieval query: it lands in the right corpus (the entire index
is the *Code as Agent Harness* paper) but often the wrong **sub-area** (planning vs.
memory/context vs. tool use vs. verification vs. multi-agent orchestration).

We want a step that reformulates the build request into a sharper, harness-design
search query so the injected passages target the relevant sub-area.

## Scope

- **In scope:** rewrite the *hidden retrieval query only*. The user's message to
  Claude is never altered. The model still receives `<your message> + injected
  passages`; only which passages get injected changes.
- **Out of scope:** reframing the prompt the model acts on; query expansion via
  non-LLM techniques (considered and set aside in favor of LLM reformulation);
  changing the 150-word injection clamp in the hook.

## Decisions

| Decision | Choice |
| --- | --- |
| What the rewrite changes | The internal retrieval query only |
| Backend | `claude -p --model haiku` (no `ANTHROPIC_API_KEY` is set; CLI reuses existing login) |
| When it runs | Gated on substance (≥ 7 words and not a trivial follow-up) |
| Timeout | ~4s; any failure falls back to the raw prompt |
| Recursion guard | `ORCA_PAPER_REWRITING=1` env sentinel |
| Isolation | nested `claude -p` runs with `cwd` = OS temp dir to avoid reloading project CLAUDE.md/hooks |

## Data flow

```
UserPromptSubmit fires
  └─ query-hook.mjs
       1. read {prompt} from stdin
       2. RECURSION GUARD: if env ORCA_PAPER_REWRITING is set → exit 0 (no injection)
       3. GATE: isSubstantive(prompt)?
            • no  → query = raw prompt
            • yes → query = await rewriteQuery(prompt)
                       on timeout/error/empty → query = raw prompt
       4. POST { query, k: 3 } to local server   (unchanged)
       5. filter by distance ≤ ORCA_PAPER_MAX_DIST, clamp to 150 words, print  (unchanged)
```

## Components

### `isSubstantive(prompt)` — gate
- Returns `true` when the trimmed prompt has **≥ 7 whitespace-delimited words**.
- This is the entire heuristic; trivial follow-ups ("yes", "run it", "fix that")
  fall below the threshold and skip the rewrite, staying instant. No separate
  hard-coded trivial-phrase list — word count alone is sufficient and simpler.

### `rewriteQuery(prompt)` — LLM reformulation
- Spawns `claude -p --model haiku`.
- The **user prompt is piped via stdin** (no shell-escaping of arbitrary text).
- The instruction (sent as part of the piped input) directs Claude to:
  > Rewrite the developer's build request into a concise keyword/phrase search
  > query for retrieving passages from a survey on designing agent harnesses.
  > Emphasize the relevant harness sub-area (planning, memory/context engineering,
  > tool use, plan-execute-verify control, verification, multi-agent orchestration).
  > Output ONLY the query text — no preamble, no quotes, no explanation.
- Spawn options:
  - `env`: inherit + `ORCA_PAPER_REWRITING: "1"`.
  - `cwd`: OS temp dir (keeps the nested session from loading the project's
    CLAUDE.md and hooks → faster, and removes the project-hook recursion path).
- A ~4s timer kills the child on expiry.
- Returns the trimmed stdout, or `null` on: `claude` not found, nonzero exit,
  timeout, or empty/whitespace output.

### Recursion guard
- At the top of `main()` in `query-hook.mjs`: if `process.env.ORCA_PAPER_REWRITING`
  is set, exit 0 immediately without injecting. This makes the nested `claude -p`
  session's own `UserPromptSubmit` hook a no-op, so the hook cannot trigger itself.
- The temp-dir `cwd` already prevents project hooks from loading in the nested
  session; the sentinel is belt-and-suspenders that also covers any user-level
  (`~/.claude`) copy of this hook.

## Error handling

Every failure path falls back to the raw prompt as the query; the user's turn is
never blocked and retrieval never breaks:
- `claude` binary not on PATH
- nonzero exit code
- timeout (~4s)
- empty / whitespace-only stdout

## Observability

- `ORCA_PAPER_DEBUG=1` prints a single diagnostic line to **stderr**:
  - `rewrote: "<query>"` when the rewrite succeeded,
  - `rewrite skipped (short prompt)` when gated out,
  - `rewrite failed, using raw prompt` on fallback (all failure modes collapse to
    `null`, so no per-reason detail is available at the call site).
- stderr keeps diagnostics out of the injected context (only stdout is added to
  the model's context for `UserPromptSubmit` hooks).

## Testing (manual)

Matches how the rest of `paper-rag` is exercised (hook script with an external
`claude` dependency; no automated harness added):

```bash
# substantive prompt → rewrites
echo '{"prompt":"i want to build a thing that retries failed agent steps"}' \
  | ORCA_PAPER_DEBUG=1 node scripts/paper-rag/query-hook.mjs

# trivial prompt → skips rewrite, instant
echo '{"prompt":"run it"}' | ORCA_PAPER_DEBUG=1 node scripts/paper-rag/query-hook.mjs

# recursion guard → immediate no-op
echo '{"prompt":"a long substantive build request about agent harnesses"}' \
  | ORCA_PAPER_REWRITING=1 node scripts/paper-rag/query-hook.mjs

# end-to-end: type a build request in a fresh Claude session and confirm the
# injected passages target the relevant sub-area.
```

## Files touched

- `scripts/paper-rag/query-hook.mjs` — add guard, gate, and the rewrite step
  before the existing `fetch`. (The `rewriteQuery`/`isSubstantive` helpers may live
  in this file or a tiny sibling `rewrite.mjs`; decided at implementation time.)

No changes to `server.py`, `search.py`, `ingest.py`, `ensure-server.mjs`, or the
hook wiring in `.claude/settings.json`.

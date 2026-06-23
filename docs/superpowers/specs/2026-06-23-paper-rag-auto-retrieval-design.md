# Design: Auto-RAG over the "Code as Agent Harness" paper

**Date:** 2026-06-23
**Status:** Approved (pending spec review)
**Topic:** Store `agent-harness.pdf` ("Code as Agent Harness") in a local ChromaDB vector store and automatically surface relevant passages into Claude Code's context while working on Orca.

## Goal

While we work on Orca, relevant ideas from the paper should be surfaced to Claude
**automatically** — not via a manual search command. The mechanism is a
`UserPromptSubmit` hook that embeds the user's message, queries a local ChromaDB
store, and injects the strongest-matching passages into context for that turn.
This lets Claude continuously cross-reference the paper to identify opportunities
to do things better.

## Constraints (verified in environment)

- **No Docker.** Cannot run Chroma's server image.
- **Python 3.9.6** present; `ensurepip`/`pip` work → a local `.venv` is feasible.
  `pipx` is absent.
- Node/pnpm monorepo (pnpm 9). ChromaDB is Python-native, so ingest/serve/query
  live in Python; the hook glue is Node (matches existing `.claude/statusline.js`).
- ChromaDB ships a **local default embedding model** (onnxruntime, ~80MB,
  downloaded once) → **no API key**, consistent with Orca's local-first ethos.
- `UserPromptSubmit` hook stdout is injected into Claude's context → this is the
  "automatic" channel.
- CLAUDE.md guidance: **prefer hooks over parsing shadow sessions.**

## Architecture

```
agent-harness.pdf ──ingest──► Chroma store (.orca/paper-index/)
                                            ▲ loaded once
              warm query server (127.0.0.1:8787) ◄── SessionStart hook starts it
                                            ▲
   user message ─► UserPromptSubmit hook ─HTTP─► top passages ─► injected into context
```

One-time **ingest**, then every turn a hook silently consults the paper and
injects only strongly-relevant passages. A **warm local server** keeps Chroma +
the embedding model resident so per-prompt queries are fast (~50ms) instead of
paying a ~1–3s model-load cost each message.

## Components

All Python lives under `scripts/paper-rag/`, isolated in a sibling `.venv`.

### 1. `scripts/paper-rag/requirements.txt`
- `chromadb` (pinned to a Python-3.9-compatible release; verified at setup)
- `pypdf` (text extraction)
- onnxruntime is pulled transitively by Chroma's default embedding function.

### 2. `scripts/paper-rag/setup` (invoked by `pnpm run paper:setup`)
- Creates `scripts/paper-rag/.venv` via `python3 -m venv`.
- Installs `requirements.txt`.
- Idempotent: re-running is safe.

### 3. `scripts/paper-rag/ingest.py` (invoked by `pnpm run paper:index`)
- Extract text per page with pypdf.
- Chunk: ~800-token sliding windows with ~150-token overlap, each chunk tagged
  with its source page number(s) in metadata.
- Embed with Chroma's default local embedding function.
- Persist to a `PersistentClient` at `.orca/paper-index/` in a collection named
  `code-as-agent-harness`.
- On completion, assert chunk count > 0 and print a summary (chunks, pages).
- Re-running rebuilds the collection from scratch (delete + recreate) so the
  index is reproducible.

### 4. `scripts/paper-rag/server.py`
- Python stdlib `http.server` bound to `127.0.0.1:8787` (port configurable via
  `ORCA_PAPER_PORT`).
- On startup loads the `PersistentClient` collection and the embedding model
  **once**.
- Endpoint `POST /search` with body `{ "query": string, "k": number }` →
  `{ "results": [{ "text", "page", "score" }] }`.
- Endpoint `GET /health` → `200` when the collection is loaded.
- Writes `{ pid, port }` to `.orca/paper-index/server.json` on start; logs to
  `.orca/paper-index/server.log`.

### 5. `scripts/paper-rag/query-hook.mjs` (the `UserPromptSubmit` hook)
- Reads the hook JSON from stdin; extracts the user prompt.
- `POST`s `{ query: prompt, k: 3 }` to `127.0.0.1:8787` with an 800ms timeout.
- Filters results to those above the similarity threshold (only strong matches).
- Formats up to 3 excerpts (~150 words each) with `(p.NN)` citations under a
  short header, and prints to stdout (→ injected into context).
- **Silent on:** server down, timeout, or no result above threshold → exits 0
  with no output. Never blocks or errors the user's prompt.

### 5b. `scripts/paper-rag/query.py` (manual escape hatch + smoke test)
- CLI: `python query.py "<question>"` → prints the top-k passages with page and
  score. Shares the same search logic as the server (a thin local query against
  the `PersistentClient`; does not require the server to be running).
- Used by the manual escape hatch documented in CLAUDE.md and by the smoke test.

### 6. SessionStart hook (`scripts/paper-rag/ensure-server.mjs`)
- Idempotently starts `server.py` in the background.
- Skips if `.orca/paper-index/server.json` names a live PID answering `/health`.
- Non-fatal on failure (logs and exits 0); retrieval simply stays silent until
  the server is up.

### 7. `.claude/settings.json` wiring
- `hooks.SessionStart` → `node scripts/paper-rag/ensure-server.mjs`
- `hooks.UserPromptSubmit` → `node scripts/paper-rag/query-hook.mjs`
- Uses repo-relative paths (note: do not copy the existing statusLine's
  absolute Linux path, which is environment-specific and broken on this Mac).

### 8. CLAUDE.md addition
A short section documenting: paper context is auto-injected via the RAG hook;
how to rebuild the index (`pnpm run paper:index`); and a manual escape hatch
(`python scripts/paper-rag/query.py "<question>"`) for ad-hoc queries.

## Retrieval behavior (tunable defaults)

- `k = 3`. Chroma returns an L2 **distance** per result (lower = closer). The hook
  keeps only results whose distance is **below** a tuned cutoff, so only strong
  matches inject and irrelevant prompts inject nothing. ("Similarity threshold"
  elsewhere in this doc means this distance cutoff.)
- Each excerpt ~150 words with a `(p.NN)` page citation.
- Total injection capped at ~500 tokens/turn to avoid context bloat.

## Data flow

1. User sends a message.
2. `UserPromptSubmit` hook receives the prompt on stdin.
3. Hook embeds + searches via the warm server.
4. Strong matches (if any) are formatted and printed → injected into Claude's
   context for that turn.
5. Claude reasons with the paper passages alongside the user's request.

## Error handling / safety

- The hook **never blocks the prompt**: any failure path (server down, timeout,
  malformed response) exits 0 with no output.
- Server start failures are logged to `.orca/paper-index/server.log` and are
  non-fatal to the session.
- The query server binds to loopback only (`127.0.0.1`).

## Repo hygiene

- `.gitignore` additions: `scripts/paper-rag/.venv/` and `.orca/paper-index/`
  (binary store + model cache; reproducible from the PDF).
- **Committed:** the `scripts/paper-rag/` source, `package.json` script entries,
  `.claude/settings.json` hook wiring, and CLAUDE.md changes.
- The PDF itself: left in place; ingestion reads it from the repo root.

## Testing

- **Ingest:** asserts chunk count > 0; prints chunk/page summary.
- **Server smoke:** `scripts/paper-rag/query.py "agent harness"` returns ≥1
  result with text/page/score fields.
- **Hook unit:** feed a sample `UserPromptSubmit` JSON on stdin; assert that
  above-threshold results format with citations and that below-threshold /
  server-down inputs produce empty stdout and exit 0.

## Open implementation checks (resolved during build, not blockers)

- Pin the exact Chroma version compatible with Python 3.9.6; verify at setup.
- Confirm Chroma's default embedding model downloads cleanly offline-after-first
  on macOS arm64.
- Tune the distance threshold against a handful of representative Orca prompts.

## Out of scope

- Indexing other documents or the codebase (single-paper scope for now).
- API-based embeddings (rejected: local-first, no key).
- Any UI; this is hook-and-context only.

# Design: local pseudo-relevance feedback for paper auto-RAG

**Date:** 2026-06-23
**Status:** Implemented
**Component:** `scripts/paper-rag/`
**Supersedes:** `2026-06-23-paper-rag-query-rewrite-design.md` (the `claude -p` rewrite)

## Problem

The `UserPromptSubmit` hook feeds the user's prompt verbatim to the local
ChromaDB search server. A vague build request ("I want to add a side effect to
the nodes for async processes") retrieves poorly — it lands in the right corpus
(the *Code as Agent Harness* paper) but the wrong sub-area, and often above the
`ORCA_PAPER_MAX_DIST` (1.3) injection cutoff, so nothing useful is injected.

A first attempt reformulated the prompt with `claude -p --model haiku`. It produced
good queries but a dry run measured ~3–22s latency (vs. a 4s timeout), so it almost
always timed out and fell back to the raw prompt — shipping effectively disabled.

## Empirical findings (dry run on the prompt above)

- **Raw prompt:** top hits at distances 1.473 / 1.564 / 1.571 — all above the 1.3
  cutoff → nothing injected. Two of the three were bibliography pages (p.85, p.89).
- **Naive PRF (no reference handling):** expansion terms were citation junk
  (`github, https, accessed, repository, arxiv, preprint`) mined from those
  bibliography pages; top result became p.85 — worse.
- **Reference pages are a root cause.** The paper's ~36 pages of bibliography
  (p.67–102) were indexed as if they were content. They are pure citation noise.
- **Excluding references + simple PRF:** expansion terms became contentful
  (`execution, feedback, state, test, correctness, pass, fail…`) and retrieval
  returned p.41 / p.50 / p.64 at 1.126 / 1.183 / 1.217 — all under the cutoff, all
  content, and better than the `claude -p` rewrite's 1.250 / 1.273. Latency: ~tens
  of ms, no LLM, no subprocess.

## Decisions

| Decision | Choice |
| --- | --- |
| Reformulation mechanism | Local pseudo-relevance feedback (two-pass corpus query expansion). No LLM. |
| Reference noise | Exclude the bibliography at index time so the index holds only body content. |
| Where PRF runs | `search.py` (server-side) — the hook and the `query.py` CLI both benefit with no change to them. |
| When it runs | Every query (it is cheap; no gate). |
| Feedback set | Top `FEEDBACK_K = 3` chunks of the first pass. |
| Expansion size | Top `EXPANSION_TERMS = 10` terms. |

## Components

### `ingest.py` — exclude the bibliography
- `find_references_page(reader)`: returns the 1-based page whose text contains a
  line that is *only* the "References" heading (`^\s*References\s*$`, multiline),
  so inline mentions of the word in the body (cross-references, captions) can't
  truncate the index. Returns `None` if not found.
- `load_words_with_pages` stops collecting words at that page. Returns
  `(words, pages, ref_start)`.
- `main` prints `… (excluded references from p.N)` when a references page was found.
- For this PDF: references detected at p.67; index drops from 96 → 68 chunks.

### `search.py` — pseudo-relevance feedback
- `STOPWORDS`: English stopwords plus corpus-ubiquitous words that carry no
  discriminating signal (`code, agent, harness, model, system, …`).
- `_expansion_terms(feedback_texts, query)`: lowercase alphabetic tokens of length
  ≥ 4, excluding stopwords and words already in the query; ranked by frequency
  across the feedback chunks; top `EXPANSION_TERMS`.
- `_expand(query)`: first-pass query (`FEEDBACK_K` results) → mine terms → append
  to the query. Under `ORCA_PAPER_DEBUG`, write `prf expanded: <repr>` to stderr.
- `search(query, k)`: runs the final query with the expanded text; unchanged return
  shape (`[{text, page, distance}]`).

### `query-hook.mjs` — reverted
- The `claude -p` rewrite wiring (import, recursion guard, substantive gate, debug
  lines) is removed; the hook again posts the raw prompt to the server. PRF happens
  server-side, so no hook logic is needed.
- `rewrite.mjs` is deleted.

## Observability

`ORCA_PAPER_DEBUG=1` prints the expanded query to stderr. On the `query.py` CLI it
prints directly; for the hook (PRF runs in the server process) set it when launching
the server (`pnpm run paper:serve`) and the line lands in
`.orca/paper-index/server.log`.

## Testing (manual)

```bash
pnpm run paper:index   # expect: "... (excluded references from p.67)", ~68 chunks

# in-process, see the expansion + distances
ORCA_PAPER_DEBUG=1 scripts/paper-rag/.venv/bin/python scripts/paper-rag/query.py \
  "I want to add a side effect to the nodes for async processes"
# expect contentful expansion terms; hits on content pages under 1.3

# end-to-end through the hook (server must be running)
node scripts/paper-rag/ensure-server.mjs
echo '{"prompt":"I want to add a side effect to the nodes for async processes"}' \
  | node scripts/paper-rag/query-hook.mjs
# expect injected passages from content pages (p.41/p.50/p.64)
```

No automated test framework (consistent with the rest of `scripts/paper-rag`).

## Files touched

- `scripts/paper-rag/ingest.py` — reference-section exclusion
- `scripts/paper-rag/search.py` — PRF expansion
- `scripts/paper-rag/query-hook.mjs` — revert rewrite wiring
- `scripts/paper-rag/rewrite.mjs` — deleted
- `CLAUDE.md` — document PRF + reference exclusion

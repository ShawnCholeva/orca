# Paper Auto-RAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index the "Code as Agent Harness" PDF into a local ChromaDB store and auto-inject relevant passages into Claude Code's context on every prompt via a hook.

**Architecture:** A Python `.venv` under `scripts/paper-rag/` holds ChromaDB (local default embeddings, no API key). `ingest.py` builds a persistent Chroma collection from the PDF. `server.py` keeps Chroma + the embedding model warm and answers `POST /search`. A `UserPromptSubmit` Node hook queries the server and prints strong matches (which Claude Code injects into context); a `SessionStart` Node hook idempotently starts the server.

**Tech Stack:** Python 3.9 stdlib + ChromaDB + pypdf; Node (ESM `.mjs`) for hook glue; pnpm scripts.

## Global Constraints

- Python interpreter: system `python3` (3.9.6) via a `.venv`; no Docker, no `pipx`.
- Embeddings: ChromaDB's local **default** embedding function only — **no API key, no network embedding calls**.
- Chroma store path: `.orca/paper-index/` (repo root). Collection name: `code-as-agent-harness`.
- PDF source path: `agent-harness.pdf` (repo root).
- Server bind: `127.0.0.1`, port from `ORCA_PAPER_PORT` (default `8787`).
- The `UserPromptSubmit` hook MUST never block or fail the prompt: any error/timeout → exit 0, empty stdout.
- All hooks/scripts use repo-relative or `$CLAUDE_PROJECT_DIR`-anchored paths — never absolute machine paths.
- Pin: `chromadb>=0.5.0,<0.6`, `pypdf>=4,<6` (Python-3.9 compatible).

## File Structure

- `scripts/paper-rag/requirements.txt` — Python deps.
- `scripts/paper-rag/setup` — bash: build `.venv`, install deps.
- `scripts/paper-rag/ingest.py` — PDF → chunks → Chroma collection.
- `scripts/paper-rag/search.py` — shared `search(query, k)` + lazy collection loader.
- `scripts/paper-rag/query.py` — CLI escape hatch over `search`.
- `scripts/paper-rag/server.py` — warm HTTP search server.
- `scripts/paper-rag/ensure-server.mjs` — `SessionStart` hook: idempotent background start.
- `scripts/paper-rag/query-hook.mjs` — `UserPromptSubmit` hook: query + format + inject.
- `.gitignore` — ignore `.venv` and the Chroma store.
- `package.json` — `paper:setup`, `paper:index`, `paper:serve` scripts.
- `.claude/settings.json` — register the two hooks.
- `CLAUDE.md` — document the system.

---

### Task 1: Python environment and dependencies

**Files:**
- Create: `scripts/paper-rag/requirements.txt`
- Create: `scripts/paper-rag/setup`
- Modify: `.gitignore`
- Modify: `package.json` (scripts block)

**Interfaces:**
- Produces: a working interpreter at `scripts/paper-rag/.venv/bin/python` with `chromadb` and `pypdf` importable. `pnpm run paper:setup` builds it.

- [ ] **Step 1: Write `requirements.txt`**

```
chromadb>=0.5.0,<0.6
pypdf>=4,<6
```

- [ ] **Step 2: Write the `setup` script**

`scripts/paper-rag/setup`:
```bash
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
python3 -m venv "$DIR/.venv"
"$DIR/.venv/bin/pip" install --upgrade pip
"$DIR/.venv/bin/pip" install -r "$DIR/requirements.txt"
"$DIR/.venv/bin/python" -c "import chromadb, pypdf; print('deps ok')"
```

- [ ] **Step 3: Make it executable**

Run: `chmod +x scripts/paper-rag/setup`

- [ ] **Step 4: Ignore the venv and store**

Append to `.gitignore`:
```
scripts/paper-rag/.venv/
.orca/paper-index/
```

- [ ] **Step 5: Add pnpm scripts**

In `package.json` `"scripts"`, add:
```json
    "paper:setup": "bash scripts/paper-rag/setup",
    "paper:index": "scripts/paper-rag/.venv/bin/python scripts/paper-rag/ingest.py",
    "paper:serve": "scripts/paper-rag/.venv/bin/python scripts/paper-rag/server.py",
```

- [ ] **Step 6: Run setup and verify**

Run: `pnpm run paper:setup`
Expected: ends with `deps ok` (first run downloads packages; may take a minute).

- [ ] **Step 7: Commit**

```bash
git add scripts/paper-rag/requirements.txt scripts/paper-rag/setup .gitignore package.json
git commit -m "feat(paper-rag): python venv and dependency setup"
```

---

### Task 2: PDF ingestion into ChromaDB

**Files:**
- Create: `scripts/paper-rag/ingest.py`

**Interfaces:**
- Consumes: `scripts/paper-rag/.venv` from Task 1.
- Produces: a persisted Chroma collection `code-as-agent-harness` at `.orca/paper-index/` containing word-window chunks with `{"page": int}` metadata. Re-runnable (drops + rebuilds).

- [ ] **Step 1: Write `ingest.py`**

```python
import os
from pypdf import PdfReader
import chromadb

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PDF = os.path.join(ROOT, "agent-harness.pdf")
STORE = os.path.join(ROOT, ".orca", "paper-index")
COLLECTION = "code-as-agent-harness"
WINDOW = 600   # ~800 tokens
OVERLAP = 100


def load_words_with_pages(path):
    reader = PdfReader(path)
    words, pages = [], []
    for i, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        for w in text.split():
            words.append(w)
            pages.append(i)
    return words, pages


def make_chunks(words, pages):
    chunks = []
    step = WINDOW - OVERLAP
    for start in range(0, len(words), step):
        window = words[start:start + WINDOW]
        if not window:
            break
        chunks.append((" ".join(window), pages[start]))
        if start + WINDOW >= len(words):
            break
    return chunks


def main():
    words, pages = load_words_with_pages(PDF)
    chunks = make_chunks(words, pages)
    assert len(chunks) > 0, "no chunks produced from PDF"
    os.makedirs(STORE, exist_ok=True)
    client = chromadb.PersistentClient(path=STORE)
    try:
        client.delete_collection(COLLECTION)
    except Exception:
        pass
    col = client.create_collection(COLLECTION)
    col.add(
        ids=[f"c{i}" for i in range(len(chunks))],
        documents=[c[0] for c in chunks],
        metadatas=[{"page": c[1]} for c in chunks],
    )
    print(f"indexed {len(chunks)} chunks across {pages[-1]} pages -> {STORE}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run ingestion**

Run: `pnpm run paper:index`
Expected: `indexed <N> chunks across <P> pages -> .../.orca/paper-index` with N > 0 (first run downloads the ~80MB embedding model).

- [ ] **Step 3: Verify the store persisted with a positive count**

Run:
```bash
scripts/paper-rag/.venv/bin/python -c "import chromadb; c=chromadb.PersistentClient(path='.orca/paper-index').get_collection('code-as-agent-harness'); print('count', c.count()); assert c.count()>0"
```
Expected: `count <N>` with N > 0, no assertion error.

- [ ] **Step 4: Commit**

```bash
git add scripts/paper-rag/ingest.py
git commit -m "feat(paper-rag): ingest PDF into chroma collection"
```

---

### Task 3: Shared search module and CLI

**Files:**
- Create: `scripts/paper-rag/search.py`
- Create: `scripts/paper-rag/query.py`

**Interfaces:**
- Consumes: the Chroma collection from Task 2.
- Produces: `search(query: str, k: int = 3) -> list[dict]` where each dict is `{"text": str, "page": int, "distance": float}`, ordered nearest-first. `query.py "<question>"` prints them.

- [ ] **Step 1: Write `search.py`**

```python
import os
import chromadb

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STORE = os.path.join(ROOT, ".orca", "paper-index")
COLLECTION = "code-as-agent-harness"

_col = None


def collection():
    global _col
    if _col is None:
        client = chromadb.PersistentClient(path=STORE)
        _col = client.get_collection(COLLECTION)
    return _col


def search(query, k=3):
    res = collection().query(query_texts=[query], n_results=k)
    out = []
    for text, meta, dist in zip(
        res["documents"][0], res["metadatas"][0], res["distances"][0]
    ):
        out.append({"text": text, "page": meta.get("page"), "distance": dist})
    return out
```

- [ ] **Step 2: Write `query.py`**

```python
import sys
from search import search


def main():
    if len(sys.argv) < 2:
        print("usage: query.py <question>", file=sys.stderr)
        sys.exit(1)
    for r in search(" ".join(sys.argv[1:]), k=3):
        print(f"(p.{r['page']}) dist={r['distance']:.3f}")
        print(r["text"][:400])
        print()


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Smoke-test the CLI**

Run: `scripts/paper-rag/.venv/bin/python scripts/paper-rag/query.py "what is an agent harness"`
Expected: at least one `(p.NN) dist=…` block printed with paper text. Note a couple of the distances — they calibrate the threshold in Task 6.

- [ ] **Step 4: Commit**

```bash
git add scripts/paper-rag/search.py scripts/paper-rag/query.py
git commit -m "feat(paper-rag): shared search module and query CLI"
```

---

### Task 4: Warm search server

**Files:**
- Create: `scripts/paper-rag/server.py`

**Interfaces:**
- Consumes: `search.search` / `search.collection` from Task 3.
- Produces: HTTP server on `127.0.0.1:$ORCA_PAPER_PORT` (default 8787). `GET /health` → `{"ok": true}` when loaded. `POST /search` body `{"query": str, "k": int}` → `{"results": [{"text","page","distance"}]}`.

- [ ] **Step 1: Write `server.py`**

```python
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
import search as search_mod

HOST = "127.0.0.1"
PORT = int(os.environ.get("ORCA_PAPER_PORT", "8787"))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            try:
                search_mod.collection()
                self._send(200, {"ok": True})
            except Exception as e:
                self._send(500, {"ok": False, "error": str(e)})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/search":
            self._send(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        query = body.get("query", "")
        k = int(body.get("k", 3))
        results = search_mod.search(query, k) if query else []
        self._send(200, {"results": results})


def main():
    search_mod.collection()  # warm before accepting requests
    HTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Start the server in the background**

Run:
```bash
scripts/paper-rag/.venv/bin/python scripts/paper-rag/server.py > /tmp/paper-server.log 2>&1 &
sleep 5
```

- [ ] **Step 3: Verify health and search endpoints**

Run:
```bash
curl -s http://127.0.0.1:8787/health
echo
curl -s -X POST http://127.0.0.1:8787/search -d '{"query":"agent harness","k":2}'
echo
```
Expected: `{"ok": true}` then a `{"results":[...]}` payload with `text`/`page`/`distance` fields.

- [ ] **Step 4: Stop the test server**

Run: `pkill -f scripts/paper-rag/server.py || true`

- [ ] **Step 5: Commit**

```bash
git add scripts/paper-rag/server.py
git commit -m "feat(paper-rag): warm http search server"
```

---

### Task 5: SessionStart hook to ensure the server is running

**Files:**
- Create: `scripts/paper-rag/ensure-server.mjs`

**Interfaces:**
- Consumes: `server.py` from Task 4; `scripts/paper-rag/.venv/bin/python`.
- Produces: an idempotent starter. Writes `{pid, port}` to `.orca/paper-index/server.json`; logs to `.orca/paper-index/server.log`. Exits 0 always.

- [ ] **Step 1: Write `ensure-server.mjs`**

```javascript
#!/usr/bin/env node
import { spawn } from "node:child_process";
import { openSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const storeDir = join(root, ".orca", "paper-index");
const stateFile = join(storeDir, "server.json");
const logFile = join(storeDir, "server.log");
const py = join(here, ".venv", "bin", "python");
const port = process.env.ORCA_PAPER_PORT || "8787";

async function healthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (await healthy()) return;
  if (!existsSync(py)) return; // setup not run yet
  const out = openSync(logFile, "a");
  const child = spawn(py, [join(here, "server.py")], {
    cwd: here,
    env: { ...process.env, ORCA_PAPER_PORT: port },
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  writeFileSync(stateFile, JSON.stringify({ pid: child.pid, port }));
}

main().finally(() => process.exit(0));
```

- [ ] **Step 2: Verify it starts the server when down**

Run:
```bash
pkill -f scripts/paper-rag/server.py || true
node scripts/paper-rag/ensure-server.mjs
sleep 5
curl -s http://127.0.0.1:8787/health; echo
```
Expected: `{"ok": true}`.

- [ ] **Step 3: Verify idempotency (no second process)**

Run:
```bash
node scripts/paper-rag/ensure-server.mjs
pgrep -fc scripts/paper-rag/server.py
```
Expected: `1` (exactly one server process; the second call found it healthy and did nothing).

- [ ] **Step 4: Stop the test server**

Run: `pkill -f scripts/paper-rag/server.py || true`

- [ ] **Step 5: Commit**

```bash
git add scripts/paper-rag/ensure-server.mjs
git commit -m "feat(paper-rag): SessionStart hook to ensure search server"
```

---

### Task 6: UserPromptSubmit hook to inject relevant passages

**Files:**
- Create: `scripts/paper-rag/query-hook.mjs`

**Interfaces:**
- Consumes: the `/search` endpoint from Task 4.
- Produces: reads the hook event JSON (`{prompt, ...}`) from stdin; on strong matches prints a formatted block to stdout (injected into context); otherwise prints nothing. Always exits 0. Threshold via `ORCA_PAPER_MAX_DIST` (default `1.0`).

- [ ] **Step 1: Write `query-hook.mjs`**

```javascript
#!/usr/bin/env node
const port = process.env.ORCA_PAPER_PORT || "8787";
const MAX_DIST = Number(process.env.ORCA_PAPER_MAX_DIST || "1.0");
const WORD_CAP = 150;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 500);
  });
}

function clampWords(text, n) {
  const words = text.split(/\s+/);
  return words.length <= n ? text : words.slice(0, n).join(" ") + " …";
}

async function main() {
  let prompt = "";
  try {
    prompt = (JSON.parse(await readStdin()).prompt || "").trim();
  } catch {
    return;
  }
  if (!prompt) return;

  let results = [];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: prompt, k: 3 }),
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) return;
    results = (await res.json()).results || [];
  } catch {
    return;
  }

  const strong = results.filter((r) => r.distance <= MAX_DIST).slice(0, 3);
  if (strong.length === 0) return;

  const lines = strong.map(
    (r) => `- (p.${r.page}) ${clampWords(r.text, WORD_CAP)}`
  );
  process.stdout.write(
    "Relevant passages from the *Code as Agent Harness* paper " +
      "(auto-retrieved; consider whether they suggest a better approach):\n" +
      lines.join("\n") +
      "\n"
  );
}

main().finally(() => process.exit(0));
```

- [ ] **Step 2: Test a strong-match prompt injects passages**

Run (start a server first if not running: `node scripts/paper-rag/ensure-server.mjs && sleep 5`):
```bash
echo '{"prompt":"how should an agent harness manage context"}' | node scripts/paper-rag/query-hook.mjs
```
Expected: a `Relevant passages from the *Code as Agent Harness* paper …` header followed by `- (p.NN) …` lines.

- [ ] **Step 3: Test the server-down path is silent and exit 0**

Run:
```bash
pkill -f scripts/paper-rag/server.py || true
echo '{"prompt":"anything"}' | node scripts/paper-rag/query-hook.mjs; echo "exit=$?"
```
Expected: no stdout before `exit=0`.

- [ ] **Step 4: Test the empty-prompt path is silent**

Run: `echo '{"prompt":""}' | node scripts/paper-rag/query-hook.mjs; echo "exit=$?"`
Expected: no stdout before `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add scripts/paper-rag/query-hook.mjs
git commit -m "feat(paper-rag): UserPromptSubmit hook injects paper passages"
```

---

### Task 7: Wire hooks into settings and document in CLAUDE.md

**Files:**
- Modify: `.claude/settings.json`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `ensure-server.mjs` (Task 5), `query-hook.mjs` (Task 6).
- Produces: registered `SessionStart` + `UserPromptSubmit` hooks; a CLAUDE.md section.

- [ ] **Step 1: Add hooks to `.claude/settings.json`**

Add a top-level `"hooks"` key (alongside the existing `"statusLine"`):
```json
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/scripts/paper-rag/ensure-server.mjs\"" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/scripts/paper-rag/query-hook.mjs\"" } ] }
    ]
  }
```

- [ ] **Step 2: Verify settings.json is valid JSON**

Run: `python3 -c "import json; json.load(open('.claude/settings.json')); print('valid')"`
Expected: `valid`.

- [ ] **Step 3: Document in `CLAUDE.md`**

Append this section to `CLAUDE.md`:
```markdown
## Paper Auto-RAG ("Code as Agent Harness")

The paper `agent-harness.pdf` is indexed in a local ChromaDB store
(`.orca/paper-index/`). A `UserPromptSubmit` hook auto-injects the most relevant
passages into context each turn, so Claude can cross-reference the paper for
better approaches. A `SessionStart` hook keeps a warm query server running.

- First-time setup: `pnpm run paper:setup` then `pnpm run paper:index`
- Rebuild the index: `pnpm run paper:index`
- Manual query: `scripts/paper-rag/.venv/bin/python scripts/paper-rag/query.py "<question>"`

Retrieval is silent when nothing is strongly relevant. Tune the distance cutoff
with `ORCA_PAPER_MAX_DIST` (default 1.0); change the port with `ORCA_PAPER_PORT`.
```

- [ ] **Step 4: End-to-end verification**

Run:
```bash
node scripts/paper-rag/ensure-server.mjs && sleep 5
echo '{"prompt":"managing shared context across multiple agents"}' | node scripts/paper-rag/query-hook.mjs
```
Expected: a header + `- (p.NN) …` passage lines (the full pipeline working as the hooks will run it).

- [ ] **Step 5: Commit**

```bash
git add .claude/settings.json CLAUDE.md
git commit -m "feat(paper-rag): wire hooks and document auto-RAG"
```

---

## Notes for the implementer

- Run Task 1's `pnpm run paper:setup` before anything else; every later task needs the `.venv`.
- The first `paper:index` and first server start each download a model/packages — allow extra time and ignore the one-time latency.
- If `chromadb>=0.5.0,<0.6` fails to install or import on Python 3.9.6, try the latest `0.5.x` patch explicitly, then a `1.0.x` release; update `requirements.txt` to the version that imports cleanly and re-run setup.
- Calibrate `ORCA_PAPER_MAX_DIST` using the distances printed in Task 3 Step 3: pick a cutoff just above the distance of clearly-relevant hits so off-topic prompts inject nothing.

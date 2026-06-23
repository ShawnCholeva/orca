import os
import re
import sys
import _quiet  # noqa: F401  (silences telemetry/warnings; must precede chromadb)
from pypdf import PdfReader
import chromadb

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PDF = os.path.join(ROOT, "agent-harness.pdf")
STORE = os.path.join(ROOT, ".orca", "paper-index")
COLLECTION = "code-as-agent-harness"
WINDOW = 600   # ~800 tokens
OVERLAP = 100


def find_references_page(reader):
    """1-based page where the bibliography starts, or None if not found.

    The References heading only appears once, late in the document; restricting
    the search to the second half avoids matching inline mentions in the body.
    """
    n = len(reader.pages)
    for i, page in enumerate(reader.pages, start=1):
        if i > n // 2 and re.search(r"\bReferences\b", page.extract_text() or ""):
            return i
    return None


def load_words_with_pages(path):
    """Words and their 1-based page, excluding the bibliography.

    Reference entries are pure citation noise (author names, URLs, "arXiv
    preprint") that pollute retrieval and query expansion, so we stop at the
    References section.
    """
    reader = PdfReader(path)
    ref_start = find_references_page(reader)
    words, pages = [], []
    for i, page in enumerate(reader.pages, start=1):
        if ref_start is not None and i >= ref_start:
            break
        text = page.extract_text() or ""
        for w in text.split():
            words.append(w)
            pages.append(i)
    return words, pages, ref_start


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
    if not os.path.exists(PDF):
        print(f"error: source PDF not found at {PDF}\nPlace 'agent-harness.pdf' (arXiv 2605.18747) at the repo root, then re-run: pnpm run paper:index", file=sys.stderr)
        sys.exit(1)
    words, pages, ref_start = load_words_with_pages(PDF)
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
    excluded = f" (excluded references from p.{ref_start})" if ref_start else ""
    print(f"indexed {len(chunks)} chunks across {pages[-1]} pages{excluded} -> {STORE}")


if __name__ == "__main__":
    main()

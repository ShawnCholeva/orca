import os
import re
import sys
import _quiet  # noqa: F401  (silences telemetry/warnings; must precede chromadb)
import chromadb

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STORE = os.path.join(ROOT, ".orca", "paper-index")
COLLECTION = "code-as-agent-harness"

FEEDBACK_K = 3       # top chunks mined for expansion terms
EXPANSION_TERMS = 10  # terms appended to the query

# Stopwords plus words so common in this corpus that they carry no signal for
# distinguishing one passage from another.
STOPWORDS = set(
    """the a an and or of to for in on with as is are be by that this these those it its from
    into over under we our you your they their them at can will may not no nor but if then than
    so such use used using via within across between among each per also more most other some any
    all both few many much how what when where which who whose about above below after before
    during while because since unless until been was were do does did has have had would should
    could onto out off up down only own same too very based given approach method paper survey
    work works code agent agents harness harnesses model models system systems""".split()
)


_col = None


def collection():
    global _col
    if _col is None:
        client = chromadb.PersistentClient(path=STORE)
        _col = client.get_collection(COLLECTION)
    return _col


def _expansion_terms(feedback_texts, query):
    """Most frequent contentful terms in the feedback chunks, minus query words."""
    query_words = set(re.findall(r"[a-z]+", query.lower()))
    counts = {}
    for text in feedback_texts:
        for word in re.findall(r"[a-z]{4,}", text.lower()):
            if word in STOPWORDS or word in query_words:
                continue
            counts[word] = counts.get(word, 0) + 1
    return sorted(counts, key=lambda w: (-counts[w], w))[:EXPANSION_TERMS]


def _expand(query):
    """Pseudo-relevance feedback: sharpen the query with terms from its own top hits."""
    seed = collection().query(query_texts=[query], n_results=FEEDBACK_K)
    terms = _expansion_terms(seed["documents"][0], query)
    expanded = query + " " + " ".join(terms) if terms else query
    if os.environ.get("ORCA_PAPER_DEBUG"):
        sys.stderr.write(f"prf expanded: {expanded!r}\n")
    return expanded


def search(query, k=3):
    res = collection().query(query_texts=[_expand(query)], n_results=k)
    out = []
    for text, meta, dist in zip(
        res["documents"][0], res["metadatas"][0], res["distances"][0]
    ):
        out.append({"text": text, "page": meta.get("page"), "distance": dist})
    return out

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

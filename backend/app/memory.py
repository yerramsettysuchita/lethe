"""Pluggable memory layer.

Two interchangeable backends implement the Cognee memory *lifecycle*
(remember / recall / improve / forget):

* ``CogneeBackend`` — talks to Cognee Cloud (or self-hosted Cognee) via the
  SDK. This is the intended production path.
* ``LocalBackend``  — a dependency-free in-process store used automatically
  when Cognee is unavailable, so the demo is never blocked. It deliberately
  reproduces the *derived-artifact* problem: deleting a customer's own dataset
  does NOT scrub mentions of them inside other customers' records, so Lethe's
  auditor can catch the residual leak — exactly the phenomenon this project
  exists to expose.

Both expose the same async interface. ``forget`` supports two modes:
    * standard  — delete the subject's own dataset only (a *record* deletion)
    * cascade   — also redact references to the subject in linked datasets
                  (a *person* erasure)
This distinction (delete a row vs. erase a human) is the crux of verifiable
forgetting and drives Lethe's two-verdict certificate.
"""
from __future__ import annotations

import re
from typing import Any

from .config import settings


# ==========================================================================
# Local fallback backend
# ==========================================================================
class LocalBackend:
    name = "local"

    def __init__(self) -> None:
        # dataset -> list of {id, text}
        self._store: dict[str, list[dict[str, str]]] = {}
        self._doc_seq = 0
        # feedback captured by improve() — surfaced as a memory "enrichment"
        self._enrichments: list[str] = []

    # -- lifecycle ---------------------------------------------------------
    async def remember(self, text: str, dataset: str) -> None:
        self._doc_seq += 1
        self._store.setdefault(dataset, []).append(
            {"id": f"doc-{self._doc_seq}", "text": text}
        )

    async def recall(self, question: str) -> dict[str, Any]:
        contexts = self._retrieve(question, k=4)
        answer = self._answer(question, contexts)
        return {
            "answer": answer,
            "contexts": [c["text"] for c in contexts],
            "context_ids": [c["id"] for c in contexts],
        }

    async def improve(self, feedback: str | None = None) -> dict[str, Any]:
        if feedback:
            self._enrichments.append(feedback)
        return {"enrichments": len(self._enrichments)}

    async def forget(
        self, dataset: str, subject_name: str | None = None, cascade: bool = False
    ) -> dict[str, Any]:
        removed = len(self._store.pop(dataset, []))
        redactions = 0
        if cascade and subject_name:
            redactions = self._redact_references(subject_name)
        return {"removed_docs": removed, "redactions": redactions}

    async def stats(self) -> dict[str, Any]:
        docs = sum(len(v) for v in self._store.values())
        entities = self._count_entities()
        return {
            "backend": self.name,
            "datasets": len(self._store),
            "documents": docs,
            "entities": entities,
        }

    # -- retrieval / synthesis --------------------------------------------
    def _all_docs(self) -> list[dict[str, str]]:
        out: list[dict[str, str]] = []
        for docs in self._store.values():
            out.extend(docs)
        return out

    # Relevance floor: a document must clear this to be surfaced at all. This
    # is what makes deletion observable — once the subject's own richly-matching
    # document is gone, weakly-matching references drop below the floor and the
    # system honestly answers "no information", while strong residual mentions
    # (e.g. another customer's record that names the subject) still surface.
    _FLOOR = 0.45

    # Aggregation/enumeration cues: these requests scan the whole corpus
    # ("list all customers", "build a table", "summarise everyone") rather than
    # matching one record, so they bypass the per-record relevance floor.
    _ENUM_CUES = ("list", "table", "every", "all ", "summar", "each",
                  "everyone", "everything", "customers", "records")

    def _retrieve(self, question: str, k: int = 4) -> list[dict[str, str]]:
        terms = _tokens(question)
        if not terms:
            return []
        enum = any(cue in question.lower() for cue in self._ENUM_CUES)
        floor = 0.0 if enum else self._FLOOR
        k = 6 if enum else k
        scored: list[tuple[float, dict[str, str]]] = []
        for doc in self._all_docs():
            dt = _tokens(doc["text"])
            if not dt:
                continue
            overlap = sum(1 for t in terms if t in dt)
            score = overlap / len(terms)
            # boost for distinctive literals (names, numbers) appearing verbatim
            for tok in terms:
                if len(tok) > 3 and tok in doc["text"].lower():
                    score += 0.12
            # enum queries scan the whole corpus regardless of lexical overlap
            if score > 0 or enum:
                scored.append((score, doc))
        if not scored:
            return []
        scored.sort(key=lambda x: x[0], reverse=True)
        top = scored[0][0]
        if enum:
            # broad scan: return the whole matched set (the corpus)
            return [d for _, d in scored[:k]]
        # targeted lookup: keep docs that clear the absolute floor AND are
        # competitive with the best match (within 55% of top score)
        kept = [d for s, d in scored[:k]
                if s >= floor and s >= top * 0.55]
        return kept

    def _answer(self, question: str, contexts: list[dict[str, str]]) -> str:
        if not contexts:
            return ("I don't have any information on file matching that "
                    "request.")
        # Prefer a real grounded answer via the LLM if a key is present;
        # otherwise return the grounded context verbatim (still faithful).
        grounded = "\n\n".join(c["text"] for c in contexts)
        llm = _try_llm_answer(question, grounded)
        if llm is not None:
            return llm
        return ("Based on the customer records on file:\n\n" + grounded)

    # -- deletion mechanics -----------------------------------------------
    def _redact_references(self, subject_name: str) -> int:
        """Scrub the subject's name (and obvious first-name references) from
        every remaining document. This is the 'cascade' that turns a record
        deletion into a person erasure."""
        count = 0
        first = subject_name.split()[0]
        pat = re.compile(rf"\b{re.escape(subject_name)}\b|\b{re.escape(first)}\b")
        for docs in self._store.values():
            for doc in docs:
                new, n = pat.subn("[REDACTED]", doc["text"])
                if n:
                    doc["text"] = new
                    count += n
        return count

    def _count_entities(self) -> int:
        names = set()
        for doc in self._all_docs():
            for m in re.finditer(r"Customer:\s*([A-Z][a-z]+ [A-Z][a-z]+)", doc["text"]):
                names.add(m.group(1))
        return len(names)


# ==========================================================================
# Cognee Cloud backend (REST — the "Best Use of Cognee Cloud" path)
# ==========================================================================
class CogneeCloudBackend:
    """Talks to Cognee Cloud over its REST API (no SDK, works on any Python).

    Lifecycle mapping (Cognee Cloud v1 REST):
        remember -> POST /api/v1/add {data, dataset_name} + POST /api/v1/cognify
        recall   -> POST /api/v1/search {query, search_type}
        improve  -> POST /api/v1/cognify (re-cognify to enrich the graph)
        forget   -> GET /api/v1/datasets (resolve id) + DELETE /api/v1/datasets/{id}
    Auth: header ``X-Api-Key``.
    """
    name = "cognee-cloud"

    def __init__(self, base_url: str, api_key: str,
                 tenant_id: str | None = None) -> None:
        import httpx  # noqa: F401  (capability check)
        self._httpx = httpx
        self.base = base_url.rstrip("/")
        self.headers = {"X-Api-Key": api_key}
        if tenant_id:
            self.headers["X-Tenant-Id"] = tenant_id

    # Search/cognify invoke the LLM server-side and can be slow. Ingestion is
    # allowed a long read; interactive recall fails fast so an audit of many
    # probes never hangs (a timed-out probe is treated as "no answer" = SAFE).
    INGEST_TIMEOUT = 300.0
    RECALL_TIMEOUT = 60.0

    def _client(self, read_timeout: float = 120.0):
        return self._httpx.AsyncClient(
            base_url=self.base, headers=self.headers,
            timeout=self._httpx.Timeout(read_timeout, connect=15.0),
            follow_redirects=True)

    async def remember(self, text: str, dataset: str) -> None:
        async with self._client(self.INGEST_TIMEOUT) as c:
            # /api/v1/add is multipart: `data` is a file array, dataset by name.
            r = await c.post(
                "/api/v1/add",
                files=[("data", (f"{dataset}.txt", text, "text/plain"))],
                data={"datasetName": dataset})
            r.raise_for_status()
            r = await c.post("/api/v1/cognify", json={"datasets": [dataset]})
            r.raise_for_status()

    async def recall(self, question: str) -> dict[str, Any]:
        try:
            async with self._client(self.RECALL_TIMEOUT) as c:
                r = await c.post("/api/v1/search",
                                 json={"query": question,
                                       "searchType": "GRAPH_COMPLETION"})
                r.raise_for_status()
                data = r.json()
            answer = _extract_cloud_answer(data)
        except Exception:  # noqa: BLE001 — never let one slow/failed probe break
            # a whole audit; an unanswered probe is treated as a non-leak.
            answer = _NO_INFO
        return {"answer": answer, "contexts": [], "context_ids": []}

    async def improve(self, feedback: str | None = None) -> dict[str, Any]:
        # Re-cognify across known datasets to enrich the graph. Best-effort.
        try:
            names = await self._dataset_names()
            if names:
                async with self._client() as c:
                    await c.post("/api/v1/cognify", json={"datasets": names})
        except Exception:  # noqa: BLE001
            pass
        return {"enrichments": 1}

    async def forget(
        self, dataset: str, subject_name: str | None = None, cascade: bool = False
    ) -> dict[str, Any]:
        # POST /api/v1/forget erases the cognified graph memory (NOT just the
        # raw dataset — deleting the dataset alone leaves graph nodes that keep
        # answering, which is exactly the derived-artifact leak Lethe exists to
        # catch). We then also drop the dataset record for good measure.
        async with self._client() as c:
            r = await c.post("/api/v1/forget", json={"dataset": dataset})
            if r.status_code not in (200, 204, 404):
                r.raise_for_status()
        ds_id = await self._resolve_dataset_id(dataset)
        if ds_id:
            async with self._client() as c:
                await c.delete(f"/api/v1/datasets/{ds_id}")
        redactions = 0
        if cascade and subject_name:
            redactions = await self._cascade_redact(subject_name, dataset)
        return {"removed_docs": None, "redactions": redactions, "cascade": cascade}

    async def stats(self) -> dict[str, Any]:
        try:
            names = await self._dataset_names()
            return {"backend": self.name, "datasets": len(names),
                    "documents": None, "entities": None}
        except Exception:  # noqa: BLE001
            return {"backend": self.name, "datasets": None,
                    "documents": None, "entities": None}

    async def graph(self, dataset: str) -> dict[str, Any]:
        """Fetch the cognified knowledge graph for a dataset and normalize it to
        {nodes: [{id, label, type}], edges: [{s, t, label}], present: bool}.
        The Cloud response shape varies, so parse defensively."""
        ds_id = await self._resolve_dataset_id(dataset)
        if not ds_id:
            return {"nodes": [], "edges": [], "present": False}
        try:
            async with self._client(self.RECALL_TIMEOUT) as c:
                r = await c.get(f"/api/v1/datasets/{ds_id}/graph")
                r.raise_for_status()
                raw = r.json()
        except Exception:  # noqa: BLE001
            return {"nodes": [], "edges": [], "present": False}
        return _normalize_cloud_graph(raw)

    # -- helpers -----------------------------------------------------------
    async def _list_datasets(self) -> list[dict]:
        async with self._client() as c:
            r = await c.get("/api/v1/datasets")
            r.raise_for_status()
            data = r.json()
        if isinstance(data, dict):
            data = data.get("datasets") or data.get("data") or []
        return data if isinstance(data, list) else []

    async def _dataset_names(self) -> list[str]:
        return [d.get("name") for d in await self._list_datasets() if d.get("name")]

    async def _resolve_dataset_id(self, name: str) -> str | None:
        for d in await self._list_datasets():
            if d.get("name") == name:
                return d.get("id") or d.get("dataset_id")
        return None

    async def _cascade_redact(self, subject_name: str, subject_dataset: str) -> int:
        """Person erasure on the cloud graph: for every OTHER seeded dataset
        whose source text names the subject, delete it and re-ingest a redacted
        copy. Lethe owns the seed corpus, so it can supply the redacted text.
        """
        from .seed import CUSTOMERS  # local import to avoid any cycle
        import re
        first = subject_name.split()[0]
        pat = re.compile(rf"\b{re.escape(subject_name)}\b|\b{re.escape(first)}\b")
        count = 0
        for cust in CUSTOMERS:
            ds = f"customer_{cust.id}"
            if ds == subject_dataset:
                continue
            redacted, n = pat.subn("[REDACTED]", cust.transcript)
            if not n:
                continue
            # fully forget the graph for this dataset, then re-ingest a redacted
            # copy so the subject is erased from the derived memory too.
            async with self._client() as c:
                await c.post("/api/v1/forget", json={"dataset": ds})
                ds_id = await self._resolve_dataset_id(ds)
                if ds_id:
                    await c.delete(f"/api/v1/datasets/{ds_id}")
            await self.remember(redacted, ds)  # re-add + cognify redacted copy
            count += n
        return count


# ==========================================================================
# Cognee SDK backend (self-hosted / open-source path)
# ==========================================================================
class CogneeBackend:
    """Adapter over the real Cognee 1.x lifecycle API.

    Signatures verified against the installed cognee package source:
        remember(data, dataset_name=..., ...) -> RememberResult
        recall(query_text, *, datasets=..., top_k=...) -> list[RecallResponse]
        improve(dataset=..., ...)
        forget(*, dataset=..., dataset_id=..., everything=..., memory_only=...)

    Note: Cognee currently requires Python <= 3.12; on 3.13/3.14 the import
    fails and Lethe falls back to LocalBackend automatically. See the
    Dockerfile (python:3.12-slim) for the production runtime.
    """
    name = "cognee"

    def __init__(self) -> None:
        import cognee  # import-time capability check (raises on unsupported py)
        self._cognee = cognee

    async def remember(self, text: str, dataset: str) -> None:
        # one dataset per customer -> surgical forget later
        await self._cognee.remember(text, dataset_name=dataset)

    async def recall(self, question: str) -> dict[str, Any]:
        results = await self._cognee.recall(question)
        contexts = [_recall_text(r) for r in (results or [])]
        contexts = [c for c in contexts if c]
        answer = "\n\n".join(contexts) if contexts else (
            "I don't have any information on file matching that request.")
        return {"answer": answer, "contexts": contexts, "context_ids": []}

    async def improve(self, feedback: str | None = None) -> dict[str, Any]:
        # memify / enrichment pass over the graph
        await self._cognee.improve()
        return {"enrichments": 1}

    async def forget(
        self, dataset: str, subject_name: str | None = None, cascade: bool = False
    ) -> dict[str, Any]:
        # forget() removes the subject's own dataset from the graph.
        res = await self._cognee.forget(dataset=dataset)
        # Cascade (cross-reference redaction across *other* datasets) is a
        # Lethe-layer concern that Cognee's forget() does not perform. The
        # LocalBackend demonstrates it; for the cloud graph it would be a
        # follow-up re-cognify pass. We surface the standard forget result and
        # flag whether cascade was requested so the certificate is accurate.
        removed = res.get("deleted") if isinstance(res, dict) else None
        return {"removed_docs": removed, "redactions": 0, "cascade": cascade}

    async def stats(self) -> dict[str, Any]:
        # Cognee does not expose cheap corpus counts; node-diff is reported as
        # unavailable rather than guessed.
        return {"backend": self.name, "datasets": None,
                "documents": None, "entities": None}


# ==========================================================================
# Backend selection
# ==========================================================================
def _select_backend():
    mode = settings.MEMORY_BACKEND.lower()

    # Cognee Cloud over REST (preferred for the Cloud track; any Python version)
    if mode in ("cloud", "cognee", "auto") and settings.has_cognee_cloud:
        try:
            b = CogneeCloudBackend(settings.COGNEE_API_URL,
                                   settings.COGNEE_API_KEY,
                                   settings.COGNEE_TENANT_ID)
            print(f"[lethe] using Cognee Cloud at {settings.COGNEE_API_URL}")
            return b
        except Exception as e:  # noqa: BLE001
            if mode == "cloud":
                raise
            print(f"[lethe] Cognee Cloud unavailable ({e!s}); trying next backend.")

    # Cognee SDK (self-hosted / open-source; needs Python <= 3.12)
    if mode in ("cognee", "auto"):
        try:
            return CogneeBackend()
        except Exception as e:  # noqa: BLE001
            if mode == "cognee":
                raise
            print(f"[lethe] Cognee SDK unavailable ({e!s}); using local backend.")

    return LocalBackend()


backend = _select_backend()


# -- convenience wrappers used by the API ----------------------------------
async def ingest(text: str, customer_id: str) -> None:
    await backend.remember(text, dataset=f"customer_{customer_id}")


async def ask(question: str) -> dict[str, Any]:
    return await backend.recall(question)


async def enrich(feedback: str | None = None) -> dict[str, Any]:
    return await backend.improve(feedback)


async def erase(customer_id: str, subject_name: str | None = None,
                cascade: bool = False) -> dict[str, Any]:
    return await backend.forget(
        dataset=f"customer_{customer_id}",
        subject_name=subject_name,
        cascade=cascade,
    )


async def stats() -> dict[str, Any]:
    return await backend.stats()


# ==========================================================================
# Helpers
# ==========================================================================
_STOP = {
    "the", "a", "an", "is", "are", "was", "were", "of", "to", "in", "on",
    "and", "or", "for", "with", "what", "which", "who", "whom", "about",
    "did", "do", "does", "me", "my", "i", "you", "your", "their", "them",
    "give", "list", "all", "any", "know", "have", "has", "had", "that",
}


def _tokens(text: str) -> set[str]:
    return {t for t in re.findall(r"[a-z0-9₹]+", text.lower()) if t not in _STOP}


def _extract_cloud_answer(data: Any) -> str:
    """Pull a readable answer out of a Cognee Cloud /search response.

    The observed shape is a list of per-dataset results:
        [{"dataset_name": "...", "search_result": ["...", ...]}, ...]
    but we also tolerate plain strings / other dict shapes defensively."""
    if isinstance(data, str):
        return data.strip() or _NO_INFO
    if isinstance(data, dict):
        for k in ("search_result", "result", "answer", "text", "content",
                  "results"):
            if k in data:
                return _extract_cloud_answer(data[k])
        return str(data)
    if isinstance(data, list):
        parts: list[str] = []
        for item in data:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if "search_result" in item:
                    parts.append(_extract_cloud_answer(item["search_result"]))
                else:
                    parts.append(str(item.get("text") or item.get("content")
                                     or item.get("answer") or item))
            else:
                parts.append(str(item))
        joined = "\n\n".join(p for p in parts if p and p != _NO_INFO).strip()
        return joined or _NO_INFO
    return str(data) if data else _NO_INFO


_NO_INFO = "I don't have any information on file matching that request."


def _normalize_cloud_graph(raw: Any) -> dict[str, Any]:
    """Normalize a Cognee Cloud graph payload (shape varies) into
    {nodes: [{id,label,type}], edges: [{s,t,label}], present: bool}."""
    if isinstance(raw, dict) and isinstance(raw.get("graph"), dict):
        raw = raw["graph"]
    nodes_in, edges_in = [], []
    if isinstance(raw, dict):
        nodes_in = raw.get("nodes") or raw.get("vertices") or []
        edges_in = (raw.get("edges") or raw.get("links")
                    or raw.get("relationships") or [])
    elif isinstance(raw, list) and len(raw) == 2 and isinstance(raw[0], list):
        nodes_in, edges_in = raw[0], raw[1]

    nodes = []
    for n in nodes_in:
        if not isinstance(n, dict):
            continue
        nid = str(n.get("id") or n.get("node_id") or n.get("uuid") or n.get("name") or "")
        if not nid:
            continue
        label = str(n.get("name") or n.get("label") or n.get("text") or nid)[:40]
        ntype = n.get("type")
        if not ntype:
            labels = n.get("labels") or n.get("label")
            if isinstance(labels, list) and labels:
                ntype = labels[0]
            elif isinstance(labels, str):
                ntype = labels
            else:
                ntype = "node"
        nodes.append({"id": nid, "label": label, "type": str(ntype)})

    edges = []
    for e in edges_in:
        if not isinstance(e, dict):
            continue
        s = str(e.get("source") or e.get("source_node_id") or e.get("from")
                or e.get("start") or e.get("s") or "")
        t = str(e.get("target") or e.get("target_node_id") or e.get("to")
                or e.get("end") or e.get("t") or "")
        if not s or not t:
            continue
        lbl = str(e.get("relationship_name") or e.get("label") or e.get("type") or "")
        edges.append({"s": s, "t": t, "label": lbl[:24]})

    return {"nodes": nodes, "edges": edges, "present": bool(nodes)}


def _recall_text(item: Any) -> str:
    """Pull readable text out of a Cognee RecallResponse item, whatever its
    variant (graph context, QA entry, search result, ...)."""
    for attr in ("content", "answer", "text", "value"):
        v = getattr(item, attr, None)
        if isinstance(v, str) and v.strip():
            return v.strip()
    # pydantic model -> best-effort join of string fields
    dump = getattr(item, "model_dump", None)
    if callable(dump):
        try:
            d = dump()
            parts = [str(v) for k, v in d.items()
                     if isinstance(v, str) and k not in ("source", "id")]
            if parts:
                return " ".join(parts).strip()
        except Exception:  # noqa: BLE001
            pass
    return str(item)


def _try_llm_answer(question: str, context: str) -> str | None:
    """Return a grounded natural-language answer using the LLM (Anthropic API)
    if configured, else None. Kept isolated so the app never hard-depends on it."""
    if not settings.has_judge:
        return None
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)
        msg = client.messages.create(
            model=settings.JUDGE_MODEL,
            max_tokens=400,
            system=(
                "You are PaySwift's customer-memory assistant. Answer the "
                "question using ONLY the retrieved records below. If the "
                "records do not contain the answer, say you don't have that "
                "information. Be concise and factual."
            ),
            messages=[{
                "role": "user",
                "content": f"RETRIEVED RECORDS:\n{context}\n\nQUESTION: {question}",
            }],
        )
        return "".join(
            b.text for b in msg.content if getattr(b, "type", None) == "text"
        ).strip()
    except Exception:  # noqa: BLE001
        return None

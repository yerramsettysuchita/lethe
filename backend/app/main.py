"""Lethe API — FastAPI app that also serves the frontend.

Endpoints map onto the Cognee memory lifecycle plus Lethe's audit layer:

    remember / recall / improve / forget   -> memory lifecycle
    /api/audit/run                          -> adversarial probe battery
    /api/erase-and-verify                   -> the full polygraph (the product)
    /api/certificate/verify                 -> re-check a signed certificate
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auditor, certificate, memory
from .config import settings
from .seed import CUSTOMERS, get_customer

app = FastAPI(title="Lethe API", version="2.0.0",
              description="The polygraph for AI memory — verifiable deletion.")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"],
    allow_methods=["*"], allow_headers=["*"],
)

# In-memory demo state (Cognee is the real store; this only holds audit trails).
AUDITS: dict[str, dict[str, Any]] = {}          # customer_id -> {baseline, post}
CERTS: dict[str, dict[str, Any]] = {}           # cert_id -> {cert, before, after}
SEEDED = {"done": False}


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------
class IngestReq(BaseModel):
    text: str
    customer_id: str


class AskReq(BaseModel):
    question: str


class ImproveReq(BaseModel):
    feedback: str | None = None


# --------------------------------------------------------------------------
# Meta
# --------------------------------------------------------------------------
@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "memory_backend": memory.backend.name,
        "judge": "llm" if settings.has_judge else "heuristic",
    }


@app.get("/api/customers")
async def customers() -> dict[str, Any]:
    return {
        "seeded": SEEDED["done"],
        "customers": [
            {"id": c.id, "name": c.name, "city": c.city,
             "complaint": c.complaint, "amount": c.amount,
             "linked_to": c.linked_to,
             "audited": c.id in AUDITS,
             "forgotten": c.id in AUDITS and "post" in AUDITS[c.id]}
            for c in CUSTOMERS
        ],
    }


@app.get("/api/stats")
async def stats() -> dict[str, Any]:
    return await memory.stats()


# --------------------------------------------------------------------------
# Memory lifecycle
# --------------------------------------------------------------------------
@app.post("/api/seed")
async def seed() -> dict[str, Any]:
    for c in CUSTOMERS:
        await memory.ingest(c.transcript, c.id)
    SEEDED["done"] = True
    return {"status": "seeded", "count": len(CUSTOMERS), **(await memory.stats())}


@app.post("/api/remember")
async def remember(req: IngestReq) -> dict[str, Any]:
    await memory.ingest(req.text, req.customer_id)
    return {"status": "remembered", "dataset": f"customer_{req.customer_id}"}


@app.post("/api/recall")
async def recall(req: AskReq) -> dict[str, Any]:
    return await memory.ask(req.question)


@app.post("/api/improve")
async def improve(req: ImproveReq) -> dict[str, Any]:
    result = await memory.enrich(req.feedback)
    return {"status": "memory improved (memify)", **result}


@app.post("/api/forget/{customer_id}")
async def forget(customer_id: str, cascade: bool = False) -> dict[str, Any]:
    c = get_customer(customer_id)
    result = await memory.erase(
        customer_id, subject_name=c.name if c else None, cascade=cascade)
    return {"status": "forgotten", "dataset": f"customer_{customer_id}",
            "cascade": cascade, **result}


# --------------------------------------------------------------------------
# Audit layer
# --------------------------------------------------------------------------
@app.post("/api/audit/run/{customer_id}")
async def run_audit(customer_id: str, phase: str = "baseline") -> dict[str, Any]:
    if get_customer(customer_id) is None:
        raise HTTPException(404, f"unknown customer {customer_id}")
    result = await auditor.run_battery(customer_id, phase=phase)
    AUDITS.setdefault(customer_id, {})["baseline" if phase == "baseline"
                                       else "post"] = result
    return result


@app.post("/api/erase-and-verify/{customer_id}")
async def erase_and_verify(customer_id: str, cascade: bool = False) -> dict[str, Any]:
    """The polygraph. Baseline audit (reused if already run) -> forget ->
    identical re-audit -> signed, Merkle-bound certificate."""
    c = get_customer(customer_id)
    if c is None:
        raise HTTPException(404, f"unknown customer {customer_id}")

    # 1. baseline (reuse if the UI already ran it, else run now)
    before = AUDITS.get(customer_id, {}).get("baseline")
    if before is None:
        before = await auditor.run_battery(customer_id, phase="baseline")
        AUDITS.setdefault(customer_id, {})["baseline"] = before

    stats_before = await memory.stats()

    # 2. forget
    erase_res = await memory.erase(customer_id, subject_name=c.name, cascade=cascade)

    stats_after = await memory.stats()
    node_diff = {
        "documents_before": stats_before.get("documents"),
        "documents_after": stats_after.get("documents"),
        "entities_before": stats_before.get("entities"),
        "entities_after": stats_after.get("entities"),
        "redactions": erase_res.get("redactions", 0),
    }

    # 3. identical re-audit
    after = await auditor.run_battery(customer_id, phase="post-erasure")
    AUDITS[customer_id]["post"] = after

    # 4. certificate
    method = (f"cognee.forget(dataset=customer_{customer_id})"
              + ("  +  cascade reference redaction" if cascade else ""))
    cert = certificate.build_certificate(
        before, after, method=method, cascade=cascade, node_diff=node_diff)
    CERTS[cert["certificate_id"]] = {"cert": cert, "before": before, "after": after}

    return {"before": before, "after": after, "erase": erase_res,
            "certificate": cert}


@app.post("/api/cloud/selftest")
async def cloud_selftest(customer_id: str = "019") -> dict[str, Any]:
    """Live proof of verifiable deletion on real Cognee Cloud (fast, single
    subject): remember -> recall (leaks) -> forget -> recall (silent). Returns
    the actual before/after answers from the cloud graph."""
    if not settings.has_cognee_cloud:
        raise HTTPException(400, "Cognee Cloud not configured (set "
                                 "COGNEE_API_URL + COGNEE_API_KEY).")
    c = get_customer(customer_id)
    if c is None:
        raise HTTPException(404, f"unknown customer {customer_id}")
    cloud = memory.CogneeCloudBackend(
        settings.COGNEE_API_URL, settings.COGNEE_API_KEY, settings.COGNEE_TENANT_ID)
    ds = f"selftest_{customer_id}"
    probe = f"What did {c.name} complain about and what is their phone number?"
    await cloud.remember(c.transcript, ds)
    before = (await cloud.recall(probe))["answer"]
    await cloud.forget(ds, subject_name=c.name, cascade=False)
    after = (await cloud.recall(probe))["answer"]
    subject_present_before = c.name.lower() in before.lower()
    subject_present_after = c.name.lower() in after.lower()
    return {
        "backend": "cognee-cloud",
        "endpoint": settings.COGNEE_API_URL,
        "subject": c.name,
        "probe": probe,
        "answer_before_forget": before,
        "answer_after_forget": after,
        "leaked_before": subject_present_before,
        "leaked_after": subject_present_after,
        "erasure_verified": subject_present_before and not subject_present_after,
    }


class VerifyReq(BaseModel):
    certificate: dict[str, Any]


@app.post("/api/certificate/verify")
async def verify_cert(req: VerifyReq) -> dict[str, Any]:
    cert = req.certificate
    stored = CERTS.get(cert.get("certificate_id", ""))
    before = stored["before"] if stored else None
    after = stored["after"] if stored else None
    return certificate.verify_certificate(cert, before, after)


# --------------------------------------------------------------------------
# Static frontend (served last so /api/* wins)
# --------------------------------------------------------------------------
_STATIC = Path(__file__).resolve().parent.parent / "static"
if _STATIC.exists():
    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(_STATIC / "index.html")

    app.mount("/", StaticFiles(directory=str(_STATIC), html=True), name="static")

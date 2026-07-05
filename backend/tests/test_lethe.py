"""Lethe test suite.

Runs entirely on the local memory backend + heuristic judge, so it needs no
API keys and no network. Exercises the memory lifecycle, the adversarial
auditor, the certificate crypto, and the full HTTP API.

    cd backend && pytest -q
"""
import asyncio
import json
import os

# Force a hermetic, deterministic run: local memory + heuristic judge, no
# network. Setting these to empty (rather than deleting) means the .env loaded
# by config.load_dotenv() will NOT override them (python-dotenv override=False),
# so tests never hit a live API even when real keys are present in .env.
os.environ["LETHE_MEMORY_BACKEND"] = "local"
os.environ["ANTHROPIC_API_KEY"] = ""
os.environ["COGNEE_API_KEY"] = ""
os.environ["COGNEE_API_URL"] = ""

import pytest
from fastapi.testclient import TestClient

from app import auditor, certificate, memory
from app.seed import CUSTOMERS, build_probes, get_customer


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def fresh_backend():
    """Give every test a clean, freshly-seeded local memory."""
    memory.backend = memory.LocalBackend()
    for c in CUSTOMERS:
        run(memory.ingest(c.transcript, c.id))
    yield


# --------------------------------------------------------------------------
# Memory lifecycle
# --------------------------------------------------------------------------
def test_seed_populates_memory():
    stats = run(memory.stats())
    assert stats["documents"] == len(CUSTOMERS)
    assert stats["datasets"] == len(CUSTOMERS)


def test_recall_returns_relevant_pii_before_deletion():
    r = run(memory.ask("What is Ravi Sharma's phone number?"))
    assert "Ravi Sharma" in r["answer"]
    assert "+91-98450-11237" in r["answer"]


def test_forget_removes_own_dataset():
    run(memory.erase("003", subject_name="Ravi Sharma", cascade=False))
    stats = run(memory.stats())
    assert stats["documents"] == len(CUSTOMERS) - 1


def test_cascade_redacts_cross_references():
    # Rohit's record mentions Ravi by name; cascade must scrub it.
    run(memory.erase("003", subject_name="Ravi Sharma", cascade=True))
    r = run(memory.ask("Which customers had the same issue as Ravi Sharma?"))
    assert "Ravi Sharma" not in r["answer"]


# --------------------------------------------------------------------------
# Probe battery
# --------------------------------------------------------------------------
def test_probe_battery_is_fifteen_and_four_classes():
    probes = build_probes(get_customer("003"))
    assert len(probes) == 15
    assert {p["class"] for p in probes} == {
        "direct", "inference", "reconstruction", "relational"}


def test_probes_are_frozen_deterministic():
    a = [p["text"] for p in build_probes(get_customer("003"))]
    b = [p["text"] for p in build_probes(get_customer("003"))]
    assert a == b  # identical battery, or before/after comparison is meaningless


# --------------------------------------------------------------------------
# Auditor
# --------------------------------------------------------------------------
def test_baseline_audit_leaks_everything():
    res = run(auditor.run_battery("003", "baseline"))
    assert res["total"] == 15
    assert res["leaks"] == 15
    assert res["contamination_score"] == 100


def test_cascade_erasure_reaches_zero_leaks():
    run(auditor.run_battery("003", "baseline"))
    run(memory.erase("003", subject_name="Ravi Sharma", cascade=True))
    after = run(auditor.run_battery("003", "post"))
    assert after["leaks"] == 0
    assert after["contamination_score"] == 0


def test_standard_deletion_leaves_residual_references():
    run(auditor.run_battery("003", "baseline"))
    run(memory.erase("003", subject_name="Ravi Sharma", cascade=False))
    after = run(auditor.run_battery("003", "post"))
    assert 0 < after["leaks"] < 15  # honest: some, not all, references survive


# --------------------------------------------------------------------------
# Certificate crypto
# --------------------------------------------------------------------------
def _make_cert(cascade):
    # independent, freshly-seeded memory so repeated calls don't interfere
    memory.backend = memory.LocalBackend()
    for c in CUSTOMERS:
        run(memory.ingest(c.transcript, c.id))
    before = run(auditor.run_battery("003", "baseline"))
    run(memory.erase("003", subject_name="Ravi Sharma", cascade=cascade))
    after = run(auditor.run_battery("003", "post"))
    cert = certificate.build_certificate(
        before, after, method="test", cascade=cascade)
    return before, after, cert


def test_certificate_verdict_matches_outcome():
    _, _, cert = _make_cert(cascade=True)
    assert cert["verdict"] == "ERASURE VERIFIED"
    _, _, cert2 = _make_cert(cascade=False)
    assert cert2["verdict"].startswith("ERASURE INCOMPLETE")


def test_valid_signature_and_merkle_roundtrip():
    before, after, cert = _make_cert(cascade=True)
    v = certificate.verify_certificate(cert, before, after)
    assert v["signature_valid"] is True
    assert v["merkle_valid"] is True
    assert v["valid"] is True


def test_tampering_breaks_signature():
    before, after, cert = _make_cert(cascade=True)
    tampered = json.loads(json.dumps(cert))
    # forge a clean bill of health where there wasn't one
    tampered["verification"]["leaks_before"] = 0
    tampered["data_subject_name"] = "Someone Else"
    v = certificate.verify_certificate(tampered, before, after)
    assert v["signature_valid"] is False
    assert v["valid"] is False


def test_merkle_detects_evidence_tampering():
    before, after, cert = _make_cert(cascade=True)
    # forge the audit trail: rewrite a probe's recorded response
    forged_after = json.loads(json.dumps(after))
    forged_after["results"][0]["response"] = "forged clean response"
    forged_after["results"][0]["verdict"] = "SAFE-FORGED"
    v = certificate.verify_certificate(cert, before, forged_after)
    assert v["merkle_valid"] is False


# --------------------------------------------------------------------------
# HTTP API
# --------------------------------------------------------------------------
@pytest.fixture
def client():
    import app.main as m
    memory.backend = memory.LocalBackend()
    m.AUDITS.clear(); m.CERTS.clear(); m.SEEDED["done"] = False
    c = TestClient(m.app)
    c.post("/api/seed")
    return c


def test_health(client):
    h = client.get("/api/health").json()
    assert h["status"] == "ok"
    assert h["memory_backend"] == "local"


def test_api_recall(client):
    r = client.post("/api/recall", json={"question": "What did Ravi Sharma complain about?"}).json()
    assert "Ravi Sharma" in r["answer"]


def test_api_audit_run(client):
    r = client.post("/api/audit/run/003?phase=baseline").json()
    assert r["leaks"] == 15


def test_api_erase_and_verify_cascade(client):
    r = client.post("/api/erase-and-verify/003?cascade=true").json()
    assert r["before"]["leaks"] == 15
    assert r["after"]["leaks"] == 0
    assert r["certificate"]["verdict"] == "ERASURE VERIFIED"


def test_api_erase_and_verify_standard_incomplete(client):
    # Ravi (003) is named inside Rohit's record, so standard record-deletion
    # leaves residual references that the auditor catches.
    r = client.post("/api/erase-and-verify/003?cascade=false").json()
    assert r["after"]["leaks"] >= 1
    assert r["certificate"]["verdict"].startswith("ERASURE INCOMPLETE")


def test_api_certificate_verify_roundtrip(client):
    cert = client.post("/api/erase-and-verify/003?cascade=true").json()["certificate"]
    v = client.post("/api/certificate/verify", json={"certificate": cert}).json()
    assert v["valid"] is True
    # tamper and re-check
    cert["verdict"] = "FAKE"
    v2 = client.post("/api/certificate/verify", json={"certificate": cert}).json()
    assert v2["signature_valid"] is False

"""Tamper-evident Deletion Certificate.

A forget() call is not proof. Lethe issues a certificate that is:

* **Evidence-bound** — every probe (question, pre/post response, verdicts) is
  hashed into a Merkle tree; the root is embedded in the certificate. Change
  any single probe result and the root no longer matches.
* **Signed** — the certificate body is signed with HMAC-SHA256 over a
  canonical JSON serialization. Alter any field and the signature breaks.
* **Independently verifiable** — ``verify_certificate`` recomputes both the
  Merkle root and the signature and reports exactly which invariant failed.

This turns "we deleted it, trust us" into a portable, re-checkable artifact a
regulator could audit.
"""
from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timezone, timedelta
from typing import Any

from .config import settings

IST = timezone(timedelta(hours=5, minutes=30))

ERASURE_BASIS = "GDPR Art. 17 · India DPDP Act 2023 §12"
DISCLAIMER = ("Demonstration artifact produced for a hackathon. Not legal "
              "advice and not a substitute for a controller's own compliance "
              "processes.")


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _merkle_root(leaves: list[str]) -> str:
    """Bottom-up SHA-256 Merkle root. Empty -> hash of empty string."""
    if not leaves:
        return _sha("")
    level = [_sha(x) for x in leaves]
    while len(level) > 1:
        if len(level) % 2 == 1:
            level.append(level[-1])  # duplicate last (standard padding)
        level = [_sha(level[i] + level[i + 1]) for i in range(0, len(level), 2)]
    return level[0]


def _evidence_leaves(before: dict, after: dict) -> list[str]:
    """One deterministic leaf per probe, binding the before/after outcome."""
    after_by_id = {r["id"]: r for r in after["results"]}
    leaves: list[str] = []
    for b in before["results"]:
        a = after_by_id.get(b["id"], {})
        record = {
            "id": b["id"],
            "class": b["class"],
            "probe": b["probe"],
            "before_verdict": b["verdict"],
            "before_response_sha": _sha(b["response"]),
            "after_verdict": a.get("verdict", "MISSING"),
            "after_response_sha": _sha(a.get("response", "")),
        }
        leaves.append(json.dumps(record, sort_keys=True, ensure_ascii=False))
    return leaves


def _canonical(body: dict[str, Any]) -> str:
    return json.dumps(body, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":"))


def _sign(body: dict[str, Any]) -> str:
    return hmac.new(
        settings.SIGNING_SECRET.encode("utf-8"),
        _canonical(body).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


_SEQ = {"n": 0}


def build_certificate(
    before: dict, after: dict, *, method: str, cascade: bool,
    node_diff: dict | None = None,
) -> dict[str, Any]:
    _SEQ["n"] += 1
    now = datetime.now(IST)
    residual = [
        {"id": r["id"], "class": r["class"], "probe": r["probe"],
         "evidence": r["evidence"]}
        for r in after["results"] if r["verdict"] == "LEAK"
    ]
    verified = len(residual) == 0
    merkle_root = _merkle_root(_evidence_leaves(before, after))

    body: dict[str, Any] = {
        "certificate_id": f"LETHE-{now:%Y%m%d}-{_SEQ['n']:04d}",
        "issuer": settings.ISSUER,
        "data_subject": before["customer_id"],
        "data_subject_name": before["customer_name"],
        "erasure_basis": ERASURE_BASIS,
        "executed_at": now.isoformat(),
        "method": method,
        "erasure_mode": "cascade (person erasure)" if cascade
        else "standard (record deletion)",
        "verification": {
            "probe_battery": before["total"],
            "attack_classes": sorted({r["class"] for r in before["results"]}),
            "leaks_before": before["leaks"],
            "leaks_after": after["leaks"],
            "contamination_before": before["contamination_score"],
            "contamination_after": after["contamination_score"],
            "judge": before["judge"],
            "node_diff": node_diff or {},
            "residual_leaks": residual,
        },
        "verdict": "ERASURE VERIFIED" if verified
        else "ERASURE INCOMPLETE — RESIDUAL REFERENCES DETECTED",
        "evidence_merkle_root": merkle_root,
        "disclaimer": DISCLAIMER,
    }
    body["signature"] = {
        "algorithm": "HMAC-SHA256",
        "value": _sign(body),
        "signed_at": now.isoformat(),
    }
    return body


def verify_certificate(cert: dict[str, Any],
                       before: dict | None = None,
                       after: dict | None = None) -> dict[str, Any]:
    """Recompute the signature (always) and the Merkle root (if the raw audits
    are supplied). Reports which invariant, if any, is broken."""
    sig = cert.get("signature", {})
    provided = sig.get("value", "")
    body = {k: v for k, v in cert.items() if k != "signature"}
    expected = _sign(body)
    signature_valid = hmac.compare_digest(provided, expected)

    merkle_valid: bool | None = None
    if before is not None and after is not None:
        merkle_valid = (
            cert.get("evidence_merkle_root")
            == _merkle_root(_evidence_leaves(before, after))
        )

    valid = signature_valid and (merkle_valid is not False)
    return {
        "valid": valid,
        "signature_valid": signature_valid,
        "merkle_valid": merkle_valid,
        "expected_signature": expected,
        "checked_at": datetime.now(IST).isoformat(),
    }

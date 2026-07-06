"""Central configuration + capability detection.

Lethe is designed to *degrade gracefully*. It probes its environment at
startup and picks the strongest available backend for each capability, so a
demo works whether or not Cognee Cloud and the Anthropic API are reachable.
"""
from __future__ import annotations

import os
from dotenv import load_dotenv

# On Vercel (serverless), do NOT read a bundled .env file: secrets belong in the
# platform's environment, and the LLM/cloud paths exceed serverless time limits.
# This keeps the Vercel deployment on the fast, deterministic local engine.
# Locally (VERCEL unset), .env is loaded normally for the full experience.
if not os.getenv("VERCEL"):
    load_dotenv()


class Settings:
    # ---- Memory backend ----------------------------------------------------
    # "auto"   -> use Cognee if importable + configured, else local fallback
    # "cognee" -> force Cognee (raises if unavailable)
    # "local"  -> force the built-in in-process memory
    MEMORY_BACKEND: str = os.getenv("LETHE_MEMORY_BACKEND", "auto")

    COGNEE_API_KEY: str | None = os.getenv("COGNEE_API_KEY")
    # Cognee Cloud tenant base URL, e.g. https://<tenant>.aws.cognee.ai
    # (found on the Cognee Cloud "API Keys" page). When this + COGNEE_API_KEY
    # are set, Lethe talks to Cognee Cloud over REST — no SDK, any Python.
    COGNEE_API_URL: str | None = os.getenv("COGNEE_API_URL")
    # Cognee Cloud requires the tenant id alongside the API key.
    COGNEE_TENANT_ID: str | None = os.getenv("COGNEE_TENANT_ID")

    @property
    def has_cognee_cloud(self) -> bool:
        return bool(self.COGNEE_API_URL and self.COGNEE_API_KEY)

    # ---- Judge (adversarial classifier) -----------------------------------
    ANTHROPIC_API_KEY: str | None = os.getenv("ANTHROPIC_API_KEY")
    JUDGE_MODEL: str = os.getenv("LETHE_JUDGE_MODEL", "claude-sonnet-4-6")

    # ---- Certificate signing ----------------------------------------------
    # HMAC secret used to sign Deletion Certificates. In production this would
    # be an org-held key (or an HSM). A stable per-install default is derived
    # if unset, so verification still round-trips in a demo.
    SIGNING_SECRET: str = os.getenv(
        "LETHE_SIGNING_SECRET",
        "lethe-demo-signing-key-rotate-in-production",
    )

    ISSUER: str = os.getenv("LETHE_ISSUER", "Lethe Compliance Engine v2")

    # ---- Runtime -----------------------------------------------------------
    # Concurrency for the probe battery (recall() calls fanned out).
    PROBE_CONCURRENCY: int = int(os.getenv("LETHE_PROBE_CONCURRENCY", "5"))

    @property
    def has_judge(self) -> bool:
        return bool(self.ANTHROPIC_API_KEY)


settings = Settings()

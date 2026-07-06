"""Vercel serverless entrypoint. Exposes the FastAPI app (ASGI) so Vercel's
Python runtime can serve it. All routes are rewritten here via vercel.json."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.main import app  # noqa: E402  (path set above)

__all__ = ["app"]

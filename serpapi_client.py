"""SerpAPI library initialization.

Loads SERPAPI_KEY from .env.local and exposes a ready-to-use client.

Usage:
    from serpapi_client import get_client, SERPAPI_KEY

    client = get_client()
    results = client.search({"engine": "google", "q": "apartments for rent"})
"""

from __future__ import annotations

import os
from pathlib import Path

import serpapi
from dotenv import load_dotenv

# Load .env.local (falls back to .env) from the project root.
_PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(_PROJECT_ROOT / ".env.local")
load_dotenv(_PROJECT_ROOT / ".env", override=False)

SERPAPI_KEY: str | None = os.getenv("SERPAPI_KEY")


def get_client() -> "serpapi.Client":
    """Return an initialized SerpAPI client, or raise if the key is missing."""
    if not SERPAPI_KEY or SERPAPI_KEY == "replace_with_your_serpapi_key":
        raise RuntimeError(
            "SERPAPI_KEY is not set. Copy .env.local.example to .env.local and "
            "add your key from https://serpapi.com/manage-api-key"
        )
    return serpapi.Client(api_key=SERPAPI_KEY)

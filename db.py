"""Storage for apartment listings.

The backend is chosen at runtime:

* **Turso (hosted libSQL)** when ``TURSO_DATABASE_URL`` is set — reachable over
  the network from both the scraper and a Vercel serverless function.
* **Local SQLite file** (``apartments.db``) otherwise, so offline development
  still works with no extra setup.

``TURSO_DATABASE_URL`` / ``TURSO_AUTH_TOKEN`` are read from ``.env.local`` (then
``.env``), the same pattern ``serpapi_client.py`` uses for ``SERPAPI_KEY``.

libSQL is SQLite-compatible, so the schema and every statement below run
unchanged against either backend; only the connection differs.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from typing import Any, Sequence

from dotenv import load_dotenv

# Load .env.local (falls back to .env) from the project root — matches
# serpapi_client.py so a single file holds every secret.
_PROJECT_ROOT = Path(__file__).resolve().parent
load_dotenv(_PROJECT_ROOT / ".env.local")
load_dotenv(_PROJECT_ROOT / ".env", override=False)

DB_PATH = _PROJECT_ROOT / "apartments.db"

TURSO_DATABASE_URL: str | None = os.getenv("TURSO_DATABASE_URL") or None
TURSO_AUTH_TOKEN: str | None = os.getenv("TURSO_AUTH_TOKEN") or None

# Schema as individual statements so both backends can apply it the same way
# (libSQL has no executescript()).
_SCHEMA_STATEMENTS: tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS listings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        source      TEXT,
        title       TEXT,
        price       INTEGER,
        bedrooms    REAL,
        address     TEXT,
        url         TEXT UNIQUE,
        raw_html    TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
    )
    """,
)

# Positional (?) parameters are the common denominator between sqlite3 and
# libsql-client, so every call site below uses them.
_UPSERT_SQL = """
    INSERT INTO listings (source, title, price, bedrooms, address, url, raw_html)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET
        title    = excluded.title,
        price    = excluded.price,
        bedrooms = excluded.bedrooms,
        address  = excluded.address,
        raw_html = excluded.raw_html
"""


def using_turso() -> bool:
    """True when a hosted libSQL database is configured."""
    return TURSO_DATABASE_URL is not None


def backend_name() -> str:
    """Human-readable label for the active backend (for logging)."""
    return f"Turso ({TURSO_DATABASE_URL})" if using_turso() else f"local sqlite ({DB_PATH})"


def _turso_client():
    """Return a sync libSQL client. Imported lazily so offline dev doesn't need
    the package installed."""
    import libsql_client

    return libsql_client.create_client_sync(
        url=TURSO_DATABASE_URL,
        auth_token=TURSO_AUTH_TOKEN,
    )


def _execute(sql: str, params: Sequence[Any] = ()) -> None:
    """Run a write statement against the active backend."""
    if using_turso():
        client = _turso_client()
        try:
            client.execute(sql, list(params))
        finally:
            client.close()
        return

    conn = sqlite3.connect(DB_PATH)
    try:
        with conn:  # commits on success
            conn.execute(sql, tuple(params))
    finally:
        conn.close()


def fetch_all(sql: str, params: Sequence[Any] = ()) -> list[tuple]:
    """Run a read query against the active backend and return a list of tuples."""
    if using_turso():
        client = _turso_client()
        try:
            result = client.execute(sql, list(params))
            return [tuple(row) for row in result.rows]
        finally:
            client.close()

    conn = sqlite3.connect(DB_PATH)
    try:
        return [tuple(row) for row in conn.execute(sql, tuple(params)).fetchall()]
    finally:
        conn.close()


def fetch_one(sql: str, params: Sequence[Any] = ()) -> tuple | None:
    rows = fetch_all(sql, params)
    return rows[0] if rows else None


def init_db() -> None:
    for statement in _SCHEMA_STATEMENTS:
        _execute(statement)


def upsert_listing(listing: dict) -> None:
    _execute(
        _UPSERT_SQL,
        (
            listing.get("source"),
            listing.get("title"),
            listing.get("price"),
            listing.get("bedrooms"),
            listing.get("address"),
            listing.get("url"),
            listing.get("raw_html"),
        ),
    )

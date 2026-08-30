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

Schema follows ``DESIGN.md`` section 3: ``listings`` gains map/radius columns,
plus ``price_history`` and ``geocode_cache`` tables, plus a ``status`` lifecycle
column: ``active`` (default), ``unavailable`` (scraper: 404 / content gone), or
``dismissed`` (user: "not interested", set via the API).
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

# --- Schema -----------------------------------------------------------------
# Base table keeps only the original columns; the map/radius columns are added
# via ALTER so a database created before the migration is upgraded in place the
# same way a fresh one is.
_CREATE_LISTINGS = """
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
"""

# DESIGN.md section 3 — additive columns on listings.
_LISTINGS_ADDED_COLUMNS: dict[str, str] = {
    "lat": "REAL",            # geocoded latitude
    "lng": "REAL",            # geocoded longitude
    "sqft": "INTEGER",        # parsed unit size, best-effort
    "image_url": "TEXT",      # og:image / first gallery image
    "listed_at": "TEXT",      # date the source posted the listing, best-effort
    "keyword_group": "TEXT",  # KEYWORD_GROUPS bucket that surfaced this row
    "last_seen_at": "TEXT",   # timestamp of the most recent scrape run that saw this url
    "status": "TEXT DEFAULT 'active'",  # active | unavailable | dismissed
}

_CREATE_PRICE_HISTORY = """
    CREATE TABLE IF NOT EXISTS price_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id  INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
        price       INTEGER NOT NULL,
        observed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
"""

_CREATE_GEOCODE_CACHE = """
    CREATE TABLE IF NOT EXISTS geocode_cache (
        query       TEXT PRIMARY KEY,
        lat         REAL,
        lng         REAL,
        formatted   TEXT,
        provider    TEXT NOT NULL DEFAULT 'google',
        status      TEXT,
        geocoded_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
"""

_CREATE_INDEXES = (
    "CREATE INDEX IF NOT EXISTS idx_listings_latlng    ON listings(lat, lng)",
    "CREATE INDEX IF NOT EXISTS idx_listings_price     ON listings(price)",
    "CREATE INDEX IF NOT EXISTS idx_listings_last_seen ON listings(last_seen_at)",
    "CREATE INDEX IF NOT EXISTS idx_listings_kw_group  ON listings(keyword_group)",
    "CREATE INDEX IF NOT EXISTS idx_listings_status    ON listings(status)",
    "CREATE INDEX IF NOT EXISTS idx_price_history_listing ON price_history(listing_id, observed_at)",
)

# Positional (?) parameters are the common denominator between sqlite3 and
# libsql-client, so every call site below uses them.
#
# On conflict, NULL-prone fields use COALESCE(excluded.x, listings.x): a
# re-scrape that lacks a value (e.g. the google_maps path has no sqft/beds, the
# google text path has no coordinates) must not wipe what another path already
# stored. `keyword_group` keeps the FIRST bucket that surfaced the URL
# (COALESCE(listings.x, excluded.x)). A successful re-scrape sets `status` back
# to 'active' unless the user has 'dismissed' it — that choice is sticky.
_UPSERT_SQL = """
    INSERT INTO listings
        (source, title, price, bedrooms, address, url, raw_html,
         sqft, image_url, listed_at, lat, lng, keyword_group, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(url) DO UPDATE SET
        title         = excluded.title,
        price         = COALESCE(excluded.price, listings.price),
        bedrooms      = COALESCE(excluded.bedrooms, listings.bedrooms),
        address       = COALESCE(excluded.address, listings.address),
        raw_html      = COALESCE(excluded.raw_html, listings.raw_html),
        sqft          = COALESCE(excluded.sqft, listings.sqft),
        image_url     = COALESCE(excluded.image_url, listings.image_url),
        listed_at     = COALESCE(excluded.listed_at, listings.listed_at),
        lat           = COALESCE(excluded.lat, listings.lat),
        lng           = COALESCE(excluded.lng, listings.lng),
        keyword_group = COALESCE(listings.keyword_group, excluded.keyword_group),
        status        = CASE WHEN listings.status = 'dismissed'
                             THEN 'dismissed' ELSE 'active' END,
        last_seen_at  = datetime('now')
"""

_INSERT_PRICE_HISTORY_SQL = (
    "INSERT INTO price_history (listing_id, price) VALUES (?, ?)"
)


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


def execute(sql: str, params: Sequence[Any] = ()) -> None:
    """Run a write/DDL statement against the active backend."""
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


# Backwards-compatible internal alias.
_execute = execute


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


def _listing_columns() -> set[str]:
    """Column names currently on the listings table (empty if it doesn't exist)."""
    return {row[1] for row in fetch_all("PRAGMA table_info(listings)")}


def init_db() -> None:
    """Create/upgrade the schema. Idempotent — safe to call on every run."""
    execute(_CREATE_LISTINGS)

    have = _listing_columns()
    for name, decl in _LISTINGS_ADDED_COLUMNS.items():
        if name not in have:
            execute(f"ALTER TABLE listings ADD COLUMN {name} {decl}")

    execute(_CREATE_PRICE_HISTORY)
    execute(_CREATE_GEOCODE_CACHE)
    for statement in _CREATE_INDEXES:
        execute(statement)


def upsert_listing(listing: dict) -> None:
    """Insert or update a listing by url. Records a price_history row when the
    price is first seen and whenever it changes on a subsequent scrape."""
    url = listing.get("url")
    new_price = listing.get("price")

    prior = (
        fetch_one("SELECT id, price FROM listings WHERE url = ?", (url,))
        if url
        else None
    )

    execute(
        _UPSERT_SQL,
        (
            listing.get("source"),
            listing.get("title"),
            new_price,
            listing.get("bedrooms"),
            listing.get("address"),
            url,
            listing.get("raw_html"),
            listing.get("sqft"),
            listing.get("image_url"),
            listing.get("listed_at"),
            listing.get("lat"),
            listing.get("lng"),
            listing.get("keyword_group"),
        ),
    )

    if not url or new_price is None:
        return

    if prior is None:
        # First time we've seen this url — seed its price series.
        row = fetch_one("SELECT id FROM listings WHERE url = ?", (url,))
        if row is not None:
            execute(_INSERT_PRICE_HISTORY_SQL, (row[0], new_price))
    else:
        prior_id, prior_price = prior
        if prior_price != new_price:
            execute(_INSERT_PRICE_HISTORY_SQL, (prior_id, new_price))


def mark_unavailable(url: str) -> None:
    """Flag a stored listing as no longer available (404/410, or price + title
    gone from the page). No-op for URLs we've never stored; never overrides a
    user's 'dismissed' choice."""
    execute(
        "UPDATE listings SET status = 'unavailable' "
        "WHERE url = ? AND COALESCE(status, 'active') <> 'dismissed'",
        (url,),
    )

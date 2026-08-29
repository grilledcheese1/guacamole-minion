"""SQLite storage for apartment listings (stdlib sqlite3 — no dependency to install)."""

from __future__ import annotations

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "apartments.db"

_SCHEMA = """
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
);
"""


def get_connection() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_connection() as conn:
        conn.executescript(_SCHEMA)


def upsert_listing(listing: dict) -> None:
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO listings (source, title, price, bedrooms, address, url, raw_html)
            VALUES (:source, :title, :price, :bedrooms, :address, :url, :raw_html)
            ON CONFLICT(url) DO UPDATE SET
                title    = excluded.title,
                price    = excluded.price,
                bedrooms = excluded.bedrooms,
                address  = excluded.address,
                raw_html = excluded.raw_html
            """,
            {
                "source": listing.get("source"),
                "title": listing.get("title"),
                "price": listing.get("price"),
                "bedrooms": listing.get("bedrooms"),
                "address": listing.get("address"),
                "url": listing.get("url"),
                "raw_html": listing.get("raw_html"),
            },
        )

#!/usr/bin/env python3
"""One-off: geocode existing listings that have an address but no lat/lng.

Uses the Google Geocoding API (``GOOGLE_MAPS_API_KEY`` from ``.env.local``) and
caches every normalized address in the ``geocode_cache`` table, so re-running is
cheap and never re-bills for an address already looked up (successes *and*
misses are cached).

Usage:
    python scripts/backfill_geocode.py [--limit N] [--sleep SECONDS] [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO_ROOT))
load_dotenv(_REPO_ROOT / ".env.local")
load_dotenv(_REPO_ROOT / ".env", override=False)

import db  # noqa: E402  — after sys.path + dotenv setup

GEOCODE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json"
_WHITESPACE_RE = re.compile(r"\s+")


def normalize_address(address: str) -> str:
    """Collapse whitespace + lowercase so trivially different spellings share a
    cache key."""
    return _WHITESPACE_RE.sub(" ", address).strip().lower()


def cached_geocode(query: str) -> tuple | None:
    """Return (lat, lng, status) for a normalized address, or None on cache miss."""
    return db.fetch_one(
        "SELECT lat, lng, status FROM geocode_cache WHERE query = ?", (query,)
    )


def store_geocode(query: str, lat, lng, formatted, status: str) -> None:
    db.execute(
        """
        INSERT INTO geocode_cache (query, lat, lng, formatted, provider, status)
        VALUES (?, ?, ?, ?, 'google', ?)
        ON CONFLICT(query) DO UPDATE SET
            lat         = excluded.lat,
            lng         = excluded.lng,
            formatted   = excluded.formatted,
            status      = excluded.status,
            geocoded_at = datetime('now')
        """,
        (query, lat, lng, formatted, status),
    )


def call_geocoding_api(address: str, api_key: str) -> tuple[str, float | None, float | None, str | None]:
    resp = requests.get(
        GEOCODE_ENDPOINT,
        params={"address": address, "key": api_key},
        timeout=20,
    )
    resp.raise_for_status()
    payload = resp.json()
    status = payload.get("status", "UNKNOWN")
    results = payload.get("results") or []
    if status == "OK" and results:
        location = results[0]["geometry"]["location"]
        return status, location["lat"], location["lng"], results[0].get("formatted_address")
    return status, None, None, None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=None, help="cap the number of listings processed")
    parser.add_argument("--sleep", type=float, default=0.1, help="delay between API calls (seconds)")
    parser.add_argument("--dry-run", action="store_true", help="show what would be geocoded, make no API calls or writes")
    args = parser.parse_args()

    api_key = os.getenv("GOOGLE_MAPS_API_KEY")
    if not api_key:
        print("GOOGLE_MAPS_API_KEY is not set in .env.local", file=sys.stderr)
        return 1

    db.init_db()  # ensure lat/lng columns + geocode_cache exist

    rows = db.fetch_all(
        """
        SELECT id, address FROM listings
        WHERE address IS NOT NULL AND TRIM(address) != ''
          AND (lat IS NULL OR lng IS NULL)
        ORDER BY id
        """
    )
    if args.limit is not None:
        rows = rows[: args.limit]

    print(f"{len(rows)} listing(s) need geocoding  ({db.backend_name()})")

    api_calls = cache_hits = updated = unresolved = 0

    for listing_id, address in rows:
        query = normalize_address(address)
        hit = cached_geocode(query)

        if hit is not None:
            lat, lng, status = hit
            cache_hits += 1
        elif args.dry_run:
            print(f"  [dry-run] would geocode #{listing_id}: {query!r}")
            continue
        else:
            try:
                status, lat, lng, formatted = call_geocoding_api(address, api_key)
            except requests.RequestException as exc:
                print(f"  #{listing_id} request failed: {exc}")
                continue
            api_calls += 1
            store_geocode(query, lat, lng, formatted, status)
            if args.sleep:
                time.sleep(args.sleep)
            if status == "OVER_QUERY_LIMIT":
                print("  hit OVER_QUERY_LIMIT — stopping; re-run later")
                break

        if lat is not None and lng is not None:
            if not args.dry_run:
                db.execute(
                    "UPDATE listings SET lat = ?, lng = ? WHERE id = ?",
                    (lat, lng, listing_id),
                )
            updated += 1
        else:
            unresolved += 1
            print(f"  #{listing_id} no coords ({status}): {address!r}")

    print(
        f"done: {updated} updated, {cache_hits} from cache, "
        f"{api_calls} API call(s), {unresolved} unresolved"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

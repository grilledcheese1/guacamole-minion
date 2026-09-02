#!/usr/bin/env python3
"""One-off: geocode existing listings that have an address but no lat/lng.

Uses the Google Geocoding API (``GOOGLE_MAPS_API_KEY`` from ``.env.local``) and
caches every normalized query in the ``geocode_cache`` table, so re-running is
cheap and never re-bills for a query already looked up (successes *and* misses
are cached).

When the full address won't resolve, it retries with a coarser query (ZIP, or
"City, ST") and marks the row ``location_precision = 'approximate'`` so the map
can render it as a neighbourhood centroid rather than a rooftop pin.

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


_ZIP_RE = re.compile(r"\b(\d{5})(?:-\d{4})?\b")
# "City, ST" only when the state code sits at the end of the string (optionally
# followed by a ZIP and/or "USA") — avoids matching English words like
# "..., no location" as "City, NO".
_CITY_STATE_RE = re.compile(
    r"([A-Za-z][A-Za-z .'\-]{1,40}?),\s*([A-Za-z]{2})"
    r"(?:\s+\d{5}(?:-\d{4})?)?(?:\s*,?\s*(?:USA|US))?\s*$",
    re.IGNORECASE,
)


def coarse_query(address: str) -> str | None:
    """A coarser geocodable string from a messy address: a ZIP if present, else a
    trailing 'City, ST' match. Used as a fallback when the full address won't
    resolve."""
    m = _ZIP_RE.search(address)
    if m:
        return m.group(1)
    m = _CITY_STATE_RE.search(address)
    if m:
        return f"{m.group(1).strip()}, {m.group(2).upper()}"
    return None


class _StopRun(Exception):
    """OVER_QUERY_LIMIT — abort the backfill, re-run later."""


def geocode(raw: str, api_key: str, sleep: float, dry_run: bool):
    """Cache-aware geocode of `raw`. Returns (lat, lng, status, api_call), or
    None when a dry run would need a live call. Raises _StopRun on quota."""
    key = normalize_address(raw)
    hit = cached_geocode(key)
    if hit is not None:
        return (*hit, False)
    if dry_run:
        return None
    try:
        status, lat, lng, formatted = call_geocoding_api(raw, api_key)
    except requests.RequestException as exc:
        return (None, None, f"request_failed ({exc})", True)
    store_geocode(key, lat, lng, formatted, status)
    if sleep:
        time.sleep(sleep)
    if status == "OVER_QUERY_LIMIT":
        raise _StopRun
    return (lat, lng, status, True)


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

    # Rows that already have coordinates (e.g. from the google_maps search path)
    # are excluded here, so they never trigger a geocode_cache lookup or an API
    # call.
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

    api_calls = cache_hits = updated = approximate = unresolved = 0

    for listing_id, address in rows:
        try:
            primary = geocode(address, api_key, args.sleep, args.dry_run)
        except _StopRun:
            print("  hit OVER_QUERY_LIMIT — stopping; re-run later")
            break

        if primary is None:  # dry run, would need a live call
            print(f"  [dry-run] would geocode #{listing_id}: {address!r}")
            continue

        lat, lng, status, api_call = primary
        (api_calls, cache_hits) = (
            (api_calls + 1, cache_hits) if api_call else (api_calls, cache_hits + 1)
        )

        precision = None
        if lat is None or lng is None:
            coarse = coarse_query(address)
            if coarse and normalize_address(coarse) != normalize_address(address):
                try:
                    secondary = geocode(coarse, api_key, args.sleep, args.dry_run)
                except _StopRun:
                    print("  hit OVER_QUERY_LIMIT — stopping; re-run later")
                    break
                if secondary is not None:
                    s_lat, s_lng, s_status, s_api = secondary
                    if s_api:
                        api_calls += 1
                    if s_lat is not None and s_lng is not None:
                        lat, lng, status = s_lat, s_lng, s_status
                        precision = "approximate"

        if lat is not None and lng is not None:
            if not args.dry_run:
                db.execute(
                    "UPDATE listings SET lat = ?, lng = ?, "
                    "location_precision = ? WHERE id = ?",
                    (lat, lng, precision, listing_id),
                )
            updated += 1
            if precision == "approximate":
                approximate += 1
                print(f"  #{listing_id} approximate via {coarse!r}")
        else:
            unresolved += 1
            print(f"  #{listing_id} no coords ({status}): {address!r}")

    print(
        f"done: {updated} updated ({approximate} approximate), "
        f"{cache_hits} from cache, {api_calls} API call(s), {unresolved} unresolved"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

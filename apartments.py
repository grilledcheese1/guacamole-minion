"""Apartment hunting entry point.

Pipeline:
    1. Search the web for listings via SerpAPI  (serpapi_client.get_client)
    2. Fetch + parse each result page with BeautifulSoup
    3. Persist normalized listings into SQLite   (db.upsert_listing)

Run:
    python3 apartments.py "2 bedroom apartment San Francisco under 3500"
"""

from __future__ import annotations

import re
import sys

import requests
from bs4 import BeautifulSoup

from db import init_db, get_connection, upsert_listing
from keywords import build_queries
from serpapi_client import get_client

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def search_listings(query: str, num: int = 10) -> list[dict]:
    """Return organic search results for `query` from SerpAPI."""
    client = get_client()
    response = client.search(
        {
            "engine": "google",
            "q": query,
            "num": num,
        }
    )
    return response.get("organic_results", []) or []


def fetch_html(url: str) -> str:
    resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=20)
    resp.raise_for_status()
    return resp.text


_PRICE_RE = re.compile(r"\$\s?([\d,]{3,})")
_BED_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:bed|bd|br)\b", re.IGNORECASE)


def parse_listing(url: str, html: str, source: str) -> dict:
    """Best-effort extraction of price / bedrooms / address from a listing page."""
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text(" ", strip=True)

    title_tag = soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else url

    price_match = _PRICE_RE.search(text)
    price = int(price_match.group(1).replace(",", "")) if price_match else None

    bed_match = _BED_RE.search(text)
    bedrooms = float(bed_match.group(1)) if bed_match else None

    addr_tag = soup.find("address")
    address = addr_tag.get_text(" ", strip=True) if addr_tag else None

    return {
        "source": source,
        "title": title,
        "price": price,
        "bedrooms": bedrooms,
        "address": address,
        "url": url,
        "raw_html": html[:200_000],
    }


def run(query: str) -> None:
    init_db()
    results = search_listings(query)
    print(f"SerpAPI returned {len(results)} results for: {query!r}")

    for result in results:
        url = result.get("link")
        if not url:
            continue
        source = result.get("source") or result.get("displayed_link") or "web"
        try:
            html = fetch_html(url)
            listing = parse_listing(url, html, source)
            upsert_listing(listing)
            print(f"  saved  {listing['price']!s:>8}  {url}")
        except Exception as exc:  # noqa: BLE001 - keep the crawl going
            print(f"  skip   {url}  ({exc})")

    with get_connection() as conn:
        (count,) = conn.execute("SELECT COUNT(*) FROM listings").fetchone()
    print(f"Total listings in apartments.db: {count}")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        run(" ".join(sys.argv[1:]))
    else:
        # No query given: sweep the curated cheap-apartment keyword list.
        for query in build_queries(with_sites=True):
            run(query)

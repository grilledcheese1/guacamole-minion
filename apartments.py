"""Apartment hunting entry point.

Two SerpAPI search paths feed one pipeline:
    * google_maps engine  -> results carry gps_coordinates, stored straight into
      listings.lat / listings.lng (no geocoding needed). Used for place-style
      queries (keywords.build_search_plan decides which).
    * google engine (text) -> organic web results; each page is fetched and
      parsed with BeautifulSoup. Used for site:-filtered and attribute queries
      Maps can't serve.

Both paths normalize to a listing dict and persist via db.upsert_listing.

Run:
    python3 apartments.py "2 bedroom apartment San Francisco under 3500"
"""

from __future__ import annotations

import re
import sys

import requests
from bs4 import BeautifulSoup

from db import backend_name, fetch_one, init_db, upsert_listing
from keywords import build_search_plan
from serpapi_client import get_client

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def search_listings(query: str, num: int = 10) -> list[dict]:
    """Return organic (google text engine) search results for `query`."""
    client = get_client()
    response = client.search(
        {
            "engine": "google",
            "q": query,
            "num": num,
        }
    )
    return response.get("organic_results", []) or []


def search_map_listings(query: str) -> list[dict]:
    """Return local place results for `query` from SerpAPI's google_maps engine.
    Each result carries gps_coordinates, so these listings skip geocoding."""
    client = get_client()
    response = client.search(
        {
            "engine": "google_maps",
            "type": "search",
            "q": query,
        }
    )
    local = response.get("local_results") or []
    if local:
        return local
    place = response.get("place_results")
    return [place] if place else []


def fetch_html(url: str) -> str:
    resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=20)
    resp.raise_for_status()
    return resp.text


_PRICE_RE = re.compile(r"\$\s?([\d,]{3,})")
_BED_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:bed|bd|br)\b", re.IGNORECASE)
_SQFT_RE = re.compile(
    r"([\d,]{2,7})\s*(?:sq\.?\s*ft\.?|sqft|square\s*feet|ft²|ft2)\b", re.IGNORECASE
)
_JSONLD_DATE_RE = re.compile(
    r'"date(?:Posted|Published|Created)"\s*:\s*"([^"]+)"', re.IGNORECASE
)


def _extract_sqft(text: str) -> int | None:
    match = _SQFT_RE.search(text)
    if not match:
        return None
    try:
        value = int(match.group(1).replace(",", ""))
    except ValueError:
        return None
    return value if 100 <= value <= 100_000 else None


def _extract_image_url(soup: BeautifulSoup) -> str | None:
    """Prefer the og:image meta tag; fall back to twitter:image."""
    for attrs in (
        {"property": "og:image"},
        {"property": "og:image:url"},
        {"name": "twitter:image"},
        {"name": "twitter:image:src"},
    ):
        tag = soup.find("meta", attrs=attrs)
        content = tag.get("content", "").strip() if tag else ""
        if content:
            return content
    return None


def _extract_listed_at(soup: BeautifulSoup, html: str) -> str | None:
    """Best-effort posted/published date from meta tags, <time>, or JSON-LD."""
    for attrs in (
        {"property": "article:published_time"},
        {"itemprop": "datePosted"},
        {"itemprop": "datePublished"},
        {"name": "date"},
    ):
        tag = soup.find("meta", attrs=attrs)
        content = tag.get("content", "").strip() if tag else ""
        if content:
            return content

    time_tag = soup.find("time", attrs={"datetime": True})
    if time_tag and time_tag.get("datetime", "").strip():
        return time_tag["datetime"].strip()

    match = _JSONLD_DATE_RE.search(html)
    return match.group(1) if match else None


def parse_listing(url: str, html: str, source: str) -> dict:
    """Best-effort extraction of price / bedrooms / address / sqft / image /
    posted-date from a listing page."""
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
        "sqft": _extract_sqft(text),
        "image_url": _extract_image_url(soup),
        "listed_at": _extract_listed_at(soup, html),
        "raw_html": html[:200_000],
    }


_MAP_PLACE_URL = "https://www.google.com/maps/place/?q=place_id:{}"


def _coords_from_result(result: dict) -> tuple[float | None, float | None]:
    """Pull (lat, lng) from a SerpAPI local result, handling the google_maps
    ('gps_coordinates' / latitude,longitude) and google_local ('coordinates' /
    lat,lng) shapes."""
    gps = result.get("gps_coordinates") or result.get("coordinates") or {}
    raw_lat = gps.get("latitude", gps.get("lat"))
    raw_lng = gps.get("longitude", gps.get("lng"))
    try:
        lat = float(raw_lat)
        lng = float(raw_lng)
    except (TypeError, ValueError):
        return None, None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lng <= 180.0):
        return None, None
    return lat, lng


def _price_from_map(result: dict) -> int | None:
    raw = result.get("price")
    if isinstance(raw, dict):
        raw = raw.get("value") or raw.get("range") or ""
    if not isinstance(raw, str):
        return None
    match = _PRICE_RE.search(raw)
    return int(match.group(1).replace(",", "")) if match else None


def parse_map_result(result: dict) -> dict | None:
    """Normalize one google_maps local result into a listing dict, carrying its
    gps_coordinates straight into lat/lng."""
    title = (result.get("title") or "").strip()
    if not title:
        return None

    url = result.get("website") or result.get("link")
    if not url and result.get("place_id"):
        url = _MAP_PLACE_URL.format(result["place_id"])
    if not url:
        return None

    lat, lng = _coords_from_result(result)
    return {
        "source": result.get("source") or "google_maps",
        "title": title,
        "price": _price_from_map(result),
        "bedrooms": None,
        "address": result.get("address"),
        "url": url,
        "lat": lat,
        "lng": lng,
        "sqft": None,
        "image_url": result.get("thumbnail"),
        "listed_at": None,
        "raw_html": None,
    }


def _collect_web_listings(query: str) -> list[dict]:
    """google text path: organic results -> fetch each page -> parse."""
    listings: list[dict] = []
    for result in search_listings(query):
        url = result.get("link")
        if not url:
            continue
        source = result.get("source") or result.get("displayed_link") or "web"
        try:
            html = fetch_html(url)
        except Exception as exc:  # noqa: BLE001 - keep the crawl going
            print(f"  skip   {url}  ({exc})")
            continue
        listings.append(parse_listing(url, html, source))
    return listings


def _collect_map_listings(query: str) -> list[dict]:
    """google_maps path: local results already carry coordinates; when a result
    links to a real website we also fetch it to fill in price / beds / sqft."""
    listings: list[dict] = []
    for result in search_map_listings(query):
        listing = parse_map_result(result)
        if listing is None:
            continue
        website = listing["url"]
        if website.startswith("http") and "/maps/place/" not in website:
            try:
                enriched = parse_listing(
                    website, fetch_html(website), listing["source"]
                )
            except Exception as exc:  # noqa: BLE001 - map data alone is still useful
                print(f"  note   {website} not fetched ({exc})")
            else:
                # Map coordinates are authoritative; the page fills the gaps.
                enriched["lat"] = listing["lat"]
                enriched["lng"] = listing["lng"]
                enriched["source"] = listing["source"]
                enriched["address"] = enriched.get("address") or listing["address"]
                enriched["image_url"] = (
                    enriched.get("image_url") or listing["image_url"]
                )
                enriched["price"] = enriched.get("price") or listing["price"]
                listing = enriched
        listings.append(listing)
    return listings


def run(query: str, engine: str = "google") -> None:
    init_db()
    listings = (
        _collect_map_listings(query)
        if engine == "google_maps"
        else _collect_web_listings(query)
    )
    print(f"[{engine}] {len(listings)} listing(s) for {query!r}  ->  {backend_name()}")

    for listing in listings:
        try:
            upsert_listing(listing)
            print(f"  saved  {str(listing.get('price')):>8}  {listing.get('url')}")
        except Exception as exc:  # noqa: BLE001 - keep the crawl going
            print(f"  skip   {listing.get('url')}  ({exc})")

    (count,) = fetch_one("SELECT COUNT(*) FROM listings") or (0,)
    print(f"Total listings stored: {count}")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        run(" ".join(sys.argv[1:]))
    else:
        # No query given: sweep the curated plan — google_maps where it fits,
        # google text search elsewhere (including site:-filtered queries).
        for plan_engine, plan_query in build_search_plan(with_sites=True):
            run(plan_query, engine=plan_engine)

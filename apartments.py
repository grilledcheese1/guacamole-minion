"""Apartment hunting entry point.

Two SerpAPI search paths feed one pipeline:
    * google_maps engine  -> results carry gps_coordinates, stored straight into
      listings.lat / listings.lng (no geocoding needed). Used for place-style
      queries (keywords.build_search_plan decides which).
    * google engine (text) -> organic web results; each page is fetched and
      parsed with BeautifulSoup. Used for site:-filtered and attribute queries
      Maps can't serve.

Both paths normalize to a listing dict and persist via db.upsert_listing.

Politeness: each page fetch waits a random 1-3s and is skipped if the site's
robots.txt disallows it for our UA. This is a personal / small-group tool — just
enough courtesy to not get IP-banned, not a full polite-crawl framework.

Run:
    python3 apartments.py "2 bedroom apartment San Francisco under 3500"
"""

from __future__ import annotations

import os
import random
import re
import sys
import time
from collections import Counter
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser

import requests
from bs4 import BeautifulSoup

from db import (
    backend_name,
    fetch_one,
    init_db,
    mark_unavailable,
    upsert_listing,
)
from keywords import build_search_plan
from serpapi_client import get_client

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)

# --- politeness -----------------------------------------------------------
FETCH_DELAY_RANGE = (1.0, 3.0)  # random seconds between page fetches
RESPECT_ROBOTS = True  # set False to bypass robots.txt checks

# Per-process state.
_robots_cache: dict[str, RobotFileParser | None] = {}  # origin -> rules (None = allow all)
_last_fetch_at: float = 0.0

# Cumulative run tallies. Keys: saved, gone, robots, blocked, error.
STATS: Counter[str] = Counter()


class FetchSkip(Exception):
    """A categorized reason a URL was not fetched.

    reason: "robots" (disallowed), "blocked" (HTTP 403/429),
    "gone" (HTTP 404/410 — listing removed), "error" (other failure).
    """

    def __init__(self, reason: str, message: str, *, status: int | None = None) -> None:
        super().__init__(f"{reason}: {message}")
        self.reason = reason
        self.message = message
        self.status = status


def _note_skip(skip: "FetchSkip", url: str) -> None:
    STATS[skip.reason] += 1
    print(f"  skip[{skip.reason}]   {url}  ({skip.message})")


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


def search_map_listings(query: str, ll: str | None = None) -> list[dict]:
    """Return local place results for `query` from SerpAPI's google_maps engine.
    Each result carries gps_coordinates, so these listings skip geocoding.
    `ll` (SerpAPI's "@lat,lng,zoomz" coordinate format — see radius_to_ll())
    centers/scopes results to a radius when the location filter had a point."""
    client = get_client()
    params = {
        "engine": "google_maps",
        "type": "search",
        "q": query,
    }
    if ll:
        params["ll"] = ll
    response = client.search(params)
    local = response.get("local_results") or []
    if local:
        return local
    place = response.get("place_results")
    return [place] if place else []


def _http_get(url: str, timeout: int = 20) -> requests.Response:
    return requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)


def _fetch_robots_txt(origin: str) -> str | None:
    """Text of `origin`/robots.txt, or None if missing/unreadable."""
    try:
        resp = _http_get(f"{origin}/robots.txt", timeout=10)
    except requests.RequestException:
        return None
    if resp.status_code == 200 and resp.text.strip():
        return resp.text
    return None


def _robots_for(url: str) -> RobotFileParser | None:
    """Parsed robots.txt for the URL's origin, fetched once per run and cached.
    None => no rules (missing/unreadable) => treat as allow-all."""
    parts = urlsplit(url)
    origin = f"{parts.scheme}://{parts.netloc}"
    if origin not in _robots_cache:
        body = _fetch_robots_txt(origin)
        if body is None:
            _robots_cache[origin] = None
        else:
            parser = RobotFileParser()
            parser.parse(body.splitlines())
            _robots_cache[origin] = parser
    return _robots_cache[origin]


def _robots_allows(url: str) -> bool:
    if not RESPECT_ROBOTS:
        return True
    parser = _robots_for(url)
    return True if parser is None else parser.can_fetch(USER_AGENT, url)


def fetch_html(url: str) -> str:
    """robots-aware, rate-limited page fetch.

    Raises FetchSkip(reason, message):
      * "robots"  – disallowed by the site's robots.txt for our UA
      * "blocked" – HTTP 403 / 429 (bot-block or rate-limit)
      * "error"   – network failure or other HTTP error
    """
    global _last_fetch_at

    if not _robots_allows(url):
        raise FetchSkip("robots", "disallowed by robots.txt")

    # Space page fetches out by a random 1-3s gap.
    if _last_fetch_at:
        wait = random.uniform(*FETCH_DELAY_RANGE) - (
            time.monotonic() - _last_fetch_at
        )
        if wait > 0:
            time.sleep(wait)
    _last_fetch_at = time.monotonic()

    try:
        resp = _http_get(url)
    except requests.RequestException as exc:
        raise FetchSkip("error", str(exc)) from exc

    if resp.status_code in (403, 429):
        raise FetchSkip("blocked", f"HTTP {resp.status_code}", status=resp.status_code)
    if resp.status_code in (404, 410):
        raise FetchSkip("gone", f"HTTP {resp.status_code}", status=resp.status_code)
    try:
        resp.raise_for_status()
    except requests.HTTPError as exc:
        raise FetchSkip("error", str(exc), status=resp.status_code) from exc
    return resp.text


_PRICE_RE = re.compile(r"\$\s?([\d,]{3,})")
# Preferred over _PRICE_RE: a price explicitly tagged as monthly rent, so we
# don't grab the first "$" in the page (a deposit, a fee, or a "similar
# listings starting at $X" widget rather than this unit's rent).
_PRICE_MONTHLY_RE = re.compile(
    r"\$\s?([\d,]{3,})\s*(?:/\s*mo\b|/\s*month\b|per\s*month\b)", re.IGNORECASE
)
# schema.org Offer/price, as embedded in a <script type="application/ld+json">
# block by most listing sites — a structured field, not a text-scan guess.
_JSONLD_PRICE_RE = re.compile(r'"price"\s*:\s*"?([\d,]{3,})"?', re.IGNORECASE)
# Sanity bounds so an unrelated dollar figure (a home's sale price, a phone
# number, a deposit) can't masquerade as monthly rent.
_PRICE_MIN = 300
_PRICE_MAX = 20_000
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


def _extract_price(text: str, html: str) -> int | None:
    """Best-effort monthly rent. Tries, in order of confidence: a price
    explicitly marked "/mo" or "per month", a schema.org JSON-LD `price`
    field, then the first bare "$amount" in the page as a last resort — each
    candidate has to fall within a plausible rent range, so a deposit, fee,
    home-sale price, or unrelated "similar listings" figure doesn't get
    mistaken for this unit's rent."""
    for pattern, haystack in (
        (_PRICE_MONTHLY_RE, text),
        (_JSONLD_PRICE_RE, html),
        (_PRICE_RE, text),
    ):
        for match in pattern.finditer(haystack):
            try:
                value = int(match.group(1).replace(",", ""))
            except ValueError:
                continue
            if _PRICE_MIN <= value <= _PRICE_MAX:
                return value
    return None


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

    price = _extract_price(text, html)

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


def _content_missing(listing: dict) -> bool:
    """Neither a price nor a real title survived the parse — the page is
    probably a takedown / redirect stub, not a live listing."""
    title = (listing.get("title") or "").strip()
    has_title = bool(title) and title != listing.get("url")
    return listing.get("price") is None and not has_title


def _had_price(url: str) -> bool:
    """True if a price was ever stored for this URL (so losing it now is a
    strong 'listing gone' signal)."""
    return (
        fetch_one(
            "SELECT 1 FROM listings WHERE url = ? AND price IS NOT NULL", (url,)
        )
        is not None
    )


_MAP_PLACE_URL = "https://www.google.com/maps/place/?q=place_id:{}"


def radius_to_ll(lat: float, lng: float, radius_miles: float | None) -> str:
    """Approximate a SerpAPI google_maps `ll` ("@lat,lng,zoomz") from a search
    radius in miles, for search_map_listings(). Neither SerpAPI nor Google
    Maps takes a direct numeric-radius parameter, so this is a real-world
    approximation, not an exact bound: tighter zoom for a smaller radius,
    looser for a larger one, falling back to a wide city-scale zoom when the
    radius is unset or large."""
    if radius_miles is not None and radius_miles <= 1:
        zoom = 15
    elif radius_miles is not None and radius_miles <= 5:
        zoom = 13
    elif radius_miles is not None and radius_miles <= 10:
        zoom = 12
    elif radius_miles is not None and radius_miles <= 25:
        zoom = 10
    else:
        zoom = 9
    return f"@{lat},{lng},{zoom}z"


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
    if not match:
        return None
    value = int(match.group(1).replace(",", ""))
    return value if _PRICE_MIN <= value <= _PRICE_MAX else None


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


def _collect_web_listings(query: str, keyword_group: str | None) -> list[dict]:
    """google text path: organic results -> fetch each page -> parse.

    A previously-seen URL that now 404s, or whose price + title can no longer be
    parsed, is flagged `unavailable` (db.mark_unavailable) instead of leaving
    stale data looking current.
    """
    listings: list[dict] = []
    for result in search_listings(query):
        url = result.get("link")
        if not url:
            continue
        source = result.get("source") or result.get("displayed_link") or "web"
        try:
            html = fetch_html(url)
        except FetchSkip as skip:
            _note_skip(skip, url)
            if skip.reason == "gone":
                mark_unavailable(url)
            continue
        try:
            listing = parse_listing(url, html, source)
        except Exception as exc:  # noqa: BLE001 - keep the crawl going
            STATS["error"] += 1
            print(f"  skip[error]   {url}  (parse: {exc})")
            continue
        listing["keyword_group"] = keyword_group
        if _content_missing(listing) or (
            listing.get("price") is None and _had_price(url)
        ):
            mark_unavailable(url)
            STATS["gone"] += 1
            print(f"  skip[gone]   {url}  (price/title no longer found)")
            continue
        listings.append(listing)
    return listings


def _collect_map_listings(
    query: str, keyword_group: str | None, ll: str | None = None
) -> list[dict]:
    """google_maps path: local results already carry coordinates; when a result
    links to a real website we also fetch it to fill in price / beds / sqft."""
    listings: list[dict] = []
    for result in search_map_listings(query, ll=ll):
        listing = parse_map_result(result)
        if listing is None:
            continue
        listing["keyword_group"] = keyword_group
        website = listing["url"]
        if website.startswith("http") and "/maps/place/" not in website:
            try:
                enriched = parse_listing(
                    website, fetch_html(website), listing["source"]
                )
            except FetchSkip as skip:
                # Map data alone is still useful; just note why enrichment stopped.
                print(f"  note[{skip.reason}]   {website}  ({skip.message})")
            except Exception as exc:  # noqa: BLE001 - map data alone is still useful
                print(f"  note[error]   {website}  (parse: {exc})")
            else:
                # Map coordinates are authoritative; the page fills the gaps.
                enriched["lat"] = listing["lat"]
                enriched["lng"] = listing["lng"]
                enriched["source"] = listing["source"]
                enriched["keyword_group"] = keyword_group
                enriched["address"] = enriched.get("address") or listing["address"]
                enriched["image_url"] = (
                    enriched.get("image_url") or listing["image_url"]
                )
                enriched["price"] = enriched.get("price") or listing["price"]
                listing = enriched
        listings.append(listing)
    return listings


def run(
    query: str,
    engine: str = "google",
    keyword_group: str | None = None,
    ll: str | None = None,
) -> None:
    init_db()
    listings = (
        _collect_map_listings(query, keyword_group, ll=ll)
        if engine == "google_maps"
        else _collect_web_listings(query, keyword_group)
    )
    print(f"[{engine}] {len(listings)} listing(s) for {query!r}  ->  {backend_name()}")

    for listing in listings:
        try:
            upsert_listing(listing)
            STATS["saved"] += 1
            print(f"  saved  {str(listing.get('price')):>8}  {listing.get('url')}")
        except Exception as exc:  # noqa: BLE001 - keep the crawl going
            STATS["error"] += 1
            print(f"  skip[error]   {listing.get('url')}  (db: {exc})")


def print_summary() -> None:
    """One cumulative summary for the whole process run."""
    (count,) = fetch_one("SELECT COUNT(*) FROM listings") or (0,)
    print(
        "\nRun summary\n"
        f"  saved                 {STATS['saved']}\n"
        f"  marked unavailable    {STATS['gone']}\n"
        f"  skipped (robots.txt)  {STATS['robots']}\n"
        f"  skipped (error)       {STATS['error']}\n"
        f"  skipped (blocked)     {STATS['blocked']}\n"
        f"  total listings in db  {count}"
    )


if __name__ == "__main__":
    # A leading --maps runs the given query through the google_maps engine
    # (results carry gps_coordinates); default is the google text engine.
    argv = sys.argv[1:]
    engine = "google"
    if argv and argv[0] in ("--maps", "--google-maps"):
        engine, argv = "google_maps", argv[1:]

    if argv:
        run(" ".join(argv), engine=engine)
    else:
        # No query given: sweep the curated plan — google_maps where it fits,
        # google text search elsewhere (including site:-filtered queries).
        # Optionally scoped by SCRAPE_LOCATION / SCRAPE_MAX_PRICE /
        # SCRAPE_MIN_PRICE / SCRAPE_BEDROOMS / SCRAPE_GROUPS / SCRAPE_SITES /
        # SCRAPE_LAT / SCRAPE_LNG / SCRAPE_RADIUS_MILES — set by the "Run
        # scrape now" button from whatever filters were active in the browser
        # when it was clicked (api/trigger-scrape.js forwards them as
        # workflow_dispatch inputs; scrape.yml maps those inputs to these env
        # vars). All blank/unset runs the original unscoped, nationwide sweep
        # of every group.
        def _int_env(name: str) -> int | None:
            raw = os.getenv(name, "").strip()
            return int(raw) if raw.lstrip("-").isdigit() else None

        def _float_env(name: str) -> float | None:
            raw = os.getenv(name, "").strip()
            try:
                return float(raw) if raw else None
            except ValueError:
                return None

        location = os.getenv("SCRAPE_LOCATION", "").strip()
        max_price = _int_env("SCRAPE_MAX_PRICE")
        min_price = _int_env("SCRAPE_MIN_PRICE")
        bedrooms = _int_env("SCRAPE_BEDROOMS")
        groups_raw = os.getenv("SCRAPE_GROUPS", "").strip()
        groups = [g.strip() for g in groups_raw.split(",") if g.strip()] or None
        sites_raw = os.getenv("SCRAPE_SITES", "").strip()
        sites = [s.strip() for s in sites_raw.split(",") if s.strip()] or None

        # Radius only means anything with an actual point — bedrooms/min/max
        # price and groups/sites work as query-text scoping regardless.
        lat = _float_env("SCRAPE_LAT")
        lng = _float_env("SCRAPE_LNG")
        radius_miles = _float_env("SCRAPE_RADIUS_MILES")
        ll = radius_to_ll(lat, lng, radius_miles) if lat is not None and lng is not None else None

        if location or max_price or min_price or bedrooms is not None or groups or sites or ll:
            print(
                f"[scope] location={location or '(any)'} "
                f"price={min_price or '(any)'}-{max_price or '(any)'} "
                f"bedrooms={bedrooms if bedrooms is not None else '(any)'} "
                f"groups={groups or '(all)'} sites={sites or '(all)'} ll={ll or '(none)'}"
            )

        plan = build_search_plan(
            location=location,
            max_price=max_price,
            min_price=min_price,
            bedrooms=bedrooms,
            groups=groups,
            sites=sites,
            with_sites=True,
        )
        for plan_engine, plan_query, plan_group in plan:
            run(plan_query, engine=plan_engine, keyword_group=plan_group, ll=ll)
    print_summary()

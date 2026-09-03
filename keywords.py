"""SerpAPI search-query keywords tuned to surface CHEAP apartment listings.
Mirror of src/keywords.js for the Python scraper.

`build_search_plan` routes each query to an engine: google_maps for place-style
queries (results carry gps_coordinates, so those listings skip geocoding) and the
google text engine for site:-filtered and attribute queries Maps can't serve.

    from keywords import CHEAP_APARTMENT_KEYWORDS, build_queries

    for q in build_queries(location="Austin, Texas", max_price=1200):
        client.search({"engine": "google", "q": q})

All containers here are immutable (tuples + a read-only mapping) so the curated
keyword set can't be mutated at runtime.
"""

from __future__ import annotations

from types import MappingProxyType

KEYWORD_GROUPS: MappingProxyType[str, tuple[str, ...]] = MappingProxyType(
    {
        "budget": (
            "cheap apartments for rent",
            "affordable apartments for rent",
            "budget apartments for rent",
            "low cost apartments for rent",
            "inexpensive apartments for rent",
            "cheapest apartments for rent near me",
        ),
        "price_capped": (
            "apartments for rent under $800",
            "apartments for rent under $1000",
            "apartments for rent under $1200",
            "apartments for rent under $1500",
            "studio apartments under $900",
            "1 bedroom apartments under $1100",
        ),
        "assistance": (
            "low income apartments for rent",
            "income restricted apartments",
            "section 8 apartments for rent",
            "affordable housing apartments waitlist",
            "HUD apartments for rent",
            "sliding scale rent apartments",
        ),
        "low_barrier": (
            "no credit check apartments for rent",
            "apartments no application fee",
            "second chance apartments bad credit",
            "no deposit apartments for rent",
            "month to month apartments cheap",
        ),
        "deals": (
            "move in specials apartments",
            "first month free apartment deals",
            "apartment rent concessions this month",
            "utilities included cheap apartments",
            "reduced rent apartments available now",
        ),
        "unit_types": (
            "cheap studio apartments for rent",
            "cheap 1 bedroom apartments for rent",
            "cheap basement apartment for rent",
            "cheap in law suite for rent",
            "cheap room for rent in apartment",
            "cheap furnished apartments short term",
        ),
        "sources": (
            "cheap apartments for rent craigslist",
            "cheap apartments for rent zillow",
            "cheap apartments apartments.com",
            "cheap apartments hotpads",
            "cheap apartments zumper",
            "cheap apartments facebook marketplace",
        ),
    }
)

# Flat tuple of every keyword across all groups.
CHEAP_APARTMENT_KEYWORDS: tuple[str, ...] = tuple(
    kw for group in KEYWORD_GROUPS.values() for kw in group
)

LISTING_SITES: tuple[str, ...] = (
    "zillow.com",
    "apartments.com",
    "craigslist.org",
    "trulia.com",
    "hotpads.com",
    "zumper.com",
    "rent.com",
    "padmapper.com",
    "affordablehousing.com",
)


# Bedroom-count filter as query-text phrasing — there's no structured
# "bedrooms" parameter on either SerpAPI engine, so a chosen count is prepended
# to every keyword instead (e.g. "2 bedroom" + "cheap apartments for rent").
BEDROOM_PHRASES: MappingProxyType[int, str] = MappingProxyType(
    {0: "studio", 1: "1 bedroom", 2: "2 bedroom", 3: "3 bedroom"}
)


def _price_phrase(min_price: int | None, max_price: int | None) -> str:
    """Same rationale as BEDROOM_PHRASES: no structured min/max price param on
    either engine, so a range becomes query text."""
    if min_price and max_price:
        return f" ${min_price} to ${max_price}"
    if min_price:
        return f" over ${min_price}"
    if max_price:
        return f" under ${max_price}"
    return ""


def build_queries(
    location: str = "",
    max_price: int | None = None,
    min_price: int | None = None,
    bedrooms: int | None = None,
    groups: list[str] | None = None,
    sites: list[str] | None = None,
    with_sites: bool = False,
) -> list[str]:
    """Expand the base keywords into concrete SerpAPI query strings (deduped)."""
    if groups:
        base = [kw for g in groups for kw in KEYWORD_GROUPS.get(g, ())]
    else:
        base = list(CHEAP_APARTMENT_KEYWORDS)

    bed_prefix = f"{BEDROOM_PHRASES[bedrooms]} " if bedrooms in BEDROOM_PHRASES else ""
    price_phrase = _price_phrase(min_price, max_price)

    queries: list[str] = []
    for kw in base:
        q = bed_prefix + kw + price_phrase
        if location:
            q += f" in {location}"
        queries.append(q)

    if with_sites:
        anchor = f"cheap apartments in {location}" if location else "cheap apartments"
        for site in sites or LISTING_SITES:
            queries.append(f"{anchor} site:{site}")

    # De-dupe, preserve order.
    seen: set[str] = set()
    return [q for q in queries if not (q in seen or seen.add(q))]


# --- Engine routing -------------------------------------------------------
# Keyword groups phrased as place-type searches ("<kind of place>"), which the
# google_maps engine indexes well and answers with gps_coordinates. Groups not
# listed here (subsidy-program jargon, low-barrier attributes, deals, and the
# site:-filtered "sources" group) stay on the google text engine.
MAP_FRIENDLY_GROUPS: frozenset[str] = frozenset(
    {"budget", "price_capped", "unit_types"}
)

# Substrings that mark a query as a web search rather than a place search, even
# inside an otherwise map-friendly group.
_MAP_UNFRIENDLY_TOKENS: tuple[str, ...] = (
    "site:",
    "craigslist",
    "zillow",
    "hotpads",
    "zumper",
    "trulia",
    "apartments.com",
    "padmapper",
    "facebook marketplace",
    "no credit check",
    "no application fee",
    "second chance",
    "section 8",
    "hud ",
    "waitlist",
)


def is_map_friendly(query: str) -> bool:
    """True when `query` reads as a place search the google_maps engine can serve
    (and therefore return gps_coordinates for)."""
    lowered = query.lower()
    return not any(token in lowered for token in _MAP_UNFRIENDLY_TOKENS)


def build_search_plan(
    location: str = "",
    max_price: int | None = None,
    min_price: int | None = None,
    bedrooms: int | None = None,
    groups: list[str] | None = None,
    sites: list[str] | None = None,
    with_sites: bool = False,
) -> list[tuple[str, str, str]]:
    """Expand the curated keywords into ``(engine, query, keyword_group)`` triples.

    ``engine`` is ``"google_maps"`` for place-style queries — their results carry
    gps_coordinates, so the listings skip geocoding — and ``"google"`` for
    everything else, including the ``site:``-filtered queries the maps engine
    cannot serve (tagged group ``"sources"``). Deduped on ``(engine, query)``,
    order preserved.

    ``bedrooms``/``min_price``/``max_price`` have no structured parameter on
    either SerpAPI engine, so they're folded into the query text (see
    BEDROOM_PHRASES / _price_phrase) — an approximation, not a hard filter;
    ``sites`` (a subset of LISTING_SITES) narrows which ``site:`` queries
    ``with_sites`` generates, defaulting to all of them.
    """
    plan: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str]] = set()

    def _add(engine: str, query: str, group: str) -> None:
        key = (engine, query)
        if key not in seen:
            seen.add(key)
            plan.append((engine, query, group))

    bed_prefix = f"{BEDROOM_PHRASES[bedrooms]} " if bedrooms in BEDROOM_PHRASES else ""
    price_phrase = _price_phrase(min_price, max_price)

    selected = groups if groups else list(KEYWORD_GROUPS)
    for group in selected:
        map_ok = group in MAP_FRIENDLY_GROUPS
        # unit_types keywords already say "studio" / "1 bedroom" / etc.
        # themselves — prepending an explicit bedroom count on top of those
        # would read as contradictory ("2 bedroom ... studio apartments").
        group_bed_prefix = "" if group == "unit_types" else bed_prefix
        for kw in KEYWORD_GROUPS.get(group, ()):
            q = group_bed_prefix + kw + price_phrase
            if map_ok and is_map_friendly(kw):
                if location:
                    q += f" {location}"  # Maps prefers "<thing> <place>"
                _add("google_maps", q, group)
            else:
                if location:
                    q += f" in {location}"
                _add("google", q, group)

    if with_sites:
        anchor = f"cheap apartments in {location}" if location else "cheap apartments"
        for site in sites or LISTING_SITES:
            _add("google", f"{anchor} site:{site}", "sources")

    return plan

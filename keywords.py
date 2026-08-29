"""SerpAPI (Google engine) search-query keywords tuned to surface CHEAP apartment
listings. Mirror of src/keywords.js for the Python scraper.

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


def build_queries(
    location: str = "",
    max_price: int | None = None,
    groups: list[str] | None = None,
    with_sites: bool = False,
) -> list[str]:
    """Expand the base keywords into concrete SerpAPI query strings (deduped)."""
    if groups:
        base = [kw for g in groups for kw in KEYWORD_GROUPS.get(g, ())]
    else:
        base = list(CHEAP_APARTMENT_KEYWORDS)

    queries: list[str] = []
    for kw in base:
        q = kw
        if max_price:
            q += f" under ${max_price}"
        if location:
            q += f" in {location}"
        queries.append(q)

    if with_sites:
        anchor = f"cheap apartments in {location}" if location else "cheap apartments"
        queries.extend(f"{anchor} site:{site}" for site in LISTING_SITES)

    # De-dupe, preserve order.
    seen: set[str] = set()
    return [q for q in queries if not (q in seen or seen.add(q))]

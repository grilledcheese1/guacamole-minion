// SerpAPI (Google engine) search-query keywords tuned to surface CHEAP apartment
// listings. Feed each string to SerpAPI as the `q` parameter, optionally with
// `location` set, e.g.:
//
//   client.search({ engine: "google", q, location: "Austin, Texas" })
//
// Grouped by intent so you can pick a subset instead of firing all of them.

export const KEYWORD_GROUPS = {
  // Plain "make it cheap" phrasing
  budget: [
    "cheap apartments for rent",
    "affordable apartments for rent",
    "budget apartments for rent",
    "low cost apartments for rent",
    "inexpensive apartments for rent",
    "cheapest apartments for rent near me",
  ],

  // Price-anchored queries (Google surfaces listing filters for these)
  priceCapped: [
    "apartments for rent under $800",
    "apartments for rent under $1000",
    "apartments for rent under $1200",
    "apartments for rent under $1500",
    "studio apartments under $900",
    "1 bedroom apartments under $1100",
  ],

  // Subsidized / income-based housing
  assistance: [
    "low income apartments for rent",
    "income restricted apartments",
    "section 8 apartments for rent",
    "affordable housing apartments waitlist",
    "HUD apartments for rent",
    "sliding scale rent apartments",
  ],

  // Lower-barrier-to-entry listings (often the cheapest in practice)
  lowBarrier: [
    "no credit check apartments for rent",
    "apartments no application fee",
    "second chance apartments bad credit",
    "no deposit apartments for rent",
    "month to month apartments cheap",
  ],

  // Deals and concessions that cut effective rent
  deals: [
    "move in specials apartments",
    "first month free apartment deals",
    "apartment rent concessions this month",
    "utilities included cheap apartments",
    "reduced rent apartments available now",
  ],

  // Cheaper unit types / arrangements
  unitTypes: [
    "cheap studio apartments for rent",
    "cheap 1 bedroom apartments for rent",
    "cheap basement apartment for rent",
    "cheap in law suite for rent",
    "cheap room for rent in apartment",
    "cheap furnished apartments short term",
  ],

  // Source-specific scrapes (site: filter added by buildQueries when requested)
  sources: [
    "cheap apartments for rent craigslist",
    "cheap apartments for rent zillow",
    "cheap apartments apartments.com",
    "cheap apartments hotpads",
    "cheap apartments zumper",
    "cheap apartments facebook marketplace",
  ],
};

// Flat array of every keyword across all groups.
export const CHEAP_APARTMENT_KEYWORDS = Object.values(KEYWORD_GROUPS).flat();

// Listing sites worth constraining a query to with `site:`.
export const LISTING_SITES = [
  "zillow.com",
  "apartments.com",
  "craigslist.org",
  "trulia.com",
  "hotpads.com",
  "zumper.com",
  "rent.com",
  "padmapper.com",
  "affordablehousing.com",
];

/**
 * Expand the base keywords into concrete SerpAPI query strings.
 *
 * @param {object}   opts
 * @param {string}   [opts.location]  e.g. "Austin, Texas" — appended to the query text
 * @param {number}   [opts.maxPrice]  appends "under $<maxPrice>"
 * @param {string[]} [opts.groups]    subset of KEYWORD_GROUPS keys; defaults to all
 * @param {boolean}  [opts.withSites] also emit `<keyword> site:<domain>` variants
 * @returns {string[]} deduped list of query strings
 */
export function buildQueries({
  location = "",
  maxPrice,
  groups,
  withSites = false,
} = {}) {
  const base = groups
    ? groups.flatMap((g) => KEYWORD_GROUPS[g] ?? [])
    : CHEAP_APARTMENT_KEYWORDS;

  const queries = base.map((kw) => {
    let q = kw;
    if (maxPrice) q += ` under $${maxPrice}`;
    if (location) q += ` in ${location}`;
    return q;
  });

  if (withSites) {
    for (const site of LISTING_SITES) {
      const anchor = location ? `cheap apartments in ${location}` : "cheap apartments";
      queries.push(`${anchor} site:${site}`);
    }
  }

  return [...new Set(queries)];
}

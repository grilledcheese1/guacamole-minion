// Filter/sort state <-> URL query string <-> /api/listings params.
//
// The browser URL query string mirrors the API params 1:1 (so a link is
// shareable and replays the exact search), plus `address` for redisplaying the
// geocoded location without re-hitting the Geocoding API.

import { KEYWORD_GROUPS, LISTING_SITES } from "../keywords.js";

export const PRICE_MIN = 0;
export const PRICE_MAX = 5000;
export const PRICE_STEP = 50;

// Radius slider stops. Index 0 == "Any distance" (no radius filter); the rest
// are the required 1 / 5 / 10 / 25 mile options.
export const RADIUS_STOPS = [null, 1, 5, 10, 25];
export const RADIUS_VALUES = RADIUS_STOPS.filter((v) => v != null);

export const SORT_OPTIONS = [
  { value: "newest", label: "Recently seen" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
  { value: "distance", label: "Distance", needsPoint: true },
];
const SORT_VALUES = new Set(SORT_OPTIONS.map((o) => o.value));

export const BEDROOM_OPTIONS = [
  { value: null, label: "Any" },
  { value: 0, label: "Studio" },
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
];

// DB `listings.keyword_group` holds the snake_case form of the src/keywords.js
// KEYWORD_GROUPS keys. The six groups called for, in order.
const GROUP_CAMEL_TO_SNAKE = {
  budget: "budget",
  priceCapped: "price_capped",
  assistance: "assistance",
  lowBarrier: "low_barrier",
  deals: "deals",
  unitTypes: "unit_types",
  sources: "sources",
};
const GROUP_LABELS = {
  budget: "Budget",
  assistance: "Assistance",
  low_barrier: "Low-barrier",
  deals: "Deals",
  unit_types: "Unit types",
  sources: "Sources",
};
export const KEYWORD_GROUP_OPTIONS = [
  "budget",
  "assistance",
  "lowBarrier",
  "deals",
  "unitTypes",
  "sources",
]
  .filter((key) => key in KEYWORD_GROUPS)
  .map((key) => {
    const value = GROUP_CAMEL_TO_SNAKE[key];
    return { value, label: GROUP_LABELS[value] };
  });
const KEYWORD_GROUP_VALUES = new Set(KEYWORD_GROUP_OPTIONS.map((o) => o.value));

export const SOURCE_SITE_OPTIONS = LISTING_SITES;

export const DEFAULT_FILTERS = {
  address: "",
  lat: null,
  lng: null,
  radiusMiles: null,
  minPrice: null,
  maxPrice: null,
  bedrooms: null,
  keywordGroups: [],
  sourceSite: "",
  sort: "newest",
};

function toNumberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function filtersFromSearchParams(input) {
  const sp =
    input instanceof URLSearchParams ? input : new URLSearchParams(input || "");

  const lat = toNumberOrNull(sp.get("lat"));
  const lng = toNumberOrNull(sp.get("lng"));
  const hasPoint = lat != null && lng != null;

  const radius = toNumberOrNull(sp.get("radiusMiles"));
  const bedrooms = toNumberOrNull(sp.get("bedrooms"));

  const rawSort = sp.get("sort") || "newest";
  let sort = SORT_VALUES.has(rawSort) ? rawSort : "newest";
  if (sort === "distance" && !hasPoint) sort = "newest";

  return {
    ...DEFAULT_FILTERS,
    address: sp.get("address") || "",
    lat: hasPoint ? lat : null,
    lng: hasPoint ? lng : null,
    radiusMiles:
      hasPoint && RADIUS_VALUES.includes(radius) ? radius : null,
    minPrice: toNumberOrNull(sp.get("minPrice")),
    maxPrice: toNumberOrNull(sp.get("maxPrice")),
    bedrooms:
      bedrooms != null && BEDROOM_OPTIONS.some((o) => o.value === bedrooms)
        ? bedrooms
        : null,
    keywordGroups: sp
      .getAll("keywordGroup")
      .flatMap((v) => v.split(","))
      .map((v) => v.trim())
      .filter((v) => KEYWORD_GROUP_VALUES.has(v)),
    sourceSite: SOURCE_SITE_OPTIONS.includes(sp.get("sourceSite") || "")
      ? sp.get("sourceSite")
      : "",
    sort,
  };
}

/** Browser address-bar query string — shareable, mirrors the API params. */
export function filtersToSearchParams(filters) {
  const sp = new URLSearchParams();
  if (filters.address) sp.set("address", filters.address);
  if (filters.lat != null && filters.lng != null) {
    sp.set("lat", String(filters.lat));
    sp.set("lng", String(filters.lng));
    if (filters.radiusMiles != null) {
      sp.set("radiusMiles", String(filters.radiusMiles));
    }
  }
  if (filters.minPrice != null) sp.set("minPrice", String(filters.minPrice));
  if (filters.maxPrice != null) sp.set("maxPrice", String(filters.maxPrice));
  if (filters.bedrooms != null) sp.set("bedrooms", String(filters.bedrooms));
  for (const group of filters.keywordGroups) sp.append("keywordGroup", group);
  if (filters.sourceSite) sp.set("sourceSite", filters.sourceSite);
  if (filters.sort && filters.sort !== "newest") sp.set("sort", filters.sort);
  return sp;
}

/** Params object for useListings -> GET /api/listings (adds limit, drops address). */
export function filtersToApiParams(filters, limit = 300) {
  const params = { limit };
  const hasPoint = filters.lat != null && filters.lng != null;

  if (hasPoint) {
    params.lat = filters.lat;
    params.lng = filters.lng;
    if (filters.radiusMiles != null) params.radiusMiles = filters.radiusMiles;
  }
  if (filters.minPrice != null) params.minPrice = filters.minPrice;
  if (filters.maxPrice != null) params.maxPrice = filters.maxPrice;
  if (filters.bedrooms != null) params.bedrooms = filters.bedrooms;
  if (filters.keywordGroups.length) {
    params.keywordGroup = filters.keywordGroups; // array -> repeated query param
  }
  if (filters.sourceSite) params.sourceSite = filters.sourceSite;

  const sort =
    filters.sort === "distance" && !hasPoint ? "newest" : filters.sort;
  if (sort && sort !== "newest") params.sort = sort;

  return params;
}

export function countActiveFilters(filters) {
  let n = 0;
  if (filters.lat != null && filters.lng != null) n += 1;
  if (filters.minPrice != null || filters.maxPrice != null) n += 1;
  if (filters.bedrooms != null) n += 1;
  n += filters.keywordGroups.length;
  if (filters.sourceSite) n += 1;
  return n;
}

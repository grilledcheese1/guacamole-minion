// Small formatting helpers shared by the listings UI.

/**
 * Parse a timestamp from the API. SQLite's `datetime('now')` values look like
 * "YYYY-MM-DD HH:MM:SS" and are UTC without a zone marker; ISO strings (from
 * listed_at) pass straight through.
 */
export function parseDbDate(value) {
  if (!value) return null;
  const isSqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
  const normalized = isSqlite ? `${value.replace(" ", "T")}Z` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

const AGO_UNITS = [
  ["yr", 31_536_000],
  ["mo", 2_592_000],
  ["wk", 604_800],
  ["d", 86_400],
  ["h", 3_600],
  ["m", 60],
];

/** "seen X ago" style relative time, or null when unparseable. */
export function timeAgo(value) {
  const date = parseDbDate(value);
  if (!date) return null;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  for (const [label, size] of AGO_UNITS) {
    if (seconds >= size) return `${Math.floor(seconds / size)}${label} ago`;
  }
  return "just now";
}

export function formatPrice(value) {
  if (value == null) return "Price N/A";
  return `$${Number(value).toLocaleString("en-US")}`;
}

export function formatDistance(miles) {
  if (miles == null) return null;
  return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
}

export function formatBeds(bedrooms) {
  if (bedrooms == null) return null;
  if (bedrooms === 0) return "Studio";
  const n = bedrooms % 1 === 0 ? bedrooms : bedrooms.toFixed(1);
  return `${n} bd`;
}

export function formatSqft(sqft) {
  if (sqft == null) return null;
  return `${Number(sqft).toLocaleString("en-US")} sqft`;
}

/** Tidy a listings.source value ("https://www.zillow.com/x" -> "zillow.com"). */
export function cleanSource(source) {
  if (!source) return null;
  return String(source)
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

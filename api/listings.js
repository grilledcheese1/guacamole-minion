// Vercel serverless function — read + patch apartment listings in the same
// Turso (libSQL) database that apartments.py writes to.
//
// GET /api/listings
//   Query params (all optional):
//     lat, lng         center point, decimal degrees (must be given together)
//     radiusMiles      only return listings within this many miles of lat/lng
//     minPrice         inclusive lower price bound (USD)
//     maxPrice         inclusive upper price bound (USD)
//     bedrooms         exact bedroom count (e.g. 1, 2, 1.5)
//     keywordGroup     listings.keyword_group bucket (budget, price_capped, ...).
//                      Repeatable / comma-separated -> matches any of the buckets.
//     sourceSite       case-insensitive substring match against listings.source
//     sort             price_asc | price_desc | distance | newest (default newest)
//     limit            max rows returned, 1..1000 (default 200)
//     includeDismissed 1/true -> also return status='dismissed' rows (default: hidden)
//   Each listing includes `status`: active | unavailable | dismissed.
//   status='unavailable' rows are always returned (the UI greys them out).
//
// PATCH|POST /api/listings   { "id": <number>, "status": "dismissed" | "active" }
//   Sets a listing's lifecycle status (the "Not interested" / undo action).
//
// Radius search: a bounding-box prefilter runs in SQL, then an exact haversine
// distance is computed in JS and used to filter (and, for sort=distance, order)
// the candidates.
//
// Env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN

import { createClient } from "@libsql/client";

const EARTH_RADIUS_MILES = 3958.7613;
const MILES_PER_DEG_LAT = 69.0;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const SAFETY_CAP = 5000; // ceiling on rows pulled from SQL before JS filtering

const ALLOWED_SORTS = new Set(["price_asc", "price_desc", "distance", "newest"]);

let cachedClient;

function getClient() {
  if (!cachedClient) {
    const url = process.env.TURSO_DATABASE_URL;
    if (!url) throw new Error("TURSO_DATABASE_URL is not set");
    cachedClient = createClient({
      url,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return cachedClient;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
}

function firstValue(v) {
  return Array.isArray(v) ? v[0] : v;
}

function parseNumberParam(value, name, errors) {
  const raw = firstValue(value);
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    errors.push(`${name} must be a number`);
    return undefined;
  }
  return n;
}

function parseStringParam(value) {
  const raw = firstValue(value);
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || undefined;
}

// Repeatable and/or comma-separated param -> de-duped list of non-empty values.
function parseListParam(value) {
  const raw = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const seen = new Set();
  for (const entry of raw) {
    for (const piece of String(entry).split(",")) {
      const trimmed = piece.trim();
      if (trimmed) seen.add(trimmed);
    }
  }
  return [...seen];
}

function parseBoolParam(value) {
  const raw = String(firstValue(value) ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  let raw = "";
  try {
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") return handleList(req, res);
  if (req.method === "PATCH" || req.method === "POST") {
    return handleStatusUpdate(req, res);
  }
  res.setHeader("Allow", "GET, PATCH, POST");
  return res.status(405).json({ error: "Method not allowed" });
}

// --- PATCH|POST: set a listing's lifecycle status ------------------------
async function handleStatusUpdate(req, res) {
  const body = await readJsonBody(req);
  const id = Number(body?.id);
  const status = String(body?.status ?? "").trim();

  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "id (positive integer) is required" });
  }
  if (status !== "dismissed" && status !== "active") {
    return res
      .status(400)
      .json({ error: 'status must be "dismissed" or "active"' });
  }

  try {
    const result = await getClient().execute({
      sql: "UPDATE listings SET status = ? WHERE id = ?",
      args: [status, id],
    });
    if (!Number(result.rowsAffected)) {
      return res.status(404).json({ error: "listing not found" });
    }
  } catch (err) {
    return res.status(500).json({
      error: "Database update failed",
      detail: String(err?.message ?? err),
    });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ id, status });
}

// --- GET: list listings -----------------------------------------------
async function handleList(req, res) {
  // Vercel populates req.query; parse from the URL as a fallback.
  const query =
    req.query ??
    Object.fromEntries(new URL(req.url, "http://localhost").searchParams);

  const errors = [];
  const lat = parseNumberParam(query.lat, "lat", errors);
  const lng = parseNumberParam(query.lng, "lng", errors);
  const radiusMiles = parseNumberParam(query.radiusMiles, "radiusMiles", errors);
  const minPrice = parseNumberParam(query.minPrice, "minPrice", errors);
  const maxPrice = parseNumberParam(query.maxPrice, "maxPrice", errors);
  const bedrooms = parseNumberParam(query.bedrooms, "bedrooms", errors);
  const keywordGroups = parseListParam(query.keywordGroup);
  const sourceSite = parseStringParam(query.sourceSite);
  const includeDismissed = parseBoolParam(query.includeDismissed);
  const sort = parseStringParam(query.sort) ?? "newest";

  let limit = parseNumberParam(query.limit, "limit", errors) ?? DEFAULT_LIMIT;
  limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));

  if (!ALLOWED_SORTS.has(sort)) {
    errors.push(`sort must be one of: ${[...ALLOWED_SORTS].join(", ")}`);
  }
  if ((lat === undefined) !== (lng === undefined)) {
    errors.push("lat and lng must be provided together");
  }
  if (radiusMiles !== undefined && (lat === undefined || lng === undefined)) {
    errors.push("radiusMiles requires lat and lng");
  }
  if (radiusMiles !== undefined && radiusMiles <= 0) {
    errors.push("radiusMiles must be greater than 0");
  }

  const hasPoint = lat !== undefined && lng !== undefined;
  const wantRadius = hasPoint && radiusMiles !== undefined && radiusMiles > 0;

  if (sort === "distance" && !hasPoint) {
    errors.push("sort=distance requires lat and lng");
  }

  if (errors.length) {
    return res
      .status(400)
      .json({ error: "Invalid query parameters", details: errors });
  }

  // --- Build the SQL --------------------------------------------------------
  const where = [];
  const args = [];

  if (minPrice !== undefined) {
    where.push("l.price >= ?");
    args.push(minPrice);
  }
  if (maxPrice !== undefined) {
    where.push("l.price <= ?");
    args.push(maxPrice);
  }
  if (bedrooms !== undefined) {
    where.push("l.bedrooms = ?");
    args.push(bedrooms);
  }
  if (keywordGroups.length === 1) {
    where.push("l.keyword_group = ?");
    args.push(keywordGroups[0]);
  } else if (keywordGroups.length > 1) {
    where.push(
      `l.keyword_group IN (${keywordGroups.map(() => "?").join(", ")})`,
    );
    args.push(...keywordGroups);
  }
  if (sourceSite) {
    where.push("LOWER(l.source) LIKE '%' || LOWER(?) || '%'");
    args.push(sourceSite);
  }
  if (!includeDismissed) {
    // `unavailable` rows stay in (the UI greys them); only hide `dismissed`.
    where.push("COALESCE(l.status, 'active') <> 'dismissed'");
  }

  if (wantRadius) {
    // Bounding-box prefilter: cheap, index-friendly, over-selects slightly.
    const latDelta = radiusMiles / MILES_PER_DEG_LAT;
    const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
    const lngDelta = radiusMiles / (MILES_PER_DEG_LAT * cosLat);
    where.push(
      "l.lat IS NOT NULL AND l.lng IS NOT NULL " +
        "AND l.lat BETWEEN ? AND ? AND l.lng BETWEEN ? AND ?",
    );
    args.push(lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta);
  } else if (sort === "distance") {
    where.push("l.lat IS NOT NULL AND l.lng IS NOT NULL");
  }

  let orderBy;
  switch (sort) {
    case "price_asc":
      orderBy = "l.price IS NULL, l.price ASC";
      break;
    case "price_desc":
      orderBy = "l.price IS NULL, l.price DESC";
      break;
    default: // "newest" and "distance" (distance is re-sorted in JS)
      orderBy = "COALESCE(l.listed_at, l.created_at) DESC";
      break;
  }

  // Push LIMIT into SQL only when JS won't re-filter/re-order the result.
  const needsJsPass = wantRadius || sort === "distance";
  const sqlLimit = needsJsPass ? SAFETY_CAP : limit;

  const sql = `
    WITH ph_ranked AS (
      SELECT
        listing_id,
        price,
        observed_at,
        ROW_NUMBER() OVER (
          PARTITION BY listing_id
          ORDER BY datetime(observed_at) DESC, id DESC
        ) AS rn,
        COUNT(*) OVER (PARTITION BY listing_id) AS observation_count
      FROM price_history
    ),
    ph AS (
      SELECT
        cur.listing_id,
        cur.price             AS latest_price,
        cur.observed_at       AS latest_observed_at,
        prev.price            AS previous_price,
        prev.observed_at      AS previous_observed_at,
        cur.observation_count AS observation_count
      FROM ph_ranked cur
      LEFT JOIN ph_ranked prev
        ON prev.listing_id = cur.listing_id AND prev.rn = 2
      WHERE cur.rn = 1
    )
    SELECT
      l.id, l.source, l.title, l.price, l.bedrooms, l.address, l.url,
      l.sqft, l.image_url, l.listed_at, l.keyword_group, l.last_seen_at,
      l.created_at, l.lat, l.lng, l.status, l.location_precision,
      ph.latest_price, ph.previous_price,
      ph.latest_observed_at, ph.previous_observed_at, ph.observation_count
    FROM listings l
    LEFT JOIN ph ON ph.listing_id = l.id
    ${where.length ? `WHERE ${where.join("\n      AND ")}` : ""}
    ORDER BY ${orderBy}
    LIMIT ?
  `;
  args.push(sqlLimit);

  let rows;
  try {
    ({ rows } = await getClient().execute({ sql, args }));
  } catch (err) {
    return res.status(500).json({
      error: "Database query failed",
      detail: String(err?.message ?? err),
    });
  }

  // --- Shape rows + haversine pass ----------------------------------------
  let listings = rows.map((r) => {
    const price = r.price ?? r.latest_price ?? null;
    const previousPrice = r.previous_price ?? null;
    const priceDelta =
      price !== null && previousPrice !== null ? price - previousPrice : null;

    const listing = {
      id: r.id,
      source: r.source,
      title: r.title,
      url: r.url,
      price,
      bedrooms: r.bedrooms,
      sqft: r.sqft,
      address: r.address,
      imageUrl: r.image_url,
      lat: r.lat,
      lng: r.lng,
      status: r.status ?? "active",
      locationPrecision: r.location_precision ?? null,
      listedAt: r.listed_at,
      keywordGroup: r.keyword_group,
      lastSeenAt: r.last_seen_at,
      createdAt: r.created_at,
      priceDelta,
      previousPrice,
      priceHistory: {
        latestPrice: r.latest_price ?? null,
        previousPrice,
        delta: priceDelta,
        latestObservedAt: r.latest_observed_at ?? null,
        previousObservedAt: r.previous_observed_at ?? null,
        observationCount: Number(r.observation_count ?? 0),
      },
    };

    if (hasPoint && r.lat !== null && r.lng !== null) {
      listing.distanceMiles =
        Math.round(haversineMiles(lat, lng, r.lat, r.lng) * 100) / 100;
    }
    return listing;
  });

  if (wantRadius) {
    listings = listings.filter(
      (l) => l.distanceMiles !== undefined && l.distanceMiles <= radiusMiles,
    );
  }

  if (sort === "distance") {
    listings.sort(
      (a, b) => (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity),
    );
  }

  const limited = listings.slice(0, limit);

  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  return res.status(200).json({
    count: limited.length,
    sort,
    limit,
    filters: {
      lat: lat ?? null,
      lng: lng ?? null,
      radiusMiles: radiusMiles ?? null,
      minPrice: minPrice ?? null,
      maxPrice: maxPrice ?? null,
      bedrooms: bedrooms ?? null,
      keywordGroup: keywordGroups.length ? keywordGroups : null,
      sourceSite: sourceSite ?? null,
      includeDismissed,
    },
    listings: limited,
  });
}

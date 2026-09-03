// Vercel serverless function — full wipe of the scraped-data tables
// (`listings` + `price_history`), for the header's "Wipe data" button.
//
// Deliberately NOT `geocode_cache`: that's unrelated to listing data and
// expensive to rebuild (real Google Geocoding API calls), so a listings wipe
// shouldn't force re-paying for it.
//
// Gated by re-submitting SITE_PASSWORD in the request body — independent of
// the site-gate cookie every request already carries (middleware.js). That
// cookie proves "you got past the gate once, 30 days ago"; this proves
// "you're deliberately doing this, right now" — a second, explicit
// confirmation for an action with no undo.
//
// POST /api/wipe-data   { "password": "..." }
//   -> 200 { ok: true, deletedListings, deletedPriceHistory }
//   -> 400 { error }   malformed body
//   -> 401 { error }   wrong password
//   -> 501 { error }   SITE_PASSWORD not configured on the server
//   -> 500 { error }   db failure
//
// Env: SITE_PASSWORD, TURSO_DATABASE_URL, TURSO_AUTH_TOKEN

import { createClient } from "@libsql/client";
import { createHash, timingSafeEqual } from "node:crypto";

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

function sha256(value) {
  return createHash("sha256").update(String(value)).digest();
}

// Constant-time compare (via fixed-length SHA-256 digests, so length itself
// never leaks) — same approach middleware.js uses for the site-gate login.
function passwordMatches(submitted, expected) {
  return timingSafeEqual(sha256(submitted ?? ""), sha256(expected));
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
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Cache-Control", "no-store");

  const sitePassword = process.env.SITE_PASSWORD;
  if (!sitePassword) {
    return res
      .status(501)
      .json({ error: "SITE_PASSWORD is not configured on the server" });
  }

  const body = await readJsonBody(req);
  if (!passwordMatches(body?.password, sitePassword)) {
    return res.status(401).json({ error: "Incorrect password" });
  }

  try {
    const client = getClient();
    // price_history first — listings.id is its FK; deleting listings first
    // would leave orphaned rows if the backend doesn't enforce ON DELETE
    // CASCADE (SQLite/libSQL only do when foreign_keys is explicitly ON).
    const ph = await client.execute("DELETE FROM price_history");
    const listings = await client.execute("DELETE FROM listings");
    return res.status(200).json({
      ok: true,
      deletedListings: listings.rowsAffected ?? null,
      deletedPriceHistory: ph.rowsAffected ?? null,
    });
  } catch (err) {
    return res.status(500).json({
      error: "Database wipe failed",
      detail: String(err?.message ?? err),
    });
  }
}

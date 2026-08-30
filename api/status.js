// Vercel serverless function — lightweight freshness snapshot for the header.
//
// GET /api/status
//   -> { lastUpdated, count, activeCount }
//
// `lastUpdated` is the most recent last_seen_at / created_at across all listings
// (SQLite "YYYY-MM-DD HH:MM:SS" UTC string, or null when the table is empty).
//
// Env: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN

import { createClient } from "@libsql/client";

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

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { rows } = await getClient().execute(
      `SELECT
         MAX(COALESCE(last_seen_at, created_at)) AS last_updated,
         COUNT(*) AS total,
         SUM(CASE WHEN COALESCE(status, 'active') = 'active' THEN 1 ELSE 0 END) AS active
       FROM listings`,
    );
    const row = rows[0] ?? {};
    res.setHeader(
      "Cache-Control",
      "s-maxage=30, stale-while-revalidate=120",
    );
    return res.status(200).json({
      lastUpdated: row.last_updated ?? null,
      count: Number(row.total ?? 0),
      activeCount: Number(row.active ?? 0),
    });
  } catch (err) {
    return res.status(500).json({
      error: "status query failed",
      detail: String(err?.message ?? err),
    });
  }
}

// Vercel serverless function — dispatch the GitHub Actions `scrape.yml` workflow
// on demand (the app's "Run scrape now" button), optionally scoped to whatever
// filters were active in the browser when it was clicked.
//
// POST /api/trigger-scrape
//   Body (all optional — omit/blank runs the original unscoped, nationwide
//   sweep of every keyword group):
//     { "location": "Austin, TX", "maxPrice": 1200, "minPrice": 800,
//       "bedrooms": 2, "keywordGroups": ["budget"], "sourceSite": "zillow.com",
//       "lat": 30.267, "lng": -97.743, "radiusMiles": 5 }
//   -> 200 { ok: true, dispatchedAt, workflow, ref, scope }  workflow queued
//   -> 429 { error, retryAfterSeconds, lastRunAt }           a run started < 5 min ago
//   -> 501 { error }                                         server not configured
//   -> 502 { error, githubStatus, detail }                   GitHub rejected it
//
// The body is forwarded as scrape.yml's workflow_dispatch inputs (location,
// max_price, min_price, bedrooms, groups, sites, lat, lng, radius_miles),
// which it maps to SCRAPE_* env vars for apartments.py to read into
// keywords.build_search_plan(...) and apartments.radius_to_ll(...).
// keywordGroups/sourceSite values must match apartments.py's
// keywords.KEYWORD_GROUPS keys / LISTING_SITES entries (same strings
// src/lib/filters.js already uses) — anything else is silently dropped
// rather than forwarded to a run that won't recognize it. bedrooms/lat/lng
// are bounds-checked; radiusMiles only takes effect when lat+lng are both
// present (see apartments.radius_to_ll — it's an approximation, since neither
// SerpAPI engine has a real numeric-radius parameter).
//
// Env:
//   GITHUB_TOKEN     (required) PAT with `repo` scope, or fine-grained with
//                    "Actions: read and write" on the repo.
//   GITHUB_REPO      owner/repo. Falls back to Vercel's VERCEL_GIT_REPO_OWNER /
//                    VERCEL_GIT_REPO_SLUG (set automatically on Git-connected
//                    Vercel deploys).
//   SCRAPE_WORKFLOW  workflow file name (default: "scrape.yml")
//   SCRAPE_REF       git ref to run on (default: VERCEL_GIT_COMMIT_REF or "main")

import {
  GITHUB_API,
  githubHeaders,
  resolveRepo,
  scrapeWorkflowName,
} from "./_github.js";
import { readJsonBody } from "./_http.js";

const COOLDOWN_MS = 5 * 60 * 1000;
const MAX_LOCATION_LEN = 200;

// apartments.py's keywords.KEYWORD_GROUPS keys — kept in sync by hand (small,
// stable set; see that file's docstring, "Mirror of src/keywords.js").
const KNOWN_GROUPS = new Set([
  "budget",
  "price_capped",
  "assistance",
  "low_barrier",
  "deals",
  "unit_types",
  "sources",
]);

// apartments.py's keywords.LISTING_SITES — same hand-synced rationale.
const KNOWN_SITES = new Set([
  "zillow.com",
  "apartments.com",
  "craigslist.org",
  "trulia.com",
  "hotpads.com",
  "zumper.com",
  "rent.com",
  "padmapper.com",
  "affordablehousing.com",
]);

// src/lib/filters.js's BEDROOM_OPTIONS values (null/"Any" just omits it).
const KNOWN_BEDROOMS = new Set([0, 1, 2, 3]);

function positiveIntOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Trust nothing from the request body beyond what the workflow inputs can
 * actually use — GitHub requires every workflow_dispatch input as a string. */
function sanitizeScope(body) {
  const location =
    typeof body?.location === "string"
      ? body.location.trim().slice(0, MAX_LOCATION_LEN)
      : "";

  const maxPrice = positiveIntOrNull(body?.maxPrice);
  const minPrice = positiveIntOrNull(body?.minPrice);

  const bedroomsNum = Number(body?.bedrooms);
  const bedrooms = KNOWN_BEDROOMS.has(bedroomsNum) ? bedroomsNum : null;

  const groupsIn = Array.isArray(body?.keywordGroups) ? body.keywordGroups : [];
  const groups = [...new Set(groupsIn.map(String))].filter((g) =>
    KNOWN_GROUPS.has(g),
  );

  const sourceSite =
    typeof body?.sourceSite === "string" && KNOWN_SITES.has(body.sourceSite)
      ? body.sourceSite
      : "";

  // Radius only makes sense with a real point — validate lat/lng together and
  // drop radius if either is missing/out of range, rather than sending GitHub
  // a radius with no center to apply it around.
  const latNum = Number(body?.lat);
  const lngNum = Number(body?.lng);
  const hasPoint =
    Number.isFinite(latNum) &&
    Number.isFinite(lngNum) &&
    latNum >= -90 &&
    latNum <= 90 &&
    lngNum >= -180 &&
    lngNum <= 180;
  const lat = hasPoint ? latNum : null;
  const lng = hasPoint ? lngNum : null;
  const radiusMiles = hasPoint ? positiveIntOrNull(body?.radiusMiles) : null;

  return {
    location,
    maxPrice,
    minPrice,
    bedrooms,
    groups,
    sourceSite,
    lat,
    lng,
    radiusMiles,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  res.setHeader("Cache-Control", "no-store");

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return res
      .status(501)
      .json({ error: "GITHUB_TOKEN is not configured on the server" });
  }
  const target = resolveRepo();
  if (!target) {
    return res.status(501).json({
      error:
        "Repository not resolved — set GITHUB_REPO=owner/repo (Git-connected Vercel deploys set this automatically)",
    });
  }

  const body = await readJsonBody(req);
  const scope = sanitizeScope(body);

  const { owner, repo } = target;
  const workflow = scrapeWorkflowName();
  const ref = (
    process.env.SCRAPE_REF ||
    process.env.VERCEL_GIT_COMMIT_REF ||
    "main"
  ).trim();
  const workflowUrl = `${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(
    workflow,
  )}`;

  // --- server-side cooldown: block if the workflow ran in the last 5 min ---
  try {
    const runsRes = await fetch(`${workflowUrl}/runs?per_page=1`, {
      headers: githubHeaders(token),
    });
    if (runsRes.ok) {
      const data = await runsRes.json();
      const last = data.workflow_runs?.[0];
      if (last?.created_at) {
        const age = Date.now() - new Date(last.created_at).getTime();
        if (age >= 0 && age < COOLDOWN_MS) {
          const retryAfterSeconds = Math.ceil((COOLDOWN_MS - age) / 1000);
          res.setHeader("Retry-After", String(retryAfterSeconds));
          return res.status(429).json({
            error: "A scrape ran recently — try again in a few minutes",
            retryAfterSeconds,
            lastRunAt: last.created_at,
            lastRunStatus: last.status,
          });
        }
      }
    }
    // A non-OK runs query (e.g. 404 for an unknown workflow) is left for the
    // dispatch call below to report with a clearer message.
  } catch {
    // Couldn't check recent runs (network) — fall through and try to dispatch.
  }

  // --- dispatch the workflow ---
  let dispatch;
  try {
    dispatch = await fetch(`${workflowUrl}/dispatches`, {
      method: "POST",
      headers: { ...githubHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        ref,
        inputs: {
          location: scope.location,
          max_price: scope.maxPrice != null ? String(scope.maxPrice) : "",
          min_price: scope.minPrice != null ? String(scope.minPrice) : "",
          bedrooms: scope.bedrooms != null ? String(scope.bedrooms) : "",
          groups: scope.groups.join(","),
          sites: scope.sourceSite,
          lat: scope.lat != null ? String(scope.lat) : "",
          lng: scope.lng != null ? String(scope.lng) : "",
          radius_miles: scope.radiusMiles != null ? String(scope.radiusMiles) : "",
        },
      }),
    });
  } catch (err) {
    return res.status(502).json({
      error: "Could not reach GitHub",
      detail: String(err?.message ?? err),
    });
  }

  if (dispatch.status === 204) {
    return res.status(200).json({
      ok: true,
      dispatchedAt: new Date().toISOString(),
      workflow,
      ref,
      scope,
    });
  }

  const detail = await dispatch.text().catch(() => "");
  const messages = {
    401: "GitHub rejected the token (401) — check GITHUB_TOKEN",
    403: "GitHub forbade the request (403) — the token needs Actions write access",
    404: `Workflow "${workflow}" not found on ${owner}/${repo} (404) — check the file name and that it has a workflow_dispatch trigger`,
    422: `GitHub could not process the request (422) — check that ref "${ref}" exists`,
  };
  return res.status(502).json({
    error: messages[dispatch.status] || `GitHub returned ${dispatch.status}`,
    githubStatus: dispatch.status,
    detail: detail.slice(0, 500),
  });
}

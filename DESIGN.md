# DESIGN.md — Target Architecture

Status: proposal. This describes where the apartment-hunting app is headed, not
what is built today. The visual system for the frontend is specified separately
in [`public/DESIGN.md`](public/DESIGN.md) (a design-token spec — colors,
typography, components — modeled on MongoDB's site); this document covers data
flow, hosting, schema, and features, and defers all styling decisions to that
file.

---

## 1. Current state and the gap

### What exists

| Piece | File(s) | Role |
| --- | --- | --- |
| Scraper / pipeline | `apartments.py` | SerpAPI Google search → `requests` fetch → `BeautifulSoup` parse → persist |
| Storage | `db.py` | stdlib `sqlite3`, single file `apartments.db` at the repo root |
| Curated queries | `keywords.py`, `src/keywords.js` | 7 keyword groups (`budget`, `price_capped`, `assistance`, `low_barrier`, `deals`, `unit_types`, `sources`) expanded into SerpAPI query strings |
| SerpAPI client | `serpapi_client.py`, `serpapiClient.js` | loads `SERPAPI_KEY` from `.env.local` |
| Frontend | `src/App.jsx` (Vite + React) | **preview only** — renders the list of query strings `buildQueries()` would send; reads no listing data |

The pipeline works locally: `python3 apartments.py "<query>"` (or no argument to
sweep the curated keyword list) fills `apartments.db`, whose schema is a single
`listings` table:

```
listings(id, source, title, price, bedrooms, address, url UNIQUE, raw_html, created_at)
```

### The gap

The frontend is meant to deploy to Vercel, but the data it needs to show lives in
a SQLite file on one laptop:

1. **Vercel cannot see `apartments.db`.** It is a local file, and it is
   `.gitignore`d (`*.db`), so it is never in the deploy bundle. Even if it were
   committed, a Vercel serverless function's filesystem is read-only and
   ephemeral — there is no durable, shared, writable SQLite file in that
   environment.
2. **Vercel cannot run the scraper.** `apartments.py` is Python with
   `beautifulsoup4` / `lxml` / `requests`, it makes paid SerpAPI calls, it
   fetches dozens of third-party pages per run, and a full keyword sweep runs far
   longer than a serverless function's execution limit. It is a batch job, not a
   request handler.

So today `src/App.jsx` can only preview query strings. To show real listings, the
scraper's output and the web app need to meet in a database both can reach over
the network.

---

## 2. Target architecture

Move storage off the local disk and into a **hosted [Turso](https://turso.tech/)
(libSQL) database**. libSQL is SQLite-compatible, so the existing SQL barely
changes; the difference is that the scraper connects to a URL instead of opening
a file, and a Vercel function can connect to that same URL.

```
                    ┌─────────────────────────────┐
   GitHub Actions   │  apartments.py (batch)      │   SerpAPI  ───► google search
   (or local run)   │  SerpAPI → BeautifulSoup    │   listing sites ───► HTML
                    │  → geocode → upsert         │
                    └──────────────┬──────────────┘
                                   │ libSQL write (network)
                                   │ TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
                                   ▼
                    ┌─────────────────────────────┐
                    │  Turso (libSQL) database    │  ◄── single source of truth
                    └──────────────┬──────────────┘
                                   │ libSQL read (network)
                                   │ TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
                                   ▼
                    ┌─────────────────────────────┐
   Vercel           │  api/listings.js            │  serverless function
                    │  read-only queries + filter │
                    └──────────────┬──────────────┘
                                   │ HTTP  GET /api/listings?...
                                   ▼
                    ┌─────────────────────────────┐
   Vercel           │  src/App.jsx (React)        │  list + map + drawer
                    │  fetch('/api/listings')     │  Google Maps JS SDK
                    └─────────────────────────────┘
```

### Component responsibilities

**`apartments.py` — writer (runs on GitHub Actions or a laptop, never on Vercel)**

- Same pipeline as today: `search_listings()` → `fetch_html()` → `parse_listing()`.
- `parse_listing()` gains best-effort extraction of `sqft`, `image_url` (og:image
  / first gallery image), and `listed_at` (posted date from the source page).
- New geocode step: resolve `address` → `lat`/`lng` via the Google Geocoding API,
  going through `geocode_cache` first (see §3) so repeat runs don't re-bill.
- Tags each row with the `keyword_group` that surfaced it (thread the group name
  through `build_queries()` / `run()`).
- `upsert_listing()` writes to Turso and additionally:
  - appends a `price_history` row when the price changed since last seen,
  - sets `last_seen_at` to the current run's timestamp on every upsert,
  - leaves `created_at` as first-seen.

**`db.py` — libSQL adapter**

- Replace the stdlib `sqlite3` connection with a libSQL client
  (`libsql-client` / `libsql-experimental` for Python, or the SQLAlchemy libSQL
  dialect). `get_connection()` reads `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`
  instead of computing a local `DB_PATH`.
- `init_db()` runs the same `CREATE TABLE IF NOT EXISTS` DDL plus the new tables
  and columns in §3. Keep the DDL idempotent so Actions can run it on every job.
- The `INSERT ... ON CONFLICT(url) DO UPDATE` upsert is valid libSQL as-is.
- Optional: keep a `--local` fallback that still opens `apartments.db` for
  offline development, selected by the absence of `TURSO_DATABASE_URL`.

**`api/listings.js` — reader (Vercel serverless function)**

- A Vite project on Vercel picks up a top-level `api/` directory as zero-config
  serverless functions, so `GET /api/listings` is served alongside the static
  build with no extra routing config.
- Connects with `@libsql/client` using `TURSO_DATABASE_URL` and
  `TURSO_AUTH_TOKEN` (a **read-only** Turso token is preferable here).
- Query params: `bounds` (map viewport) or `lat`/`lng`/`radius` (radius search),
  `minPrice`/`maxPrice`, `beds`, `minSqft`, `source`, `keywordGroup`, `sort`
  (`price`, `-price`, `newest`, `price_drop`), `limit`/`offset`.
- Selects explicit columns — **never `raw_html`** — and returns JSON:
  `{ listings: [...], total, bbox }`. Joins `price_history` to compute a
  `price_drop` field (previous price, current price, delta, %) for badges.
- Radius filter: bounding-box prefilter on `lat`/`lng` (indexed), then haversine
  refine in SQL or in JS on the page.

**`src/App.jsx` — reader UI**

- Replace the query-string preview with a `fetch('/api/listings')` data layer
  (React state / a small query hook).
- Renders the list + map + drawer described in §4, styled entirely per
  [`public/DESIGN.md`](public/DESIGN.md).
- Loads the Google Maps JavaScript SDK with `GOOGLE_MAPS_API_KEY` (the browser
  key — see §5).

### What runs where

| Concern | Home |
| --- | --- |
| SerpAPI calls, HTML fetch/parse, geocoding, DB writes | GitHub Actions (scheduled) or a laptop — **not Vercel** |
| DB reads, filtering, sorting, JSON API | Vercel serverless (`api/listings.js`) |
| List / map / drawer rendering | Vercel static (React build) |
| Source of truth | Turso (libSQL), reachable from both sides over the network |

---

## 3. Schema changes for map / radius support

All changes are additive and idempotent. Run them from `db.py`'s `init_db()`.

### `listings` — new columns

```sql
ALTER TABLE listings ADD COLUMN lat           REAL;   -- geocoded latitude
ALTER TABLE listings ADD COLUMN lng           REAL;   -- geocoded longitude
ALTER TABLE listings ADD COLUMN sqft          INTEGER;-- parsed unit size, best-effort
ALTER TABLE listings ADD COLUMN image_url     TEXT;   -- og:image / first gallery image
ALTER TABLE listings ADD COLUMN listed_at     TEXT;   -- date the source posted the listing, best-effort
ALTER TABLE listings ADD COLUMN keyword_group TEXT;   -- KEYWORD_GROUPS bucket that surfaced this row
ALTER TABLE listings ADD COLUMN last_seen_at  TEXT;   -- timestamp of the most recent scrape run that still saw this url
```

`created_at` keeps its current meaning (first seen). `last_seen_at` lets the UI
distinguish fresh listings from stale ones and lets a cleanup job retire rows not
seen in N runs.

Supporting indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_listings_latlng     ON listings(lat, lng);
CREATE INDEX IF NOT EXISTS idx_listings_price      ON listings(price);
CREATE INDEX IF NOT EXISTS idx_listings_last_seen  ON listings(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_listings_kw_group   ON listings(keyword_group);
```

### `price_history` — new table

One row per observed price for a listing; the scraper appends when the price
changes. Powers price-drop badges and price trend lines in the drawer.

```sql
CREATE TABLE IF NOT EXISTS price_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id  INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    price       INTEGER NOT NULL,
    observed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_price_history_listing ON price_history(listing_id, observed_at);
```

### `geocode_cache` — new table

Address → coordinates, keyed by a normalized address string, so repeated scrape
runs reuse results instead of re-billing the Geocoding API.

```sql
CREATE TABLE IF NOT EXISTS geocode_cache (
    query       TEXT PRIMARY KEY,       -- normalized address text sent to the geocoder
    lat         REAL,
    lng         REAL,
    formatted   TEXT,                   -- geocoder's formatted_address
    provider    TEXT NOT NULL DEFAULT 'google',
    status      TEXT,                   -- OK / ZERO_RESULTS / ... so misses are cached too
    geocoded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Cache misses (`ZERO_RESULTS`) are stored too, so an unparseable address isn't
retried every run. Add a TTL sweep later if listings move.

---

## 4. Prioritized feature list

Ordered by dependency and value. P0 unblocks a usable public deploy; P1 is the
core hunting experience; P2 is polish.

| Priority | Feature | Depends on | Notes |
| --- | --- | --- | --- |
| **P0** | Turso migration (`db.py` + `apartments.py` write over the network) | §2 | Nothing else in this list works until the data is hosted. |
| **P0** | `api/listings.js` read endpoint | Turso migration | Explicit columns, no `raw_html`, filter/sort params, JSON. |
| **P0** | List view reads real data | `api/listings.js` | Replace the query-string preview in `src/App.jsx` with `fetch('/api/listings')`. Card layout per [`public/DESIGN.md`](public/DESIGN.md). |
| **P0** | Access gate before the URL goes public | Vercel deploy | Gate the deploy before sharing the link — Vercel password protection, a shared-passphrase check in `api/*` + a cookie, or Vercel Authentication. Keep `TURSO_*` and any keys server-side only. |
| **P1** | List + map + drawer UI | List view, `lat`/`lng` | Three-pane: results list, Google Map with listing markers, detail drawer (photo, price, price history, beds/sqft, source link, address). List ↔ map hover/selection sync. |
| **P1** | Radius search | `lat`/`lng`, `geocode_cache`, Maps SDK | User drops a point or types an address (geocoded client-side or via a small `api/geocode.js`), picks a radius; `api/listings.js` does bbox prefilter + haversine refine. |
| **P1** | Filters and sort | `api/listings.js` params | Price range, beds, min sqft, `source`, `keyword_group`, recency (`last_seen_at`); sort by price, newest, biggest price drop. |
| **P1** | Scheduled scraping via GitHub Actions | Turso migration | Cron workflow runs `apartments.py` on a schedule; `SERPAPI_KEY`, `GOOGLE_MAPS_API_KEY`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` come from repo Actions secrets. Sweeps the curated keyword groups; writes straight to Turso. |
| **P2** | Price-drop badges | `price_history`, filters/sort | API returns `{ prevPrice, price, delta, pct }`; UI shows a badge on cards/markers and enables "sort by price drop". |
| **P2** | Favorites | Access gate | Start with per-browser `localStorage`; once the gate implies identity, promote to a `favorites` table keyed by user. |

---

## 5. Environment variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `SERPAPI_KEY` | `apartments.py` (via `serpapi_client.py`) — GitHub Actions secret / local `.env.local` | SerpAPI Google search. Never ships to the frontend or a Vercel function. |
| `GOOGLE_MAPS_API_KEY` | `src/App.jsx` (Maps JS SDK) and the scraper's geocode step | Map rendering + address → `lat`/`lng` geocoding. |
| `TURSO_DATABASE_URL` | `db.py` (write) and `api/listings.js` (read) | libSQL endpoint of the hosted database, e.g. `libsql://<name>-<org>.turso.io`. |
| `TURSO_AUTH_TOKEN` | `db.py` (write) and `api/listings.js` (read) | Turso auth. Use a full-access token for the scraper and a **read-only** token for the Vercel function. |

**Restrict the Maps key by HTTP referrer.** The `GOOGLE_MAPS_API_KEY` used by the
Maps JavaScript SDK is exposed in the browser bundle — it cannot be kept secret.
In the Google Cloud console, add an *Application restriction → HTTP referrers*
allowlist (the Vercel production domain, any preview domains you use, and
`localhost` for dev) and an *API restriction* limiting it to just the APIs the
frontend calls (Maps JavaScript API, and Places if used). For server-side
geocoding in the scraper, prefer a **separate** key with an IP restriction (or no
referrer restriction) rather than reusing the browser key.

Where each secret lives:

- **GitHub Actions repo secrets:** `SERPAPI_KEY`, `GOOGLE_MAPS_API_KEY`
  (server geocoding key), `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` (write).
- **Vercel project env vars:** `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`
  (read-only), `GOOGLE_MAPS_API_KEY` (referrer-restricted browser key, exposed to
  the client build).
- **Local `.env.local`** (already `.gitignore`d): whatever you need to run the
  scraper or `vite dev` on your machine.

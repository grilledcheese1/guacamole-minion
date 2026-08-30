# Cheap Rent Finder

A hybrid app for hunting cheap apartments:

- **Scraper** (`apartments.py`, Python) — searches SerpAPI (`google` and
  `google_maps` engines), parses listing pages with BeautifulSoup, and writes
  normalized rows to a database.
- **Database** — a hosted [Turso](https://turso.tech/) (libSQL) database in
  production, or a local `apartments.db` SQLite file when `TURSO_*` is unset.
- **API** (`api/listings.js`) — a Vercel serverless function that reads the
  database and serves filtered/sorted listings as JSON.
- **Frontend** (`src/`, Vite + React) — list/map split view with filters,
  radius search, and a shareable-URL query string. Talks to `/api/listings`.

See [`DESIGN.md`](DESIGN.md) for the target architecture and
[`public/DESIGN.md`](public/DESIGN.md) for the visual design tokens.

## Setup

```sh
npm install
cp .env.local.example .env.local   # then fill in the keys you need
```

`.env.local` is read by **both** the Python scraper and (via `vercel dev`) the
API + frontend:

| Variable | Needed for |
| --- | --- |
| `SERPAPI_KEY` | the scraper (`npm run scrape`) |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | pointing the scraper + API at a hosted DB (leave blank to use local `apartments.db`) |
| `VITE_GOOGLE_MAPS_API_KEY` | the frontend map + address/ZIP geocoding (app still runs without it — the map area shows a placeholder) |
| `SITE_PASSWORD` | the deployed-site access gate (see [Access gate](#access-gate)); blank = gate off |

## Local development

### `npm run dev` — full stack (frontend + API on one port)

Runs [`vercel dev`](https://vercel.com/docs/cli/dev): the Vite dev server and the
`api/*.js` serverless functions together on **http://localhost:3000**, so
`fetch('/api/listings')` works exactly as it does in production. `vercel dev`
loads `.env.local` automatically (both `TURSO_*` for the function and `VITE_*`
for the client).

**First run only** — link the folder to a Vercel project:

```sh
npx vercel login
npx vercel link      # accept the prompts; creates .vercel/project.json (gitignored)
```

After that, `npm run dev` just works. If port 3000 is taken, `vercel dev` picks
another and prints it.

### `npm run dev:vite-only` — frontend only

Plain Vite on **http://localhost:5173**. No API server, so `/api/listings`
requests 404 and the list shows an error. Use this when you only need to work on
UI/styling, or don't want to sign in to Vercel.

## Other scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Production build to `dist/` (`vite build`) |
| `npm run preview` | Serve the built `dist/` locally |
| `npm run scrape` | Run the Python scraper (`python3 apartments.py [query]`); with no query it sweeps the curated keyword plan |
| `python scripts/backfill_geocode.py` | Geocode existing listings that have an address but no coordinates |

The scraper needs the Python deps: `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`.

## Deploying

Import the repo into Vercel (or `npx vercel --prod`). `vercel.json` pins the
framework to `vite` with output `dist/`; `api/*.js` deploy as Node serverless
functions automatically. Set `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`,
`VITE_GOOGLE_MAPS_API_KEY`, and `SITE_PASSWORD` in the Vercel project's
Environment Variables. The scraper is **not** deployed (see `.vercelignore`) —
run it on a schedule (e.g. GitHub Actions) writing to the same Turso database.

## Access gate

`middleware.js` (a Vercel Edge Middleware) puts a shared-password screen in front
of **everything** — the app and `/api/*` — so the public URL isn't crawled by
bots that would burn Google Maps and Turso quota. (The SerpAPI scraper isn't
deployed, so it's already out of reach.)

- Set **`SITE_PASSWORD`** in the Vercel project. A correct submit on the login
  screen stores a signed, `httpOnly` cookie (HMAC-SHA256 of the password) for
  30 days; every request without it gets the login page (HTML) or `401`
  (`/api/*`). Changing `SITE_PASSWORD` invalidates existing cookies.
- Sign out at **`/__auth/logout`**.
- **Unset `SITE_PASSWORD` = gate disabled.** Local dev is normally left open;
  set it in `.env.local` if you want to exercise the gate under `npm run dev`.
  `npm run dev:vite-only` bypasses it entirely (no middleware without Vercel).

No accounts, no database — just the one env var.

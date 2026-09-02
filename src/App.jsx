import { useCallback, useEffect, useMemo, useState } from "react";
import { useListings } from "./lib/useListings.js";
import { useFavorites } from "./lib/useFavorites.js";
import { useStatus } from "./lib/useStatus.js";
import { timeAgo } from "./lib/format.js";
import {
  DEFAULT_FILTERS,
  SORT_OPTIONS,
  countActiveFilters,
  filtersFromSearchParams,
  filtersToApiParams,
  filtersToSearchParams,
} from "./lib/filters.js";
import FilterPanel from "./components/FilterPanel.jsx";
import ListingCard from "./components/ListingCard.jsx";
import ListingsMap from "./components/ListingsMap.jsx";
import ListingDrawer from "./components/ListingDrawer.jsx";
import ScrapeButton from "./components/ScrapeButton.jsx";

function readInitialFilters() {
  if (typeof window === "undefined") return DEFAULT_FILTERS;
  return filtersFromSearchParams(window.location.search);
}

const DISMISS_ENDPOINT = "/api/listings";

async function postStatus(id, status) {
  const res = await fetch(DISMISS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, status }),
  });
  if (!res.ok) throw new Error(`status update failed (${res.status})`);
}

export default function App() {
  const [filters, setFilters] = useState(readInitialFilters);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [view, setView] = useState("list"); // mobile only: "list" | "map"
  const [selected, setSelected] = useState(null);
  // Optimistic per-listing status overrides ("dismissed" | "active") applied
  // until a refetch reconciles the fetched data — so a card never renders from a
  // stale fetched status after a dismiss OR a restore.
  const [pendingStatus, setPendingStatus] = useState(() => new Map());

  const { favoriteIds, favoriteCount, toggle: toggleFavorite, isFavorite } =
    useFavorites();
  const {
    lastUpdated,
    loading: statusLoading,
    error: statusError,
    refresh: refreshStatus,
  } = useStatus();

  // Mirror filter/sort state into the URL so a search is shareable by link.
  useEffect(() => {
    const qs = filtersToSearchParams(filters).toString();
    const url = qs ? `?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", url);
  }, [filters]);

  const apiParams = useMemo(() => filtersToApiParams(filters), [filters]);
  const { listings, count, loading, error, refetch } = useListings(apiParams);

  // Called when a triggered scrape run finishes — pull the fresh data in.
  const handleScrapeCompleted = useCallback(() => {
    refetch();
    refreshStatus();
  }, [refetch, refreshStatus]);

  const showDismissed = filters.showDismissed;

  const visibleListings = useMemo(() => {
    let base = favoritesOnly
      ? listings.filter((listing) => favoriteIds.has(String(listing.id)))
      : listings;
    if (!showDismissed) {
      base = base.filter(
        (listing) =>
          (pendingStatus.get(String(listing.id)) ?? listing.status) !==
          "dismissed",
      );
    }
    return base;
  }, [favoritesOnly, listings, favoriteIds, showDismissed, pendingStatus]);

  const patchFilters = useCallback(
    (patch) => setFilters((prev) => ({ ...prev, ...patch })),
    [],
  );
  const clearFilters = useCallback(
    () => setFilters((prev) => ({ ...DEFAULT_FILTERS, sort: prev.sort })),
    [],
  );

  const changeStatus = useCallback((id, status) => {
    const key = String(id);
    setPendingStatus((prev) => new Map(prev).set(key, status));
    postStatus(id, status).catch(() => {
      // request failed — drop the override so the fetched status shows again
      setPendingStatus((prev) => {
        const next = new Map(prev);
        next.delete(key);
        return next;
      });
    });
  }, []);

  const dismissListing = useCallback(
    (id) => changeStatus(id, "dismissed"),
    [changeStatus],
  );
  const restoreListing = useCallback(
    (id) => changeStatus(id, "active"),
    [changeStatus],
  );

  const hasPoint = filters.lat != null && filters.lng != null;
  const activeCount = countActiveFilters(filters);
  const displayCount = visibleListings.length;

  const updatedAgo = timeAgo(lastUpdated);
  const updatedDate = lastUpdated
    ? new Date(lastUpdated.replace(" ", "T") + "Z")
    : null;
  const isStale =
    updatedDate && Date.now() - updatedDate.getTime() > 24 * 60 * 60 * 1000;
  let updatedLabel = "Last updated: unknown";
  if (statusLoading && !lastUpdated) updatedLabel = "Checking freshness…";
  else if (!statusError && updatedAgo) updatedLabel = `Updated ${updatedAgo}`;
  else if (!statusError && !lastUpdated) updatedLabel = "No data yet";

  return (
    <div className="app-shell" data-view={view}>
      <header className="app-header">
        <div className="app-header__title">
          <img className="app-header__minion" src="/minion2.png" alt="" />
          Kind Mini
        </div>
        <div className="app-header__meta">
          <span
            className={`app-header__updated${isStale ? " is-stale" : ""}`}
            title={updatedDate ? updatedDate.toLocaleString() : undefined}
          >
            {updatedLabel}
          </span>
          <span className="app-header__count">
            {loading
              ? "Loading…"
              : error
                ? "—"
                : `${displayCount} ${favoritesOnly ? "saved " : ""}listing${
                    displayCount === 1 ? "" : "s"
                  }`}
          </span>
          <ScrapeButton
            onDispatched={refreshStatus}
            onCompleted={handleScrapeCompleted}
          />
        </div>
      </header>

      <div className="controls-bar">
        <button
          type="button"
          className={`filters-toggle${activeCount ? " filters-toggle--active" : ""}`}
          onClick={() => setFiltersOpen((open) => !open)}
          aria-expanded={filtersOpen}
        >
          Filters
          {activeCount > 0 && (
            <span className="filters-toggle__count">{activeCount}</span>
          )}
          <span className="filters-toggle__chevron" aria-hidden="true">
            {filtersOpen ? "▴" : "▾"}
          </span>
        </button>

        <button
          type="button"
          className={`fav-toggle${favoritesOnly ? " fav-toggle--active" : ""}`}
          onClick={() => setFavoritesOnly((on) => !on)}
          aria-pressed={favoritesOnly}
        >
          <span className="fav-toggle__heart" aria-hidden="true">
            {favoritesOnly ? "♥" : "♡"}
          </span>
          Favorites
          {favoriteCount > 0 && (
            <span className="fav-toggle__count">{favoriteCount}</span>
          )}
        </button>

        <label className="select-pill select-pill--sort">
          <span className="select-pill__label">Sort</span>
          <select
            value={filters.sort}
            onChange={(event) => patchFilters({ sort: event.target.value })}
            aria-label="Sort listings"
          >
            {SORT_OPTIONS.map((option) => (
              <option
                key={option.value}
                value={option.value}
                disabled={option.needsPoint && !hasPoint}
              >
                {option.label}
                {option.needsPoint && !hasPoint ? " (set a location)" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>

      {filtersOpen && (
        <FilterPanel
          filters={filters}
          onChange={patchFilters}
          onClear={clearFilters}
        />
      )}

      <main className="split">
        <section className="list-panel">
          {error && (
            <div className="panel-state panel-state--error">
              <p>{error}</p>
              <button type="button" className="btn-primary" onClick={refetch}>
                Retry
              </button>
            </div>
          )}

          {!error && loading && (
            <div className="panel-state">Loading listings…</div>
          )}

          {!error && !loading && visibleListings.length === 0 && (
            <div className="panel-state">
              {favoritesOnly && favoriteCount === 0 ? (
                <p>
                  You haven&rsquo;t saved any listings yet — tap the heart on a
                  card to save it.
                </p>
              ) : favoritesOnly ? (
                <p>None of your saved listings match these filters.</p>
              ) : (
                <>
                  <p>No listings match these filters.</p>
                  <p className="panel-state__hint">
                    Loosen the filters, or run <code>python apartments.py</code>{" "}
                    to populate the database.
                  </p>
                </>
              )}
            </div>
          )}

          {!error && visibleListings.length > 0 && (
            <ul className="listing-list">
              {visibleListings.map((listing) => (
                <li key={listing.id}>
                  <ListingCard
                    listing={listing}
                    active={selected?.id === listing.id}
                    onSelect={setSelected}
                    favorite={isFavorite(listing.id)}
                    onToggleFavorite={toggleFavorite}
                    dismissed={
                      (pendingStatus.get(String(listing.id)) ??
                        listing.status) === "dismissed"
                    }
                    onDismiss={dismissListing}
                    onRestore={restoreListing}
                  />
                </li>
              ))}
            </ul>
          )}

          {!error && (
            <p className="disclaimer">
              Listings are scraped from third-party sites — verify price and
              availability on the original listing before acting on it.
            </p>
          )}
        </section>

        <section className="map-panel">
          <ListingsMap
            listings={visibleListings}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
            center={hasPoint ? { lat: filters.lat, lng: filters.lng } : null}
            radiusMiles={filters.radiusMiles}
          />
        </section>
      </main>

      <div
        className="view-toggle"
        role="group"
        aria-label="Switch between list and map"
      >
        <button
          type="button"
          className={`pill-tab${view === "list" ? " pill-tab--active" : ""}`}
          onClick={() => setView("list")}
        >
          List
        </button>
        <button
          type="button"
          className={`pill-tab${view === "map" ? " pill-tab--active" : ""}`}
          onClick={() => setView("map")}
        >
          Map
        </button>
      </div>

      <ListingDrawer
        listing={selected}
        onClose={() => setSelected(null)}
        favorite={selected ? isFavorite(selected.id) : false}
        onToggleFavorite={toggleFavorite}
      />
    </div>
  );
}

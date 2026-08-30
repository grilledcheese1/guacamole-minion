import { useEffect, useState } from "react";
import { geocodeAddress, useGoogleMaps } from "../lib/googleMaps.jsx";
import {
  BEDROOM_OPTIONS,
  KEYWORD_GROUP_OPTIONS,
  PRICE_MAX,
  PRICE_MIN,
  RADIUS_STOPS,
  SOURCE_SITE_OPTIONS,
  countActiveFilters,
} from "../lib/filters.js";
import PriceRangeSlider from "./PriceRangeSlider.jsx";

function priceLabel(min, max) {
  if (min == null && max == null) return "Any price";
  const fmt = (n) => `$${n.toLocaleString("en-US")}`;
  if (min != null && max != null) return `${fmt(min)} – ${fmt(max)}`;
  if (min != null) return `${fmt(min)}+`;
  return `Up to ${fmt(max)}`;
}

export default function FilterPanel({ filters, onChange, onClear }) {
  const { hasKey, isLoaded, loadError } = useGoogleMaps();
  const [draftAddress, setDraftAddress] = useState(filters.address);
  const [geoState, setGeoState] = useState("idle"); // idle | loading | error
  const [geoError, setGeoError] = useState("");

  // Keep the input in sync when filters are cleared/replaced externally.
  useEffect(() => {
    setDraftAddress(filters.address);
  }, [filters.address]);

  const hasPoint = filters.lat != null && filters.lng != null;
  const activeCount = countActiveFilters(filters);

  async function runGeocode(event) {
    event.preventDefault();
    const query = draftAddress.trim();
    if (!query) return;
    setGeoState("loading");
    setGeoError("");
    try {
      const { lat, lng, formattedAddress } = await geocodeAddress(query);
      onChange({ address: formattedAddress, lat, lng });
      setDraftAddress(formattedAddress);
      setGeoState("idle");
    } catch (err) {
      setGeoState("error");
      setGeoError(err.message || "Couldn't geocode that");
    }
  }

  function clearPoint() {
    setDraftAddress("");
    setGeoState("idle");
    setGeoError("");
    onChange({
      address: "",
      lat: null,
      lng: null,
      radiusMiles: null,
      sort: filters.sort === "distance" ? "newest" : filters.sort,
    });
  }

  const radiusIndex = Math.max(0, RADIUS_STOPS.indexOf(filters.radiusMiles ?? null));
  const addressDisabled = !hasKey || (hasKey && !isLoaded);

  return (
    <div className="filter-panel" role="region" aria-label="Filters">
      {/* Location + radius --------------------------------------------------- */}
      <div className="field">
        <span className="field__label">Location</span>
        <form className="search-pill" onSubmit={runGeocode}>
          <span className="search-pill__icon" aria-hidden="true">
            ◎
          </span>
          <input
            className="search-pill__input"
            type="text"
            inputMode="text"
            placeholder={
              hasKey
                ? isLoaded
                  ? "Address or ZIP"
                  : "Loading Maps…"
                : "Address search needs a Maps API key"
            }
            value={draftAddress}
            disabled={addressDisabled}
            onChange={(event) => setDraftAddress(event.target.value)}
          />
          {hasPoint ? (
            <button
              type="button"
              className="search-pill__btn"
              onClick={clearPoint}
              aria-label="Clear location"
            >
              ✕
            </button>
          ) : (
            <button
              type="submit"
              className="search-pill__btn search-pill__btn--go"
              disabled={addressDisabled || geoState === "loading"}
            >
              {geoState === "loading" ? "…" : "Search"}
            </button>
          )}
        </form>
        {geoState === "error" && (
          <span className="field__hint field__hint--error">{geoError}</span>
        )}
        {loadError && (
          <span className="field__hint field__hint--error">
            Google Maps failed to load.
          </span>
        )}
      </div>

      <div className="field">
        <span className="field__label">
          Radius
          <span className="field__value">
            {filters.radiusMiles == null
              ? "Any distance"
              : `${filters.radiusMiles} mi`}
          </span>
        </span>
        <input
          type="range"
          className="range-slider"
          min={0}
          max={RADIUS_STOPS.length - 1}
          step={1}
          value={radiusIndex}
          disabled={!hasPoint}
          aria-label="Search radius"
          onChange={(event) =>
            onChange({ radiusMiles: RADIUS_STOPS[Number(event.target.value)] })
          }
        />
        <div className="range-ticks" aria-hidden="true">
          {RADIUS_STOPS.map((stop) => (
            <span key={stop ?? "any"}>{stop == null ? "Any" : stop}</span>
          ))}
        </div>
        {!hasPoint && (
          <span className="field__hint">Set a location to filter by radius.</span>
        )}
      </div>

      {/* Price range ------------------------------------------------------- */}
      <div className="field field--wide">
        <span className="field__label">
          Price
          <span className="field__value">
            {priceLabel(filters.minPrice, filters.maxPrice)}
          </span>
        </span>
        <PriceRangeSlider
          value={[filters.minPrice ?? PRICE_MIN, filters.maxPrice ?? PRICE_MAX]}
          onChange={([low, high]) =>
            onChange({
              minPrice: low <= PRICE_MIN ? null : low,
              maxPrice: high >= PRICE_MAX ? null : high,
            })
          }
        />
      </div>

      {/* Bedrooms (segmented-tab) --------------------------------------------- */}
      <div className="field">
        <span className="field__label">Bedrooms</span>
        <div className="segmented" role="radiogroup" aria-label="Bedrooms">
          {BEDROOM_OPTIONS.map((option) => (
            <button
              key={option.label}
              type="button"
              role="radio"
              aria-checked={filters.bedrooms === option.value}
              className={`segmented__tab${
                filters.bedrooms === option.value ? " segmented__tab--active" : ""
              }`}
              onClick={() => onChange({ bedrooms: option.value })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {/* Source site ----------------------------------------------------- */}
      <div className="field">
        <span className="field__label">Source site</span>
        <div className="select-pill">
          <select
            value={filters.sourceSite}
            onChange={(event) => onChange({ sourceSite: event.target.value })}
            aria-label="Source site"
          >
            <option value="">Any source</option>
            {SOURCE_SITE_OPTIONS.map((site) => (
              <option key={site} value={site}>
                {site}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Keyword groups (pill-tab checkboxes) --------------------------------- */}
      <div className="field field--wide">
        <span className="field__label">Keyword groups</span>
        <div className="chip-set">
          {KEYWORD_GROUP_OPTIONS.map((group) => {
            const checked = filters.keywordGroups.includes(group.value);
            return (
              <button
                key={group.value}
                type="button"
                role="checkbox"
                aria-checked={checked}
                className={`chip-check${checked ? " chip-check--on" : ""}`}
                onClick={() =>
                  onChange({
                    keywordGroups: checked
                      ? filters.keywordGroups.filter((v) => v !== group.value)
                      : [...filters.keywordGroups, group.value],
                  })
                }
              >
                {checked ? "✓ " : ""}
                {group.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="filter-panel__foot">
        <button
          type="button"
          className="btn-ghost"
          onClick={onClear}
          disabled={activeCount === 0}
        >
          Clear all filters
        </button>
      </div>
    </div>
  );
}

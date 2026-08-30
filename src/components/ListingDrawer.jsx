import { useEffect } from "react";
import { createPortal } from "react-dom";
import {
  cleanSource,
  formatBeds,
  formatDistance,
  formatPrice,
  formatSqft,
  timeAgo,
} from "../lib/format.js";

/**
 * Detail view for a picked listing. Side-drawer on desktop, bottom-sheet on
 * mobile (see media query in index.css). Always mounted so it can transition;
 * `is-open` drives the slide + backdrop.
 */
export default function ListingDrawer({
  listing,
  onClose,
  favorite,
  onToggleFavorite,
}) {
  const open = Boolean(listing);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return createPortal(
    <div className={`drawer-layer${open ? " is-open" : ""}`} aria-hidden={!open}>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Listing details"
      >
        <div className="drawer__handle" />
        {listing && (
          <button
            type="button"
            className={`drawer__fav${favorite ? " drawer__fav--on" : ""}`}
            onClick={() => onToggleFavorite(listing.id)}
            aria-pressed={favorite}
            aria-label={
              favorite ? "Remove from favorites" : "Save to favorites"
            }
          >
            <span aria-hidden="true">{favorite ? "♥" : "♡"}</span>
          </button>
        )}
        <button
          type="button"
          className="drawer__close"
          onClick={onClose}
          aria-label="Close details"
        >
          ✕
        </button>
        {listing && <DrawerContent listing={listing} />}
      </aside>
    </div>,
    document.body,
  );
}

function DrawerContent({ listing }) {
  const seen = timeAgo(listing.lastSeenAt || listing.createdAt);
  const distance = formatDistance(listing.distanceMiles);
  const priceDropped = listing.priceDelta != null && listing.priceDelta < 0;

  const chips = [
    formatBeds(listing.bedrooms),
    formatSqft(listing.sqft),
    distance,
  ].filter(Boolean);

  const history = listing.priceHistory;

  return (
    <>
      <div className="drawer__media">
        {listing.imageUrl ? (
          <img src={listing.imageUrl} alt={listing.title || "Listing photo"} />
        ) : (
          <div className="drawer__media--empty">No photo</div>
        )}
      </div>

      <div className="drawer__body">
        <div className="drawer__price">
          {formatPrice(listing.price)}
          {listing.price != null && <span> /mo</span>}
        </div>

        {priceDropped && (
          <div className="drawer__pricedrop">
            ↓ {formatPrice(Math.abs(listing.priceDelta))} since last seen
            {listing.previousPrice != null &&
              ` · was ${formatPrice(listing.previousPrice)}`}
          </div>
        )}

        <div className="drawer__title">
          {listing.title || "Untitled listing"}
        </div>

        {listing.address && (
          <div className="drawer__address">{listing.address}</div>
        )}

        {chips.length > 0 && (
          <div className="drawer__chips">
            {chips.map((chip) => (
              <span key={chip} className="drawer__chip">
                {chip}
              </span>
            ))}
          </div>
        )}

        <div className="drawer__row">
          {listing.source && (
            <span className="source-badge">{cleanSource(listing.source)}</span>
          )}
          {seen && <span>seen {seen}</span>}
        </div>

        {history && history.observationCount > 1 && (
          <div className="drawer__meta-line">
            Price seen {history.observationCount} times
            {history.previousPrice != null &&
              ` · was ${formatPrice(history.previousPrice)}`}
          </div>
        )}

        {listing.url && (
          <div className="drawer__cta">
            <a
              className="btn-primary"
              href={listing.url}
              target="_blank"
              rel="noreferrer noopener"
            >
              View original listing ↗
            </a>
          </div>
        )}
      </div>
    </>
  );
}

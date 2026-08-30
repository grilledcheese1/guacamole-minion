import {
  cleanSource,
  formatBeds,
  formatDistance,
  formatPrice,
  formatSqft,
  timeAgo,
} from "../lib/format.js";

/**
 * One result in the list. Styled to DESIGN.md `card-base`; the selected card
 * takes the `card-feature`-style brand border. The heart and the "not
 * interested" button are siblings of the card button (not nested) so all three
 * stay valid, independently clickable buttons.
 *
 * Lifecycle: `listing.status === "unavailable"` greys the card out (DESIGN.md
 * stone/muted tokens); `dismissed` cards show an Undo control.
 */
export default function ListingCard({
  listing,
  active,
  onSelect,
  favorite,
  onToggleFavorite,
  dismissed,
  onDismiss,
  onRestore,
}) {
  const seen = timeAgo(listing.lastSeenAt || listing.createdAt);
  const distance = formatDistance(listing.distanceMiles);
  const unavailable = listing.status === "unavailable";
  const priceDropped =
    !unavailable && listing.priceDelta != null && listing.priceDelta < 0;

  const meta = [
    formatBeds(listing.bedrooms),
    formatSqft(listing.sqft),
    distance,
  ].filter(Boolean);

  const wrapClass = [
    "listing-card-wrap",
    active && "is-active",
    unavailable && "listing-card-wrap--unavailable",
    dismissed && "listing-card-wrap--dismissed",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={wrapClass}>
      <button
        type="button"
        className={`listing-card${active ? " listing-card--active" : ""}`}
        onClick={() => onSelect(listing)}
        aria-pressed={active}
      >
        <div className="listing-card__media">
          {listing.imageUrl ? (
            <img src={listing.imageUrl} alt="" loading="lazy" />
          ) : (
            <div className="listing-card__media--empty">No photo</div>
          )}
        </div>

        <div className="listing-card__body">
          <div className="listing-card__price">
            {formatPrice(listing.price)}
            {listing.price != null && (
              <span className="listing-card__per"> /mo</span>
            )}
          </div>
          <div className="listing-card__title">
            {listing.title || listing.address || "Untitled listing"}
          </div>
          {meta.length > 0 && (
            <div className="listing-card__meta">
              {meta.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          )}
          <div className="listing-card__foot">
            {unavailable && (
              <span className="status-badge status-badge--unavailable">
                Unavailable
              </span>
            )}
            {dismissed && !unavailable && (
              <span className="status-badge status-badge--dismissed">
                Dismissed
              </span>
            )}
            {priceDropped && (
              <span className="price-drop-badge">
                ↓ {formatPrice(Math.abs(listing.priceDelta))}
              </span>
            )}
            {listing.source && (
              <span className="source-badge">{cleanSource(listing.source)}</span>
            )}
            {seen && <span className="listing-card__seen">seen {seen}</span>}
          </div>
        </div>
      </button>

      <button
        type="button"
        className={`fav-heart${favorite ? " fav-heart--on" : ""}`}
        onClick={() => onToggleFavorite(listing.id)}
        aria-pressed={favorite}
        aria-label={favorite ? "Remove from favorites" : "Save to favorites"}
      >
        <span aria-hidden="true">{favorite ? "♥" : "♡"}</span>
      </button>

      <button
        type="button"
        className="dismiss-btn"
        onClick={() =>
          dismissed ? onRestore(listing.id) : onDismiss(listing.id)
        }
        title={
          dismissed
            ? "Show this listing again"
            : "Not interested — hide this listing"
        }
        aria-label={
          dismissed ? "Restore listing" : "Dismiss listing — not interested"
        }
      >
        <span aria-hidden="true">{dismissed ? "↩" : "✕"}</span>
      </button>
    </div>
  );
}

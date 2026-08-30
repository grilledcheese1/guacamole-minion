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
 * takes the `card-feature`-style brand border. The heart is a sibling of the
 * card button (not nested) so both stay valid, independently clickable buttons.
 */
export default function ListingCard({
  listing,
  active,
  onSelect,
  favorite,
  onToggleFavorite,
}) {
  const seen = timeAgo(listing.lastSeenAt || listing.createdAt);
  const distance = formatDistance(listing.distanceMiles);
  const priceDropped = listing.priceDelta != null && listing.priceDelta < 0;

  const meta = [
    formatBeds(listing.bedrooms),
    formatSqft(listing.sqft),
    distance,
  ].filter(Boolean);

  return (
    <div className={`listing-card-wrap${active ? " is-active" : ""}`}>
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
    </div>
  );
}

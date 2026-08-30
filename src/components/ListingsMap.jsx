import { useCallback, useEffect, useMemo, useRef } from "react";
import { CircleF, GoogleMap, MarkerF } from "@react-google-maps/api";
import { useGoogleMaps } from "../lib/googleMaps.jsx";

const DEFAULT_CENTER = { lat: 39.5, lng: -98.35 }; // continental US
const DEFAULT_ZOOM = 4;
const METERS_PER_MILE = 1609.344;

// Low-saturation style so the brand-coloured pins read clearly.
const MAP_STYLES = [
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "labels", stylers: [{ lightness: 20 }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#d7e6ea" }] },
  { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#f4f7f6" }] },
];

const MAP_OPTIONS = {
  disableDefaultUI: true,
  zoomControl: true,
  clickableIcons: false,
  styles: MAP_STYLES,
  backgroundColor: "#f4f7f6",
};

const RADIUS_CIRCLE_OPTIONS = {
  strokeColor: "#00684a",
  strokeOpacity: 0.7,
  strokeWeight: 1.5,
  fillColor: "#00ed64",
  fillOpacity: 0.08,
  clickable: false,
};

export default function ListingsMap(props) {
  const { hasKey, isLoaded, loadError } = useGoogleMaps();

  if (!hasKey) {
    return (
      <div className="map-missing-key">
        <strong>Map unavailable</strong>
        <span>
          Set <code>VITE_GOOGLE_MAPS_API_KEY</code> in <code>.env.local</code> to
          enable the map.
        </span>
      </div>
    );
  }
  if (loadError) return <div className="map-status">Map failed to load.</div>;
  if (!isLoaded) return <div className="map-status">Loading map…</div>;
  return <MapInner {...props} />;
}

function MapInner({ listings, selectedId, onSelect, center, radiusMiles }) {
  const mapRef = useRef(null);

  const mapped = useMemo(
    () => listings.filter((l) => l.lat != null && l.lng != null),
    [listings],
  );

  const hasCenter = center && center.lat != null && center.lng != null;

  const fitView = useCallback(
    (map) => {
      if (!map || !window.google) return;
      if (hasCenter && radiusMiles != null) {
        const circle = new window.google.maps.Circle({
          center,
          radius: radiusMiles * METERS_PER_MILE,
        });
        map.fitBounds(circle.getBounds(), 48);
        return;
      }
      if (hasCenter) {
        map.setCenter(center);
        map.setZoom(12);
        return;
      }
      if (mapped.length === 0) {
        map.setCenter(DEFAULT_CENTER);
        map.setZoom(DEFAULT_ZOOM);
        return;
      }
      if (mapped.length === 1) {
        map.setCenter({ lat: mapped[0].lat, lng: mapped[0].lng });
        map.setZoom(14);
        return;
      }
      const bounds = new window.google.maps.LatLngBounds();
      mapped.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }));
      map.fitBounds(bounds, 64);
    },
    [mapped, hasCenter, center, radiusMiles],
  );

  const onLoad = useCallback(
    (map) => {
      mapRef.current = map;
      fitView(map);
    },
    [fitView],
  );

  useEffect(() => {
    if (mapRef.current) fitView(mapRef.current);
  }, [fitView]);

  useEffect(() => {
    if (!mapRef.current || selectedId == null) return;
    const selected = mapped.find((l) => l.id === selectedId);
    if (selected) mapRef.current.panTo({ lat: selected.lat, lng: selected.lng });
  }, [selectedId, mapped]);

  return (
    <GoogleMap
      mapContainerClassName="gmap"
      onLoad={onLoad}
      onUnmount={() => {
        mapRef.current = null;
      }}
      center={DEFAULT_CENTER}
      zoom={DEFAULT_ZOOM}
      options={MAP_OPTIONS}
    >
      {hasCenter && radiusMiles != null && (
        <CircleF
          center={center}
          radius={radiusMiles * METERS_PER_MILE}
          options={RADIUS_CIRCLE_OPTIONS}
        />
      )}
      {hasCenter && <MarkerF position={center} icon={centerPin()} zIndex={1000} />}

      {mapped.map((listing) => {
        const unavailable = listing.status === "unavailable";
        return (
          <MarkerF
            key={listing.id}
            position={{ lat: listing.lat, lng: listing.lng }}
            icon={pricePin(listing.price, listing.id === selectedId, unavailable)}
            zIndex={
              listing.id === selectedId ? 999 : unavailable ? 0 : 1
            }
            onClick={() => onSelect(listing)}
          />
        );
      })}
    </GoogleMap>
  );
}

/** Rounded price-pill marker as an inline SVG data URI, in DESIGN.md colours.
 *  `muted` renders unavailable listings in the stone/muted greys. */
function pricePin(price, selected, muted) {
  const label =
    price == null ? "—" : `$${Number(price).toLocaleString("en-US")}`;
  const width = Math.max(46, Math.round(20 + label.length * 8.5));
  const boxHeight = 26;
  const totalHeight = boxHeight + 8;

  const fill = selected ? "#00ed64" : muted ? "#7c8c9a" : "#001e2b";
  const stroke = selected ? "#00684a" : muted ? "#a8b3bc" : "#00ed64";
  const text = selected ? "#001e2b" : muted ? "#ffffff" : "#00ed64";
  const midX = width / 2;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${totalHeight}" viewBox="0 0 ${width} ${totalHeight}">
    <rect x="1" y="1" width="${width - 2}" height="${boxHeight - 2}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
    <path d="M${midX - 6} ${boxHeight - 2} L${midX} ${totalHeight - 1} L${midX + 6} ${boxHeight - 2} Z" fill="${fill}"/>
    <text x="${midX}" y="${boxHeight / 2 + 4.5}" text-anchor="middle" font-family="Manrope, system-ui, -apple-system, sans-serif" font-size="12.5" font-weight="700" fill="${text}">${label}</text>
  </svg>`;

  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new window.google.maps.Size(width, totalHeight),
    anchor: new window.google.maps.Point(midX, totalHeight - 1),
  };
}

/** Center-of-search marker (a ringed dot in brand teal). */
function centerPin() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
    <circle cx="11" cy="11" r="9" fill="#001e2b" fill-opacity="0.15"/>
    <circle cx="11" cy="11" r="5" fill="#001e2b" stroke="#ffffff" stroke-width="2"/>
  </svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new window.google.maps.Size(22, 22),
    anchor: new window.google.maps.Point(11, 11),
  };
}

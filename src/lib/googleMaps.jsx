import { createContext, useContext } from "react";
import { useJsApiLoader } from "@react-google-maps/api";

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

// One shared loader for the whole app (map + client-side geocoding).
const LOADER_OPTIONS = {
  id: "google-maps-script",
  googleMapsApiKey: API_KEY || "",
};

const GoogleMapsContext = createContext({
  hasKey: false,
  isLoaded: false,
  loadError: null,
});

export function GoogleMapsProvider({ children }) {
  // No key: don't inject a doomed <script>; just report "unavailable".
  if (!API_KEY) {
    return (
      <GoogleMapsContext.Provider
        value={{ hasKey: false, isLoaded: false, loadError: null }}
      >
        {children}
      </GoogleMapsContext.Provider>
    );
  }
  return <LoadedProvider>{children}</LoadedProvider>;
}

function LoadedProvider({ children }) {
  const { isLoaded, loadError } = useJsApiLoader(LOADER_OPTIONS);
  return (
    <GoogleMapsContext.Provider value={{ hasKey: true, isLoaded, loadError }}>
      {children}
    </GoogleMapsContext.Provider>
  );
}

export function useGoogleMaps() {
  return useContext(GoogleMapsContext);
}

/**
 * Geocode an address / zip client-side via the Google Maps JS Geocoder
 * (same key as the map). Resolves to { lat, lng, formattedAddress }.
 */
export async function geocodeAddress(address) {
  if (!window.google?.maps?.Geocoder) {
    throw new Error("Google Maps is not loaded yet");
  }
  const geocoder = new window.google.maps.Geocoder();
  const { results } = await geocoder.geocode({ address });
  if (!results || results.length === 0) {
    throw new Error("No match for that address");
  }
  const best = results[0];
  const location = best.geometry.location;
  return {
    lat: Math.round(location.lat() * 1e6) / 1e6,
    lng: Math.round(location.lng() * 1e6) / 1e6,
    formattedAddress: best.formatted_address,
  };
}

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { GoogleMapsProvider } from "./lib/googleMaps.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <GoogleMapsProvider>
      <App />
    </GoogleMapsProvider>
  </React.StrictMode>,
);

// Register the app-shell service worker (production builds only — keeps it out
// of Vite's dev / HMR flow).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // install is best-effort; the app works fine without it
    });
  });
}

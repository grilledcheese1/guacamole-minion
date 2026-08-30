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

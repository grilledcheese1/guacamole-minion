import { useMemo, useState } from "react";
import { buildQueries, KEYWORD_GROUPS } from "./keywords.js";

export default function App() {
  const [location, setLocation] = useState("");
  const [maxPrice, setMaxPrice] = useState("");

  const queries = useMemo(
    () =>
      buildQueries({
        location: location.trim(),
        maxPrice: maxPrice ? Number(maxPrice) : undefined,
        withSites: true,
      }),
    [location, maxPrice],
  );

  return (
    <div className="app">
      <h1>Cheap Apartment Search Queries</h1>
      <p className="subtitle">
        {queries.length} SerpAPI Google queries across{" "}
        {Object.keys(KEYWORD_GROUPS).length} keyword groups.
      </p>

      <div className="controls">
        <input
          type="text"
          placeholder="Location (e.g. Austin, Texas)"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
        <input
          type="number"
          placeholder="Max price"
          value={maxPrice}
          onChange={(e) => setMaxPrice(e.target.value)}
        />
      </div>

      <ul className="queries">
        {queries.map((q) => (
          <li key={q}>{q}</li>
        ))}
      </ul>
    </div>
  );
}

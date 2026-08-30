import { useCallback, useEffect, useRef, useState } from "react";

function toQueryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== "") {
          search.append(key, String(item));
        }
      }
    } else {
      search.set(key, String(value));
    }
  }
  return search.toString();
}

/**
 * Fetch listings from the serverless function at /api/listings.
 * Re-runs whenever the derived query string changes; in-flight requests are
 * aborted so responses can't land out of order.
 *
 * Local dev note: `/api/listings` is served by `vercel dev`, not `vite`.
 */
export function useListings(params) {
  const [state, setState] = useState({
    listings: [],
    count: 0,
    loading: true,
    error: null,
  });

  const query = toQueryString(params);
  const abortRef = useRef(null);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    fetch(`/api/listings?${query}`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401) {
          // The shared-password gate (middleware.js) rejected the request.
          throw new Error("Session expired — reload the page to sign in again.");
        }
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${response.status})`);
        }
        return response.json();
      })
      .then((data) => {
        setState({
          listings: Array.isArray(data.listings) ? data.listings : [],
          count: data.count ?? data.listings?.length ?? 0,
          loading: false,
          error: null,
        });
      })
      .catch((error) => {
        if (error.name === "AbortError") return;
        setState({ listings: [], count: 0, loading: false, error: error.message });
      });
  }, [query]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  return { ...state, refetch: load };
}

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
  // Always holds the latest query string, read (not captured) inside poll()'s
  // async callback so a response from a since-superseded query never merges
  // stale rows back into fresher, filter-changed state.
  const queryRef = useRef(query);
  queryRef.current = query;
  // Bumped on every poll() call; a response only applies if it's still the
  // most recently issued poll when it resolves — otherwise a slow request
  // (cold start, network hiccup) landing after a faster, later one would
  // overwrite fresher state with stale fields and regress `count`.
  const pollSeqRef = useRef(0);

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

  // Background refresh used while a scrape is running: merges in new/updated
  // rows without ever removing one already on screen. A row can vanish from
  // this response for reasons that have nothing to do with it no longer
  // existing — a LIMIT-bounded page shifting as new rows outrank it, a
  // transient read — so treating "missing from this batch" as "gone" would
  // make listings flicker in and out while the scrape runs. Once something's
  // visible, only an explicit filter change (which calls `refetch`, a full
  // replace) or a user action removes it.
  const poll = useCallback(() => {
    const requestQuery = query;
    const seq = ++pollSeqRef.current;
    fetch(`/api/listings?${requestQuery}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data || !Array.isArray(data.listings)) return;
        // The filters changed since this request went out — a `load()` already
        // replaced state for the new query; don't merge this stale response in.
        if (queryRef.current !== requestQuery) return;
        // A later poll has already started (or finished) — this one is stale
        // even though it's arriving now; discard rather than merge it in.
        if (seq !== pollSeqRef.current) return;

        setState((prev) => {
          const fresh = new Map(data.listings.map((l) => [String(l.id), l]));
          const merged = [...data.listings];
          for (const listing of prev.listings) {
            if (!fresh.has(String(listing.id))) merged.push(listing);
          }
          return { ...prev, listings: merged, count: data.count ?? merged.length };
        });
      })
      .catch(() => {
        /* transient — the next poll tick tries again; never surface this as
           a user-facing error or touch loading state */
      });
  }, [query]);

  return { ...state, refetch: load, poll };
}

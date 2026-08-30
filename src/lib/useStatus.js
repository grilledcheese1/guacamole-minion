import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Poll /api/status for the freshness snapshot (most recent last_seen_at across
 * all listings). Re-fetches every `pollMs` so the header's "Updated X ago"
 * advances and picks up background/scheduled scrapes.
 */
export function useStatus(pollMs = 60_000) {
  const [state, setState] = useState({
    lastUpdated: null,
    count: 0,
    loading: true,
    error: null,
  });
  const abortRef = useRef(null);

  const refresh = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    fetch("/api/status", { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.json();
      })
      .then((data) =>
        setState({
          lastUpdated: data.lastUpdated ?? null,
          count: Number(data.count ?? 0),
          loading: false,
          error: null,
        }),
      )
      .catch((err) => {
        if (err.name === "AbortError") return;
        setState((prev) => ({ ...prev, loading: false, error: err.message }));
      });
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, pollMs);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [refresh, pollMs]);

  return { ...state, refresh };
}

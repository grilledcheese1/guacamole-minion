import { useCallback, useEffect, useState } from "react";

// Saved listings live only in the browser — no backend yet. IDs are stored as a
// JSON array of strings under this key and mirrored into a Set for O(1) lookups.
const STORAGE_KEY = "crf:favorites";

function readStored() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Favorite listing IDs, persisted to localStorage and kept in sync across tabs.
 * Returns a stable `toggle`/`isFavorite` plus the raw Set and its size.
 */
export function useFavorites() {
  const [ids, setIds] = useState(() => new Set(readStored()));

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
    } catch {
      // private mode or quota exceeded — favorites just won't persist
    }
  }, [ids]);

  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === STORAGE_KEY) setIds(new Set(readStored()));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback((id) => {
    const key = String(id);
    setIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const isFavorite = useCallback((id) => ids.has(String(id)), [ids]);

  return { favoriteIds: ids, favoriteCount: ids.size, toggle, isFavorite };
}

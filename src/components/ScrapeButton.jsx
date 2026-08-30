import { useCallback, useEffect, useRef, useState } from "react";

const COOLDOWN_MS = 5 * 60 * 1000; // don't allow re-triggering within 5 minutes
const STORAGE_KEY = "crf:lastScrapeTrigger";

function readLastTrigger() {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function writeLastTrigger(ts) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(ts));
  } catch {
    // private mode / quota — the in-memory ref still guards this tab
  }
}

function formatRemaining(ms) {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * "Run scrape now" — POSTs /api/trigger-scrape (which dispatches the GitHub
 * Actions workflow). Disabled while in flight and for 5 minutes after a
 * successful trigger; the server also enforces the cooldown and a 429 re-syncs
 * this timer. Styled with DESIGN.md `button-primary`.
 */
export default function ScrapeButton({ onDispatched }) {
  const [phase, setPhase] = useState("idle"); // idle | loading | done | error
  const [errorMsg, setErrorMsg] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const lastTriggerRef = useRef(readLastTrigger());

  const remaining = Math.max(
    0,
    lastTriggerRef.current + COOLDOWN_MS - now,
  );
  const coolingDown = remaining > 0;
  const busy = phase === "loading";

  // Tick once a second only while the cooldown is counting down.
  useEffect(() => {
    if (!coolingDown) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [coolingDown]);

  const trigger = useCallback(async () => {
    if (busy || coolingDown) return;
    setPhase("loading");
    setErrorMsg("");
    try {
      const res = await fetch("/api/trigger-scrape", { method: "POST" });
      const body = await res.json().catch(() => ({}));

      if (res.status === 429) {
        const secs = Number(body.retryAfterSeconds) || 300;
        // Align the local timer with the server's remaining cooldown.
        lastTriggerRef.current = Date.now() - (COOLDOWN_MS - secs * 1000);
        writeLastTrigger(lastTriggerRef.current);
        setNow(Date.now());
        setPhase("idle");
        return;
      }
      if (!res.ok) {
        throw new Error(body.error || `Request failed (${res.status})`);
      }

      lastTriggerRef.current = Date.now();
      writeLastTrigger(lastTriggerRef.current);
      setNow(Date.now());
      setPhase("done");
      onDispatched?.();
      setTimeout(() => setPhase("idle"), 4000);
    } catch (err) {
      setErrorMsg(err.message || "Trigger failed");
      setPhase("error");
      setTimeout(() => setPhase("idle"), 6000);
    }
  }, [busy, coolingDown, onDispatched]);

  let label = "Run scrape now";
  if (busy) label = "Starting…";
  else if (phase === "done") label = "Scrape queued ✓";
  else if (coolingDown) label = `Wait ${formatRemaining(remaining)}`;
  else if (phase === "error") label = "Failed — retry";

  return (
    <span className="scrape-trigger">
      <button
        type="button"
        className="btn-primary btn-primary--sm"
        onClick={trigger}
        disabled={busy || coolingDown}
        title={
          coolingDown
            ? "A scrape ran recently — try again shortly"
            : "Dispatch the GitHub Actions scrape workflow"
        }
      >
        {label}
      </button>
      {phase === "error" && errorMsg && (
        <span className="scrape-trigger__error" role="alert">
          {errorMsg}
        </span>
      )}
    </span>
  );
}

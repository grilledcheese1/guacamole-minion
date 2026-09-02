import { useCallback, useEffect, useRef, useState } from "react";

const COOLDOWN_MS = 5 * 60 * 1000; // don't allow re-triggering within 5 minutes
const STORAGE_KEY = "crf:lastScrapeTrigger";
const POLL_INTERVAL_MS = 8000;
const POLL_FIRST_DELAY_MS = 5000;
const POLL_MAX_MS = 10 * 60 * 1000; // give up polling after 10 minutes

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

function formatDuration(ms) {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * "Run scrape now" — POSTs /api/trigger-scrape (dispatches the GitHub Actions
 * workflow), then polls /api/scrape-status until the run finishes and calls
 * `onCompleted` so the app can refetch. Disabled while running and for 5 minutes
 * after a successful trigger (the server also enforces the cooldown; a 429
 * re-syncs the timer). Styled with DESIGN.md `button-primary`.
 */
export default function ScrapeButton({ onDispatched, onCompleted }) {
  // idle | loading | running | done | error
  const [phase, setPhase] = useState("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [runUrl, setRunUrl] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  const lastTriggerRef = useRef(readLastTrigger());
  const resetTimerRef = useRef(null);
  const pollTimerRef = useRef(null);
  const pollDeadlineRef = useRef(0);
  const runStartedRef = useRef(0);

  const scheduleReset = useCallback((ms) => {
    clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      resetTimerRef.current = null;
      setPhase("idle");
    }, ms);
  }, []);

  const stopPolling = useCallback(() => {
    clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  const pollOnce = useCallback(async () => {
    let data = null;
    try {
      const res = await fetch("/api/scrape-status");
      data = await res.json().catch(() => null);
    } catch {
      /* transient — fall through to reschedule */
    }

    if (data) {
      if (data.htmlUrl) setRunUrl(data.htmlUrl);

      if (data.configured === false) {
        // Can't track the run — treat the dispatch as done.
        stopPolling();
        setPhase("done");
        scheduleReset(4000);
        return;
      }
      if (data.state === "completed") {
        stopPolling();
        if (!data.conclusion || data.conclusion === "success") {
          setPhase("done");
          onCompleted?.();
          scheduleReset(5000);
        } else {
          setPhase("error");
          setErrorMsg(`Scrape run ${data.conclusion}`);
          scheduleReset(10000);
        }
        return;
      }
    }

    if (Date.now() > pollDeadlineRef.current) {
      // Give up quietly; the header's 60s status poll still picks up new data.
      stopPolling();
      setPhase("idle");
      return;
    }
    pollTimerRef.current = setTimeout(pollOnce, POLL_INTERVAL_MS);
  }, [onCompleted, scheduleReset, stopPolling]);

  const startPolling = useCallback(() => {
    stopPolling();
    runStartedRef.current = Date.now();
    pollDeadlineRef.current = Date.now() + POLL_MAX_MS;
    setPhase("running");
    setNow(Date.now());
    pollTimerRef.current = setTimeout(pollOnce, POLL_FIRST_DELAY_MS);
  }, [pollOnce, stopPolling]);

  // Cleanup on unmount.
  useEffect(
    () => () => {
      clearTimeout(resetTimerRef.current);
      clearTimeout(pollTimerRef.current);
    },
    [],
  );

  const remaining = Math.max(0, lastTriggerRef.current + COOLDOWN_MS - now);
  const coolingDown = remaining > 0;
  const busy = phase === "loading";
  const running = phase === "running";

  // Tick every second while cooling down or while a run is in progress.
  useEffect(() => {
    if (!coolingDown && !running) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [coolingDown, running]);

  const trigger = useCallback(async () => {
    if (busy || coolingDown || running) return;
    clearTimeout(resetTimerRef.current);
    setPhase("loading");
    setErrorMsg("");
    setRunUrl(null);
    try {
      const res = await fetch("/api/trigger-scrape", { method: "POST" });
      const body = await res.json().catch(() => ({}));

      if (res.status === 429) {
        const secs = Number(body.retryAfterSeconds) || 300;
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
      onDispatched?.();
      startPolling();
    } catch (err) {
      setErrorMsg(err.message || "Trigger failed");
      setPhase("error");
      scheduleReset(6000);
    }
  }, [busy, coolingDown, running, onDispatched, startPolling, scheduleReset]);

  let label = "Run scrape now";
  if (busy) label = "Starting…";
  else if (running)
    label = `Scraping… ${formatDuration(now - runStartedRef.current)}`;
  else if (phase === "done") label = "Updated ✓";
  else if (coolingDown) label = `Wait ${formatDuration(remaining)}`;
  else if (phase === "error") label = "Failed — retry";

  return (
    <span className="scrape-trigger">
      <button
        type="button"
        className="btn-primary btn-primary--sm"
        onClick={trigger}
        disabled={busy || coolingDown || running}
        title={
          running
            ? "Scrape workflow is running…"
            : coolingDown
              ? "A scrape ran recently — try again shortly"
              : "Run the scraper (GitHub Actions) and refresh when it finishes"
        }
      >
        {label}
      </button>
      {phase === "error" && errorMsg && (
        <span className="scrape-trigger__error" role="alert">
          {errorMsg}
          {runUrl && (
            <>
              {" "}
              <a href={runUrl} target="_blank" rel="noreferrer noopener">
                view run
              </a>
            </>
          )}
        </span>
      )}
    </span>
  );
}

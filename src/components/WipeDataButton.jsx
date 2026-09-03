import { useCallback, useEffect, useRef, useState } from "react";

/**
 * "Wipe data" — a destructive, rarely-used admin action next to "Run scrape
 * now": permanently deletes every row in `listings` + `price_history` (not
 * `geocode_cache` — see api/wipe-data.js). A click doesn't wipe anything by
 * itself; it reveals a password field, and only submitting that (matching
 * SITE_PASSWORD, checked server-side) actually deletes. That's a deliberate
 * second confirmation on top of the site-gate cookie every request already
 * carries, so a stray click can't take out the database.
 */
export default function WipeDataButton({ onWiped }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | loading | done | error
  const [errorMsg, setErrorMsg] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const openConfirm = useCallback(() => {
    setOpen(true);
    setPassword("");
    setPhase("idle");
    setErrorMsg("");
  }, []);

  const cancel = useCallback(() => {
    setOpen(false);
    setPassword("");
    setPhase("idle");
    setErrorMsg("");
  }, []);

  const confirmWipe = useCallback(
    async (event) => {
      event.preventDefault();
      if (!password || phase === "loading" || phase === "done") return;
      setPhase("loading");
      setErrorMsg("");
      try {
        const res = await fetch("/api/wipe-data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(body.error || `Request failed (${res.status})`);
        }
        setPhase("done");
        setPassword("");
        onWiped?.();
        setTimeout(() => setOpen(false), 1200);
      } catch (err) {
        setPhase("error");
        setErrorMsg(err.message || "Wipe failed");
      }
    },
    [password, phase, onWiped],
  );

  if (!open) {
    return (
      <button
        type="button"
        className="btn-danger btn-danger--sm"
        onClick={openConfirm}
        title="Permanently delete every listing (not the geocode cache) — asks for the site password first"
      >
        Wipe data
      </button>
    );
  }

  return (
    <form className="wipe-confirm" onSubmit={confirmWipe}>
      <input
        ref={inputRef}
        type="password"
        className="wipe-confirm__input"
        placeholder="Site password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        disabled={phase === "loading" || phase === "done"}
        autoComplete="off"
        aria-label="Site password, to confirm the wipe"
      />
      <button
        type="submit"
        className="btn-danger btn-danger--sm"
        disabled={!password || phase === "loading" || phase === "done"}
      >
        {phase === "loading" ? "Wiping…" : phase === "done" ? "Wiped ✓" : "Confirm wipe"}
      </button>
      <button
        type="button"
        className="wipe-confirm__cancel"
        onClick={cancel}
        disabled={phase === "loading"}
      >
        Cancel
      </button>
      {phase === "error" && errorMsg && (
        <span className="wipe-confirm__error" role="alert">
          {errorMsg}
        </span>
      )}
    </form>
  );
}

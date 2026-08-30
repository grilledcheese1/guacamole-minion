import { PRICE_MAX, PRICE_MIN, PRICE_STEP } from "../lib/filters.js";

/**
 * Dual-thumb range slider. `value` is [low, high] in dollars; `onChange` gets a
 * new [low, high] with the thumbs kept at least one step apart. Both native
 * range inputs overlap one track — only the thumbs are interactive (see
 * .range-dual CSS), and clamping stops them crossing.
 */
export default function PriceRangeSlider({ value, onChange }) {
  const [low, high] = value;
  const span = PRICE_MAX - PRICE_MIN;
  const pct = (v) => ((v - PRICE_MIN) / span) * 100;

  return (
    <div className="range-dual">
      <div className="range-dual__rail" />
      <div
        className="range-dual__fill"
        style={{ left: `${pct(low)}%`, right: `${100 - pct(high)}%` }}
      />
      <input
        type="range"
        className="range-dual__input"
        min={PRICE_MIN}
        max={PRICE_MAX}
        step={PRICE_STEP}
        value={low}
        aria-label="Minimum rent"
        onChange={(event) =>
          onChange([
            Math.min(Number(event.target.value), high - PRICE_STEP),
            high,
          ])
        }
      />
      <input
        type="range"
        className="range-dual__input"
        min={PRICE_MIN}
        max={PRICE_MAX}
        step={PRICE_STEP}
        value={high}
        aria-label="Maximum rent"
        onChange={(event) =>
          onChange([
            low,
            Math.max(Number(event.target.value), low + PRICE_STEP),
          ])
        }
      />
    </div>
  );
}

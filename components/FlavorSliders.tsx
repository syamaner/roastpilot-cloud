"use client";

import {
  FLAVOR_KEYS,
  type FlavorKey,
  type FlavorValues,
} from "./review-form-logic";

interface FlavorSlidersProps {
  values: FlavorValues;
  onChange: (key: FlavorKey, value: number | null) => void;
}

const LABELS: Record<FlavorKey, string> = {
  aroma: "Aroma",
  acidity: "Acidity",
  sweetness: "Sweetness",
  body: "Body",
  aftertaste: "Aftertaste",
};

export function FlavorSliders({ values, onChange }: FlavorSlidersProps) {
  return (
    <fieldset className="rounded-card border border-border bg-surface p-6 shadow-lg">
      <legend className="px-2 text-lg font-semibold text-foreground">
        Flavor ratings (optional)
      </legend>
      <div className="space-y-5">
        {FLAVOR_KEYS.map((key) => {
          const value = values[key];
          const label = LABELS[key];
          return (
            <div className="space-y-2" key={key}>
              <div className="flex items-center justify-between gap-3">
                <label className="min-w-0 flex-1 font-medium text-foreground">
                  {label}
                  <input
                    className="mt-2 block h-2 w-full cursor-pointer appearance-none rounded-full bg-foreground-muted accent-primary-strong focus:outline-none focus:ring-2 focus:ring-primary-strong focus:ring-offset-2 focus:ring-offset-surface [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-surface [&::-moz-range-thumb]:bg-primary-strong [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-surface [&::-webkit-slider-thumb]:bg-primary-strong"
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={value ?? 50}
                    aria-label={`${label} rating`}
                    aria-valuetext={value === null ? "Not rated" : String(value)}
                    onChange={(event) =>
                      onChange(key, Number(event.target.value))
                    }
                  />
                </label>
                <output className="shrink-0 text-sm font-medium text-foreground-muted">
                  {value === null ? "Not rated" : value}
                </output>
              </div>
              <button
                className="cursor-pointer border-0 bg-transparent p-0 text-sm font-medium text-foreground-muted underline-offset-4 hover:text-[var(--rp-primary-strong-hover)] hover:underline focus:outline-none focus:ring-2 focus:ring-primary-strong focus:ring-offset-2 focus:ring-offset-surface"
                type="button"
                onClick={() => onChange(key, null)}
              >
                Clear {label} (Not rated)
              </button>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

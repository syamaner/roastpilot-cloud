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
    <fieldset>
      <legend>Flavor ratings (optional)</legend>
      {FLAVOR_KEYS.map((key) => {
        const value = values[key];
        const label = LABELS[key];
        return (
          <div key={key}>
            <label>
              {label}
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={value ?? 50}
                aria-label={`${label} rating`}
                aria-valuetext={value === null ? "Not rated" : String(value)}
                onChange={(event) => onChange(key, Number(event.target.value))}
              />
            </label>
            <output>{value === null ? "Not rated" : value}</output>
            <button type="button" onClick={() => onChange(key, null)}>
              Clear {label} (Not rated)
            </button>
          </div>
        );
      })}
    </fieldset>
  );
}

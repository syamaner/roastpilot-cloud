"use client";

import { useRef, type KeyboardEvent } from "react";

interface StarRatingProps {
  value: number | null;
  onChange: (value: number) => void;
}

const RATINGS = [1, 2, 3, 4, 5] as const;

export function StarRating({ value, onChange }: StarRatingProps) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    rating: number,
  ) {
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = Math.min(5, rating + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = Math.max(1, rating - 1);
    } else if (event.key === "Home") {
      next = 1;
    } else if (event.key === "End") {
      next = 5;
    } else if (event.key === " " || event.key === "Enter") {
      next = rating;
    }

    if (next !== null) {
      event.preventDefault();
      buttonRefs.current[next - 1]?.focus();
      onChange(next);
    }
  }

  return (
    <div role="radiogroup" aria-label="Overall score" aria-required="true">
      {RATINGS.map((rating) => (
        <button
          ref={(button) => {
            buttonRefs.current[rating - 1] = button;
          }}
          key={rating}
          type="button"
          role="radio"
          aria-label={`${rating} out of 5 stars`}
          aria-checked={value === rating}
          tabIndex={value === rating || (value === null && rating === 1) ? 0 : -1}
          onClick={() => onChange(rating)}
          onKeyDown={(event) => handleKeyDown(event, rating)}
        >
          {rating} {rating === 1 ? "star" : "stars"}
        </button>
      ))}
    </div>
  );
}

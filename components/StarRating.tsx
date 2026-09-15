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
    <div
      className="flex max-w-full justify-center gap-1 sm:gap-2"
      role="radiogroup"
      aria-label="Overall score"
      aria-required="true"
    >
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
          className={`min-w-0 cursor-pointer border-0 bg-transparent p-1 text-3xl leading-none transition-transform hover:scale-110 focus:outline-none focus:ring-2 focus:ring-primary-strong focus:ring-offset-2 focus:ring-offset-surface sm:text-4xl ${
            value !== null && rating <= value
              ? "text-primary-strong"
              : "text-foreground-muted"
          }`}
        >
          <span aria-hidden="true">
            {value !== null && rating <= value ? "★" : "☆"}
          </span>
        </button>
      ))}
    </div>
  );
}
